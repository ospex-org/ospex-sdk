/**
 * `commitments.submitRaw(args)` — the protocol-level escape hatch. Sign
 * an EIP-712 OspexCommitment and POST it to the core API using the
 * literal `(contestId, scorer, lineTicks, positionType, oddsTick,
 * riskAmount)` tuple the contract takes. No resolver, no preview block.
 *
 * Most callers should reach for the high-level `commitments.submit`
 * which accepts domain-language inputs (`--side lakers --odds 2.50
 * --risk-usdc 1`) and renders an explicit win/lose/push preview before
 * signing. `submitRaw` is preserved for tests, debugging, and advanced
 * operators who already hold canonical protocol values.
 *
 * Pipeline:
 *   1. Validate inputs
 *   2. eth_call USDC.allowance — throw OspexAllowanceError if short
 *   3. eth_call MatchingModule.s_minNonces (canonical floor)
 *   4. Pick nonce per the SDK's strategy (or use override)
 *   5. Build typed data, sign via Signer, hash locally
 *   6. Run the optional synchronous `beforePost` precondition (throw → abort)
 *   7. POST /v1/commitments with `Idempotency-Key: <hash>` header
 *   8. On NONCE_TOO_LOW, refetch floor and retry once (re-running `beforePost`)
 */

import { OspexAPIError, OspexValidationError } from '../errors.js';
import {
  buildDomain,
  hashCommitment,
  OSPEX_COMMITMENT_TYPES,
  deriveSpeculationKey,
  type OspexCommitmentMessage,
} from '../chain/eip712.js';
import { toCommitment } from '../api/commitments.js';
import { requireVisibleCommitment } from './requireVisible.js';
import { assertSufficientAllowance } from './allowance.js';
import { readNonceFloor } from './nonce.js';
import {
  validateExpiry,
  validateCommitmentLineTicks,
  validateOdds,
  validatePositionType,
  validateRiskAmount,
  nowUnixSec,
} from './validation.js';
import type { CommitmentsContext } from './context.js';
import type { PublicVisibleCommitment, SignedCommitmentPayload } from '../types/commitment.js';
import type { CommitmentBody } from '../api/types.js';
import type { Hex } from '../types/signer.js';

/**
 * Canonical protocol-level submit args. The high-level
 * `submit(HighLevelSubmitArgs)` lives on the Commitments class
 * separately and orchestrates around this raw entry point.
 */
export interface RawSubmitArgs {
  contestId: bigint;
  scorer: Hex;
  lineTicks: number;
  positionType: 0 | 1;
  oddsTick: number;
  riskAmount: bigint;
  /**
   * Unix-seconds expiry. Defaults to now + 24 h. Must be in the future
   * and ≤ 1 year out (server will reject otherwise).
   */
  expiry?: bigint;
  /**
   * Override the SDK's nonce strategy. Useful for agents that need
   * cross-process monotonicity (Redis-backed counter, etc.). When
   * omitted, the SDK uses `max(floor, lastInProcess + 1, unixSec)`.
   */
  nonce?: bigint;
  /**
   * Optional SYNCHRONOUS precondition, re-checked by the SDK immediately before
   * the irreversible `POST /v1/commitments` — after `getAddress`, the allowance
   * read, the nonce-floor read, and signing have all completed. Throw to abort
   * WITHOUT posting; the thrown error propagates out of `submitRaw` unchanged.
   *
   * This is the just-in-time fail-closed seam for automated callers (e.g. a
   * market-maker) whose own go/no-go condition can change DURING those async
   * steps: a check at the call site is not sufficient, because state can flip
   * while the SDK awaits the chain reads and the signature. The hook runs on the
   * same synchronous tick as the POST (no `await` between it and the request), so
   * it closes that window.
   *
   * MUST be synchronous — an `async` hook would re-introduce a yield before the
   * POST and defeat the guarantee. The SDK ENFORCES this fail-closed: if the hook
   * returns a thenable, `submitRaw` throws
   * `OspexValidationError({ field: 'beforePost' })` WITHOUT posting, rather than
   * ignoring the Promise and posting (the `() => void` type accepts an `async`
   * function under TS's void-return rule, so the guard is the real boundary). The
   * misused thenable's eventual settlement is swallowed, so a rejecting async hook
   * can't surface as an `unhandledRejection` / crash the host process.
   * Called before BOTH the initial POST and the `NONCE_TOO_LOW` retry POST. By the
   * time it runs the nonce has been allocated and the payload signed, so aborting
   * simply leaves a (harmless) skipped nonce.
   */
  beforePost?: () => void;
}

