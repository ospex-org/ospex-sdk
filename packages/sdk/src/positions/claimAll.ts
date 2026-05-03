/**
 * `client.positions.claimAll({ address?, opts? })` — sweep every
 * settle+claim a wallet is owed in a single SDK call.
 *
 * Pipeline:
 *   1. Fetch /v1/positions/:address/claim-params from core-api.
 *      Each entry carries an ordered `txParams[]` array — claimable
 *      rows have a single `claimPosition` step; pendingSettle rows
 *      have `settleSpeculation` then `claimPosition`.
 *   2. For each entry, walk the steps in order. settle reverts halt
 *      THIS entry only; the loop moves on so one bad position can't
 *      block the rest.
 *   3. Aggregate per-entry success/failure into the result array.
 *
 * `opts.dryRun` skips all on-chain work and returns the action plan.
 *
 * On-chain batching: there is no `claimMultiple` / `batchClaim`
 * primitive on PositionModule. Each claim is its own tx. A future
 * Multicall3-based optimization is out of scope for M3 (deferred to
 * M3.5+ if there's demand).
 */

import { OspexChainError, OspexConfigError, OspexError, OspexValidationError } from '../errors.js';
import { claim, type ClaimResult } from './claim.js';
import { settleSpeculation, type SettleResult } from './settle.js';
import type { PositionsContext } from './context.js';
import type { ClaimParamEntry } from '../types/position.js';

export interface ClaimAllArgs {
  /** Defaults to `signer.getAddress()` if not specified. */
  address?: string;
  opts?: ClaimAllOptions;
}

export interface ClaimAllOptions {
  /** When true, fetch the action plan and return it without sending
   * any txs. Useful for CLI dry-runs and pre-flight UX. */
  dryRun?: boolean;
}

export interface ClaimAllEntryResult {
  positionId: string;
  speculationId: string;
  bucket: 'claimable' | 'pendingSettle';
  description: string;
  /** Whether the full pipeline (settle if needed, then claim)
   * succeeded for this entry. */
  success: boolean;
  /** All tx hashes in execution order. Empty when `dryRun` was set
   * or when the very first step failed before any tx was sent. */
  txHashes: string[];
  /** Populated when the claim step landed; absent on dry-run or
   * failure. */
  payoutWei6?: string;
  payoutUSDC?: number;
  /** Populated when the settle step ran. */
  winSide?: SettleResult['winSide'];
  /** Present when at least one step failed. The serialized error is
   * left to the consumer — the typed error is preserved here so a CLI
   * can still introspect `code`/`txHash`/etc. */
  error?: OspexError;
}

export interface ClaimAllResult {
  address: string;
  /** True if every step of every entry succeeded. False on any
   * failure or on dryRun. */
  success: boolean;
  entries: ClaimAllEntryResult[];
  totals: {
    claimed: number;
    failed: number;
    totalPayoutWei6: string;
    totalPayoutUSDC: number;
  };
}

export async function claimAll(
  ctx: PositionsContext,
  args: ClaimAllArgs = {},
): Promise<ClaimAllResult> {
  const dryRun = args.opts?.dryRun === true;

  let address: string;
  if (args.address !== undefined) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(args.address)) {
      throw new OspexValidationError('Invalid Ethereum address.', { field: 'address' });
    }
    address = args.address.toLowerCase();
  } else {
    // Default to the configured signer's address. claimAll without an
    // address only makes sense with a signer attached (claim() needs
    // one anyway).
    if (dryRun) {
      // Dry-run still wants an address — try the signer first, fall
      // back to a clear config error so the CLI can prompt.
      try {
        const signer = ctx.requireSigner();
        address = (await signer.getAddress()).toLowerCase();
      } catch (err) {
        if (err instanceof OspexConfigError) {
          throw new OspexConfigError(
            'claimAll dry-run requires either an explicit `address` or an attached signer.',
          );
        }
        throw err;
      }
    } else {
      const signer = ctx.requireSigner();
      address = (await signer.getAddress()).toLowerCase();
    }
  }

  const params = await ctx.positionsApi.claimParams(address);
  const entries: ClaimAllEntryResult[] = [];
  let totalPayoutWei6 = 0n;

  for (const entry of params.positions) {
    const entryResult: ClaimAllEntryResult = {
      positionId: entry.positionId,
      speculationId: entry.speculationId,
      bucket: entry.bucket,
      description: entry.description,
      success: false,
      txHashes: [],
    };

    if (dryRun) {
      // Pretend each step succeeds and surface the predicted payout
      // so the caller can render the plan.
      entryResult.success = true;
      entryResult.payoutWei6 = entry.estimatedPayoutWei6;
      entryResult.payoutUSDC = entry.estimatedPayoutUSDC;
      entries.push(entryResult);
      continue;
    }

    try {
      await runEntry(ctx, entry, entryResult);
      entryResult.success = true;
      if (entryResult.payoutWei6 !== undefined) {
        totalPayoutWei6 += BigInt(entryResult.payoutWei6);
      }
    } catch (err) {
      // Per spec: per-position errors don't abort the loop.
      entryResult.success = false;
      if (err instanceof OspexError) {
        entryResult.error = err;
      } else if (err instanceof Error) {
        entryResult.error = new OspexChainError(err.message, { cause: err });
      } else {
        entryResult.error = new OspexChainError('Unknown error during claimAll entry.');
      }
    }

    entries.push(entryResult);
  }

  const claimed = entries.filter((e) => e.success).length;
  const failed = entries.length - claimed;
  return {
    address,
    success: dryRun ? false : failed === 0 && entries.length > 0,
    entries,
    totals: {
      claimed,
      failed,
      totalPayoutWei6: totalPayoutWei6.toString(),
      totalPayoutUSDC: Number(totalPayoutWei6) / 1e6,
    },
  };
}

async function runEntry(
  ctx: PositionsContext,
  entry: ClaimParamEntry,
  result: ClaimAllEntryResult,
): Promise<void> {
  for (const step of entry.txParams) {
    if (step.method === 'settleSpeculation') {
      const r = await settleSpeculation(ctx, {
        speculationId: BigInt(step.args.speculationId),
      });
      result.txHashes.push(r.txHash);
      result.winSide = r.winSide;
    } else if (step.method === 'claimPosition') {
      const r = await claim(ctx, {
        speculationId: BigInt(step.args.speculationId),
        positionType: step.args.positionType,
      });
      result.txHashes.push(r.txHash);
      result.payoutWei6 = r.payoutWei6.toString();
      result.payoutUSDC = r.payoutUSDC;
    } else {
      // Unknown method — surface clearly. Keeps the SDK forward-
      // compatible: if core-api adds new step types in the future,
      // existing SDK versions fail loudly rather than silently.
      const stepRef = step as { method?: unknown };
      throw new OspexChainError(
        `claimAll: unrecognized txParams.method "${String(stepRef.method)}". SDK upgrade required.`,
      );
    }
  }
}
