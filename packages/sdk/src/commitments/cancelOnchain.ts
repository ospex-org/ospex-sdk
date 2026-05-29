/**
 * On-chain cancel primitives.
 *
 * Two entry points:
 *
 *   1. `cancelOnchainSigned(payload)` — canonical low-level primitive.
 *      Takes a {@link SignedCommitmentPayload} (the three pieces a third
 *      party needs: commitmentHash, the 9-field struct that hashes back to
 *      it, and the maker's signature). Calls
 *      `MatchingModule.cancelCommitment(commitment)` on chain. This is the
 *      MM-aligned shape: a market maker holding signed payloads in local
 *      state can cancel without ever hitting the API — load-bearing once
 *      book-hide is in play, because the public commitments path redacts
 *      the matchable payload for hidden rows.
 *
 *   2. `cancelOnchain({ hash } | { signedCommitment })` — convenience
 *      overload. The signedCommitment branch is a thin pass-through to
 *      `cancelOnchainSigned`. The hash branch fetches via
 *      `CommitmentsApi.get` → `toCommitment` → `requireVisibleCommitment`
 *      (M5/PR1 narrow: throws structured before any signer / RPC / gas
 *      access if the row is redacted), reconstructs the
 *      SignedCommitmentPayload from the visible row, then delegates to
 *      `cancelOnchainSigned`. Anonymous callers default to this branch;
 *      makers / MMs holding the signed payload should prefer the
 *      signedCommitment branch (one round-trip cheaper, no dependency on
 *      `book_visible`).
 *
 * Authoritative semantics are the same as before: once
 * `s_cancelledCommitments[hash]` is set, `matchCommitment` reverts with
 * `MatchingModule__CommitmentCancelled` (MatchingModule.sol:490). The
 * off-chain DELETE only stops the API relay from rebroadcasting — it
 * does NOT prevent a taker who already holds the signed payload from
 * matching the commitment.
 *
 * **Reconstruct-and-assert is non-negotiable.** The contract recomputes
 * the hash from the struct and sets `s_cancelledCommitments[recomputed]`
 * BLINDLY. If the stored row ever drifts from the signed payload (an
 * `expiry` that doesn't round-trip to the exact unix second, a corrupted
 * scorer address), an unguarded cancel would mark a DIFFERENT hash
 * cancelled while the real commitment stays matchable — and a maker bot
 * would release its headroom on a phantom cancel. Both entry points
 * route through the same `assertReconstructHash` gate.
 *
 * Idempotency note: the contract has NO `AlreadyCancelled` revert path.
 * Calling either primitive on a hash that is already cancelled succeeds
 * — it rewrites `s_cancelledCommitments[hash] = true` and re-emits the
 * `CommitmentCancelled` event. Do not infer "first cancel" from tx
 * success.
 */

import {
  encodeFunctionData,
  type Hash,
  type TransactionReceipt,
} from 'viem';
import { matchingModuleAbi } from '../contracts/abi/index.js';
import { OspexValidationError } from '../errors.js';
import { buildDomain, hashCommitment, type OspexCommitmentMessage } from '../chain/eip712.js';
import type { ChainId } from '../types/protocol.js';
import { buildSignAndSend } from './sendTx.js';
import { sendWithMatchingErrorClassification } from './matchingErrors.js';
import { requireVisibleCommitment } from './requireVisible.js';
import { CommitmentsApi } from '../api/commitments.js';
import type { CommitmentsContext } from './context.js';
import type { PublicVisibleCommitment, SignedCommitmentPayload } from '../types/commitment.js';
import type { Hex } from '../types/signer.js';

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
// EIP-712 signature is `r || s || v` = 65 bytes = 130 hex chars after the prefix.
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface CancelOnchainResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  commitmentHash: Hex;
}

/**
 * `cancelOnchain({ hash } | { signedCommitment })` — the convenience
 * overload. Use `{ signedCommitment }` when you already hold the signed
 * payload (one round-trip cheaper; works against book-hidden rows). Use
 * `{ hash }` when you only have the EIP-712 hash and the row is on the
 * public book.
 *
 * The two branches are mutually exclusive — passing both throws
 * `OspexValidationError`. Passing neither throws too (defensive — the
 * type system already requires one).
 */
export type CancelOnchainArgs =
  | { hash: Hex; signedCommitment?: undefined }
  | { hash?: undefined; signedCommitment: SignedCommitmentPayload };

