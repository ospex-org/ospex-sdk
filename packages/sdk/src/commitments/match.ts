/**
 * `commitments.match(hash, opts)` — fetch a maker's commitment by hash
 * and call MatchingModule.matchCommitment as the taker.
 *
 * Pipeline:
 *   1. GET /v1/commitments/:hash → 404 → OspexAPIError
 *   2. Validate row has signature + all required fields
 *   3. Resolve takerDesiredRisk (caller override or remaining capacity)
 *   4. Compute the actual takerRisk for that fill (mirror of contract math)
 *   5. eth_call USDC.allowance(taker, PositionModule) — sized to actual outlay
 *   6. Reconstruct OspexCommitment struct, build calldata, send tx
 */

import { encodeFunctionData, type Hash, type TransactionReceipt } from 'viem';
import { matchingModuleAbi } from '../contracts/abi/index.js';
import { OspexValidationError } from '../errors.js';
import { toCommitment } from '../api/commitments.js';
import { assertSufficientAllowance } from './allowance.js';
import { buildSignAndSend } from './sendTx.js';
import type { CommitmentsContext } from './context.js';
import type { Commitment } from '../types/commitment.js';
import type { CommitmentBody } from '../api/types.js';
import type { Hex } from '../types/signer.js';

export interface MatchArgs {
  /**
   * Optional override of the taker's desired risk (USDC, 6 decimals).
   * Defaults to the commitment's full remaining capacity. Clamped to
   * `commitment.remainingRiskAmount`. Zero is rejected as a validation
   * error (the contract reverts on zero anyway).
   */
  takerDesiredRisk?: bigint;
}

export interface MatchResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  /** What the contract math said the taker actually risks. */
  takerRisk: bigint;
  /** What the contract math said the maker side fills (post lot-size rounding). */
  fillMakerRisk: bigint;
  commitment: Commitment;
}

const ODDS_SCALE = 100n;

export async function match(
  ctx: CommitmentsContext,
  hash: Hex,
  opts: MatchArgs = {},
): Promise<MatchResult> {
  // 1. Fetch the maker commitment by hash.
  const commitment = await ctx.api.request<CommitmentBody>(
    `/v1/commitments/${hash.toLowerCase()}`,
  );

  // 2. Structural validation — server returns null fields for indexer-
  // only rows that haven't been enriched with a signature yet.
  const required = (
    [
      'signature',
      'contestId',
      'scorer',
      'lineTicks',
      'positionType',
      'oddsTick',
      'expiry',
    ] as const
  ).filter((k) => commitment[k] === null);
  if (required.length > 0) {
    const first = required[0];
    throw new OspexValidationError(
      `Commitment ${hash} is missing required fields for match: ${required.join(', ')}.`,
      first !== undefined ? { field: first } : undefined,
    );
  }

  const oddsTickN = BigInt(commitment.oddsTick as number);
  const remainingRisk = BigInt(commitment.remainingRiskAmount);
  if (remainingRisk === 0n) {
    throw new OspexValidationError(
      `Commitment ${hash} has no remaining capacity.`,
      { field: 'remainingRiskAmount' },
    );
  }

  // 3. Resolve takerDesiredRisk.
  let takerDesiredRisk: bigint;
  if (opts.takerDesiredRisk !== undefined) {
    if (opts.takerDesiredRisk <= 0n) {
      throw new OspexValidationError('takerDesiredRisk must be positive.', { field: 'takerDesiredRisk' });
    }
    takerDesiredRisk = opts.takerDesiredRisk;
  } else {
    // Default: bid for the entire remaining maker capacity. The
    // contract converts this into the equivalent taker risk; we
    // mirror the math below for the allowance check.
    const profitTicks = oddsTickN - ODDS_SCALE;
    takerDesiredRisk = (remainingRisk * profitTicks) / ODDS_SCALE;
    if (takerDesiredRisk === 0n) {
      throw new OspexValidationError(
        `Computed taker risk for full remaining fill is zero (oddsTick=${oddsTickN}, remaining=${remainingRisk}). Pass an explicit takerDesiredRisk.`,
        { field: 'takerDesiredRisk' },
      );
    }
  }

  // 4. Mirror MatchingModule.sol:260-272 to know the actual outlay
  // before the tx lands. The contract enforces revert-or-exact-fill,
  // so the allowance check needs to be against the value the contract
  // will actually transfer — not whatever the taker passed in.
  const profitTicks = oddsTickN - ODDS_SCALE;
  const rawFillMakerRisk =
    (takerDesiredRisk * ODDS_SCALE + profitTicks - 1n) / profitTicks;
  const fillMakerRisk = rawFillMakerRisk - (rawFillMakerRisk % ODDS_SCALE);
  if (fillMakerRisk === 0n || fillMakerRisk > remainingRisk) {
    throw new OspexValidationError(
      `Match would revert: fillMakerRisk=${fillMakerRisk} not in (0, remaining=${remainingRisk}]. Choose a different takerDesiredRisk.`,
      { field: 'takerDesiredRisk' },
    );
  }
  let takerRisk = (fillMakerRisk * profitTicks) / ODDS_SCALE;
  if (takerRisk > takerDesiredRisk) takerRisk = takerDesiredRisk;

  // 5. Allowance check against the actual outlay.
  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const { matchingModule, positionModule, usdc } = ctx.getAddresses();
  const chainId = ctx.getChainId();
  const taker = (await signer.getAddress()).toLowerCase() as Hex;
  await assertSufficientAllowance(publicClient, usdc, taker, positionModule, takerRisk);

  // 6. Build matchCommitment calldata. The struct's positionType is
  // a uint8 enum on chain; the API's `commitment.positionType` is
  // already 0|1.
  const data = encodeFunctionData({
    abi: matchingModuleAbi,
    functionName: 'matchCommitment',
    args: [
      {
        maker: commitment.maker as Hex,
        contestId: BigInt(commitment.contestId as string),
        scorer: commitment.scorer as Hex,
        lineTicks: commitment.lineTicks as number,
        positionType: commitment.positionType as number, // 0 | 1, encoded as uint8
        oddsTick: commitment.oddsTick as number,
        riskAmount: BigInt(commitment.riskAmount),
        nonce: BigInt(commitment.nonce),
        expiry: BigInt(Math.floor(new Date(commitment.expiry as string).getTime() / 1000)),
      },
      commitment.signature as Hex,
      takerDesiredRisk,
    ],
  });

  const { txHash, receipt } = await buildSignAndSend({
    publicClient,
    signer,
    chainId,
    to: matchingModule,
    data,
  });

  return { txHash, receipt, takerRisk, fillMakerRisk, commitment: toCommitment(commitment) };
}
