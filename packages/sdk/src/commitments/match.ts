/**
 * `commitments.match(hash, opts)` — convenience wrapper that runs
 * `prepareMatch` then `matchFromPreview` in one call. Returns the
 * `MatchResult` (txHash + receipt + computed amounts).
 *
 * The split exists for the CLI and agents that need a confirmation
 * gate between resolution and signing — they import `prepareMatch`
 * and `matchFromPreview` directly. This wrapper is for callers who
 * just want to take the commitment and don't need the preview block
 * surfaced to the user.
 *
 * `matchFromPreview` ALWAYS re-fetches before sending — even invoked
 * milliseconds after `prepareMatch`. The redundant API + chain reads
 * are the cost of safety; agents wanting to avoid them must hold the
 * preview locally and only re-fetch when they choose to.
 */

import type { Hash, TransactionReceipt } from 'viem';
import { prepareMatch } from './prepareMatch.js';
import { matchFromPreview } from './matchFromPreview.js';
import type { CommitmentsContext } from './context.js';
import type { Commitment } from '../types/commitment.js';
import type { Hex } from '../types/signer.js';

export interface MatchArgs {
  /**
   * Optional override of the taker's desired risk (USDC, 6 decimals).
   * Defaults to the commitment's full remaining capacity. Clamped to
   * `commitment.remainingRiskAmount`. Zero is rejected as a validation
   * error.
   */
  takerDesiredRisk?: bigint;
}

export interface MatchResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  /** What the contract math says the taker actually risks. */
  takerRisk: bigint;
  /** What the contract math says the maker side fills (post lot-size rounding). */
  fillMakerRisk: bigint;
  /** The fresh commitment row (post-revalidation). */
  commitment: Commitment;
}

export async function match(
  ctx: CommitmentsContext,
  hash: Hex,
  opts: MatchArgs = {},
): Promise<MatchResult> {
  const prepArgs: Parameters<typeof prepareMatch>[1] = { hash };
  if (opts.takerDesiredRisk !== undefined) {
    prepArgs.takerDesiredRiskWei6 = opts.takerDesiredRisk;
  }
  const preview = await prepareMatch(ctx, prepArgs);
  return matchFromPreview(ctx, preview);
}