export interface SubmitResult {
  hash: Hex;
  /**
   * The freshly-created row as decoded from the submit response. Always a
   * {@link PublicVisibleCommitment} — submission inserts a `book_visible=true`
   * row by construction, and the server response carries the full matchable
   * payload (the maker is the authoring caller).
   */
  commitment: PublicVisibleCommitment;
  /**
   * The canonical signed payload exactly as the SDK signed and broadcast it —
   * the three pieces a third party (or this same caller, later, holding only
   * local state) needs to act on the commitment without re-fetching it:
   * `commitmentHash`, the 9-field EIP-712 `OspexCommitmentMessage`, and the
   * `signature` over that struct. Surfaced so callers (notably market-makers)
   * can persist the canonical shape locally and feed
   * `commitments.cancelOnchainSigned(payload)` without round-tripping through
   * the public commitments API — important for book-hidden rows whose public
   * read is allow-list-projected (own-state SSE plan §M6).
   *
   * Equivalent in content to the fields of `commitment` (a
   * {@link PublicVisibleCommitment}) plus the locally-computed hash, but in
   * the canonical typed shape `cancelOnchainSigned` expects (bigint, not
   * decimal-string). Always present on the fresh-submit happy path; on a
   * `NONCE_TOO_LOW` retry, this is the retry's signed payload (the original
   * is discarded by design — no longer matches the persisted server row).
   */
  signedPayload: SignedCommitmentPayload;
}

const DEFAULT_EXPIRY_OFFSET_SEC = 24n * 60n * 60n;