export async function cancelOnchain(
  ctx: CommitmentsContext,
  args: CancelOnchainArgs,
): Promise<CancelOnchainResult> {
  const hash = args.hash;
  const signedCommitment = args.signedCommitment;
  if (hash !== undefined && signedCommitment !== undefined) {
    throw new OspexValidationError(
      'cancelOnchain: pass either { hash } or { signedCommitment }, not both.',
      { field: 'hash' },
    );
  }
  if (hash === undefined && signedCommitment === undefined) {
    throw new OspexValidationError(
      'cancelOnchain: one of { hash } or { signedCommitment } is required.',
      { field: 'hash' },
    );
  }

  if (signedCommitment !== undefined) {
    return cancelOnchainSigned(ctx, signedCommitment);
  }

  // hash branch — fetch via decoder + narrow before any signer / RPC work.
  if (!HASH_PATTERN.test(hash as Hex)) {
    throw new OspexValidationError(
      'cancelOnchain hash must be a 0x-prefixed 32-byte hex string.',
      { field: 'hash' },
    );
  }
  const lowercaseHash = (hash as Hex).toLowerCase() as Hex;

  // Routes through `CommitmentsApi.get` → `toCommitment` so the M2 wire
  // `redacted` discriminant is decoded. A hidden public body has no
  // signature / nonce / oddsTick / riskAmount / scorer / lineTicks (the
  // public allow-list excludes everything `cancelCommitment`'s struct
  // needs) — narrow BEFORE any signer / chain-client / addresses access so
  // a redacted row never reaches the BigInt() conversions (which would
  // TypeError on undefined) and never spends a Foundry-passphrase decrypt
  // on a request that's about to fail. Makers with the signed payload in
  // local state should bypass this by passing `{ signedCommitment }`.
  const fetched = await new CommitmentsApi(ctx.api).get(lowercaseHash);
  const visible = requireVisibleCommitment(fetched, { purpose: 'cancel on chain' });
  const payload = buildPayloadFromVisible(visible, lowercaseHash);

  return cancelOnchainSigned(ctx, payload);
}

/**
 * `cancelOnchainSigned(payload)` — canonical low-level primitive. Validates
 * the payload shape, asserts hash↔struct round-trip, and broadcasts
 * `MatchingModule.cancelCommitment(commitment)`.
 *
 * Skips ALL public-commitments-API access — the maker / MM caller already
 * holds the signed payload. That's the load-bearing path for book-hidden
 * commitments: the anonymous public read returns a redacted body that
 * cannot reconstruct the cancel struct, but the maker's local state
 * (M6 `MakerCommitmentRecord.signedPayload`) can.
 */
