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
 *   6. POST /v1/commitments with `Idempotency-Key: <hash>` header
 *   7. On NONCE_TOO_LOW, refetch floor and retry once
 */

import { OspexAPIError, OspexValidationError } from '../errors.js';
import {
  buildDomain,
  CANCEL_COMMITMENT_TYPES,
  hashCommitment,
  OSPEX_COMMITMENT_TYPES,
  deriveSpeculationKey,
  type OspexCommitmentMessage,
} from '../chain/eip712.js';
import { toCommitment } from '../api/commitments.js';
import { assertSufficientAllowance } from './allowance.js';
import { readNonceFloor } from './nonce.js';
import {
  validateExpiry,
  validateLineTicks,
  validateOdds,
  validatePositionType,
  validateRiskAmount,
  nowUnixSec,
} from './validation.js';
import type { CommitmentsContext } from './context.js';
import type { Commitment } from '../types/commitment.js';
import type { CommitmentBody } from '../api/types.js';
import type { Hex } from '../types/signer.js';

// CANCEL_COMMITMENT_TYPES is referenced via module-side imports for test
// reachability — silence the unused-import lint if any.
void CANCEL_COMMITMENT_TYPES;

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
}

export interface SubmitResult {
  hash: Hex;
  commitment: Commitment;
}

const DEFAULT_EXPIRY_OFFSET_SEC = 24n * 60n * 60n;

export async function submitRaw(
  ctx: CommitmentsContext,
  args: RawSubmitArgs,
): Promise<SubmitResult> {
  validateLineTicks(args.lineTicks);
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
  const post = async (msg: OspexCommitmentMessage, sig: Hex, hashHex: Hex): Promise<Commitment> => {
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
    return toCommitment(body);
  };

  ctx.nonceCounter.observe(maker, speculationKey, nonce);
  try {
    const stored = await post(message, signature, hash);
    return { hash, commitment: stored };
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
      return { hash: retryHash, commitment: stored };
    }
    throw err;
  }
}