export async function submitRaw(
  ctx: CommitmentsContext,
  args: RawSubmitArgs,
): Promise<SubmitResult> {
  validateCommitmentLineTicks(args.lineTicks);
  validatePositionType(args.positionType);
  validateOdds(args.oddsTick);
  validateRiskAmount(args.riskAmount);

  const expiry = args.expiry ?? nowUnixSec() + DEFAULT_EXPIRY_OFFSET_SEC;
  validateExpiry(expiry);

  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const { matchingModule, positionModule, usdc } = ctx.getAddresses();
  const chainId = ctx.getChainId();

  const maker = (await signer.getAddress()).toLowerCase() as Hex;
  const scorer = args.scorer.toLowerCase() as Hex;

  // 2. Maker allowance: required = riskAmount, spender = PositionModule.
  await assertSufficientAllowance(publicClient, usdc, maker, positionModule, args.riskAmount);

  // 3-4. Nonce floor + strategy.
  const speculationKey = deriveSpeculationKey(args.contestId, scorer, args.lineTicks);
  let nonce: bigint;
  if (args.nonce !== undefined) {
    if (args.nonce < 0n) {
      throw new OspexValidationError('nonce must be non-negative.', { field: 'nonce' });
    }
    nonce = args.nonce;
  } else {
    const floor = await readNonceFloor(publicClient, matchingModule, maker, speculationKey);
    nonce = ctx.nonceCounter.next(maker, speculationKey, floor, nowUnixSec());
  }

  // 5. Build typed data, sign, hash.
  const domain = buildDomain(chainId, matchingModule);
  const message: OspexCommitmentMessage = {
    maker,
    contestId: args.contestId,
    scorer,
    lineTicks: args.lineTicks,
    positionType: args.positionType,
    oddsTick: args.oddsTick,
    riskAmount: args.riskAmount,
    nonce,
    expiry,
  };
  const signature = await signer.signTypedData({
    domain,
    types: { ...OSPEX_COMMITMENT_TYPES },
    primaryType: 'OspexCommitment',
    message: { ...message },
  });
  const hash = hashCommitment(domain, message);

  // 6. POST /v1/commitments with idempotency-key header.
  // 7. On NONCE_TOO_LOW, refetch the floor and retry exactly once.
  const post = async (
    msg: OspexCommitmentMessage,
    sig: Hex,
    hashHex: Hex,
  ): Promise<PublicVisibleCommitment> => {
    // Just-in-time fail-closed precondition, run synchronously immediately before
    // the irreversible POST (no `await` in between). A sync throw aborts without
    // posting and propagates out of submitRaw; runs before the retry POST too.
    //
    // ENFORCE the synchronous contract at runtime: the `() => void` type accepts
    // an `async` function (TS's void-return rule) and JS / `as any` callers bypass
    // it entirely. An async hook CANNOT fail-close — it returns a pending Promise
    // the SDK would otherwise ignore and POST anyway (fail-OPEN; the hook might
    // reject only after the request is already in flight). So if the hook returns
    // a thenable, reject it BEFORE the POST rather than proceed.
    const verdict: unknown = (args.beforePost as undefined | (() => unknown))?.();
    if (verdict != null && typeof (verdict as { then?: unknown }).then === 'function') {
      // Swallow the misused promise's eventual settlement BEFORE throwing — a
      // rejecting async hook would otherwise surface as an `unhandledRejection`
      // and can crash the host process (fail-closed for the POST, but not safe
      // for the process). We refuse the submit regardless of how it settles, so
      // its outcome is discarded. `Promise.resolve(...)` normalizes any thenable.
      void Promise.resolve(verdict).catch(() => {});
      throw new OspexValidationError(
        'beforePost must be synchronous: it returned a thenable. An async precondition cannot fail-close before the POST — make it synchronous and throw to abort.',
        { field: 'beforePost' },
      );
    }
    const body = await ctx.api.request<CommitmentBody>('/v1/commitments', {
      method: 'POST',
      headers: { 'Idempotency-Key': hashHex },
      body: {
        action: {
          type: 'OspexCommitment',
          maker: msg.maker,
          contestId: msg.contestId.toString(),
          scorer: msg.scorer,
          lineTicks: msg.lineTicks,
          positionType: msg.positionType,
          oddsTick: msg.oddsTick,
          riskAmount: msg.riskAmount.toString(),
          nonce: msg.nonce.toString(),
          expiry: msg.expiry.toString(),
        },
        signature: sig,
      },
    });
    // Submission inserts `book_visible=true` by construction — the server
    // response must decode visible. Narrow defensively; a redacted response
    // here would be a server bug, not a normal flow.
    return requireVisibleCommitment(toCommitment(body), {
      purpose: 'persist the newly-submitted',
    });
  };

  ctx.nonceCounter.observe(maker, speculationKey, nonce);
  try {
    const stored = await post(message, signature, hash);
    return {
      hash,
      commitment: stored,
      signedPayload: { commitmentHash: hash, commitment: message, signature },
    };
  } catch (err) {
    if (err instanceof OspexAPIError && err.apiCode === 'NONCE_TOO_LOW') {
      const fresh = await readNonceFloor(publicClient, matchingModule, maker, speculationKey);
      const newNonce = ctx.nonceCounter.next(maker, speculationKey, fresh, nowUnixSec());
      const retryMessage: OspexCommitmentMessage = { ...message, nonce: newNonce };
      const retrySig = await signer.signTypedData({
        domain,
        types: { ...OSPEX_COMMITMENT_TYPES },
        primaryType: 'OspexCommitment',
        message: { ...retryMessage },
      });
      const retryHash = hashCommitment(domain, retryMessage);
      ctx.nonceCounter.observe(maker, speculationKey, newNonce);
      const stored = await post(retryMessage, retrySig, retryHash);
      return {
        hash: retryHash,
        commitment: stored,
        signedPayload: { commitmentHash: retryHash, commitment: retryMessage, signature: retrySig },
      };
    }
    throw err;
  }
}