export async function cancelOnchainSigned(
  ctx: CommitmentsContext,
  payload: SignedCommitmentPayload,
): Promise<CancelOnchainResult> {
  validateSignedPayload(payload);
  const lowercaseHash = payload.commitmentHash.toLowerCase() as Hex;

  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const { matchingModule } = ctx.getAddresses();
  const chainId = ctx.getChainId();

  // Assert the struct round-trips to the requested hash BEFORE signing or
  // broadcasting. The contract recomputes the hash from the struct
  // blindly (MatchingModule.sol). An unguarded cancel on a drifted struct
  // would mark a DIFFERENT hash cancelled while the real commitment
  // stays matchable. Both hashes are public; the message carries no
  // secrets.
  assertReconstructHash(payload.commitment, lowercaseHash, chainId, matchingModule as Hex);

  const data = encodeFunctionData({
    abi: matchingModuleAbi,
    functionName: 'cancelCommitment',
    args: [payload.commitment],
  });

  const { txHash, receipt } = await sendWithMatchingErrorClassification(
    'cancelCommitment',
    () =>
      buildSignAndSend({
        publicClient,
        signer,
        chainId,
        to: matchingModule,
        data,
      }),
  );

  return { txHash, receipt, commitmentHash: lowercaseHash };
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Reconstruct the 9-field EIP-712 struct from a {@link PublicVisibleCommitment}.
 * Indexer-only rows can have nulls in fields the contract requires — those
 * fail fast with a clear error rather than hitting a silent revert / BigInt
 * NaN further down the pipeline.
 */
function buildPayloadFromVisible(
  visible: PublicVisibleCommitment,
  lowercaseHash: Hex,
): SignedCommitmentPayload {
  const required = (
    [
      'contestId',
      'scorer',
      'lineTicks',
      'positionType',
      'oddsTick',
      'expiry',
    ] as const
  ).filter((k) => visible[k] === null);
  if (required.length > 0) {
    const first = required[0];
    throw new OspexValidationError(
      `Commitment ${lowercaseHash} is missing fields needed to reconstruct the struct: ${required.join(
        ', ',
      )}.`,
      first !== undefined ? { field: first } : undefined,
    );
  }
  if (visible.signature === null) {
    throw new OspexValidationError(
      `Commitment ${lowercaseHash} has no signature field; the row is not reconstructable into the EIP-712 struct.`,
      { field: 'signature' },
    );
  }

  const commitment: OspexCommitmentMessage = {
    maker: visible.maker as Hex,
    contestId: BigInt(visible.contestId as string),
    scorer: visible.scorer as Hex,
    lineTicks: visible.lineTicks as number,
    positionType: visible.positionType as 0 | 1,
    oddsTick: visible.oddsTick as number,
    riskAmount: BigInt(visible.riskAmount),
    nonce: BigInt(visible.nonce),
    expiry: BigInt(Math.floor(new Date(visible.expiry as string).getTime() / 1000)),
  };
  return {
    commitmentHash: lowercaseHash,
    commitment,
    signature: visible.signature as Hex,
  };
}

/**
 * Shape-only validation of a caller-supplied {@link SignedCommitmentPayload}.
 * `cancelOnchainSigned` is a public surface; a malformed payload from a
 * dynamic caller must surface as `OspexValidationError({ field })` rather
 * than a downstream TypeError or contract revert. Hash↔struct round-trip is
 * validated separately by `assertReconstructHash` (it needs the chain
 * domain, which validation alone doesn't have).
 */
function validateSignedPayload(payload: SignedCommitmentPayload): void {
  if (payload === null || typeof payload !== 'object') {
    throw new OspexValidationError(
      'cancelOnchainSigned payload must be a SignedCommitmentPayload object.',
      { field: 'signedCommitment' },
    );
  }
  if (typeof payload.commitmentHash !== 'string' || !HASH_PATTERN.test(payload.commitmentHash)) {
    throw new OspexValidationError(
      'cancelOnchainSigned commitmentHash must be a 0x-prefixed 32-byte hex string.',
      { field: 'commitmentHash' },
    );
  }
  if (typeof payload.signature !== 'string' || !SIGNATURE_PATTERN.test(payload.signature)) {
    throw new OspexValidationError(
      'cancelOnchainSigned signature must be a 0x-prefixed 65-byte hex string (r || s || v).',
      { field: 'signature' },
    );
  }
  const c = payload.commitment;
  if (c === null || typeof c !== 'object') {
    throw new OspexValidationError(
      'cancelOnchainSigned commitment must be a 9-field OspexCommitmentMessage struct.',
      { field: 'commitment' },
    );
  }
  if (typeof c.maker !== 'string' || !ADDRESS_PATTERN.test(c.maker)) {
    throw new OspexValidationError(
      'cancelOnchainSigned commitment.maker must be a 0x-prefixed 20-byte address.',
      { field: 'maker' },
    );
  }
  if (typeof c.scorer !== 'string' || !ADDRESS_PATTERN.test(c.scorer)) {
    throw new OspexValidationError(
      'cancelOnchainSigned commitment.scorer must be a 0x-prefixed 20-byte address.',
      { field: 'scorer' },
    );
  }
  // BigInt + number fields — narrow the shape but trust the values; the
  // hash assertion catches struct-level drift downstream.
  for (const k of ['contestId', 'riskAmount', 'nonce', 'expiry'] as const) {
    if (typeof c[k] !== 'bigint') {
      throw new OspexValidationError(
        `cancelOnchainSigned commitment.${k} must be a bigint.`,
        { field: k },
      );
    }
  }
  for (const k of ['lineTicks', 'positionType', 'oddsTick'] as const) {
    if (typeof c[k] !== 'number' || !Number.isFinite(c[k])) {
      throw new OspexValidationError(
        `cancelOnchainSigned commitment.${k} must be a finite number.`,
        { field: k },
      );
    }
  }
}

/**
 * Reconstruct the EIP-712 hash from the struct under the configured chain's
 * MatchingModule domain and assert it matches the requested `commitmentHash`.
 * Routed through {@link hashCommitment} so the algorithm matches what the
 * contract's `getCommitmentHash` returns. Mismatch is a hard-fail BEFORE
 * any tx is built — see file-level header for the rationale.
 */
function assertReconstructHash(
  commitment: OspexCommitmentMessage,
  lowercaseHash: Hex,
  chainId: ChainId,
  matchingModule: Hex,
): void {
  const reconstructed = hashCommitment(buildDomain(chainId, matchingModule), commitment);
  if (reconstructed.toLowerCase() !== lowercaseHash) {
    throw new OspexValidationError(
      `cancelOnchain: the provided commitment struct hashes to ${reconstructed}, ` +
        `which does not match commitmentHash ${lowercaseHash}. Refusing to cancel a different commitment.`,
      { field: 'commitmentHash' },
    );
  }
}
