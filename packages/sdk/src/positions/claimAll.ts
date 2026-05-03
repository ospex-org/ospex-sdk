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
 * Address ↔ signer coupling:
 *   - Live mode (default): `address` MUST match the configured signer's
 *     address. `claimPosition` runs as `msg.sender` on-chain, so a plan
 *     for any other wallet would either revert (signer doesn't hold the
 *     positions) or — worse — silently sweep an unrelated position that
 *     happens to share `(speculationId, signer, positionType)`. The SDK
 *     throws `OspexValidationError` up front rather than letting that
 *     happen. Omit `address` to default it to the signer.
 *   - Dry-run mode: `address` may be any wallet — no on-chain work
 *     happens, the call is read-only.
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
  /**
   * Wallet to sweep. Defaults to the configured signer's address when
   * omitted. In live mode the value MUST equal the signer's address —
   * an explicit non-matching value throws `OspexValidationError`. In
   * dry-run mode any wallet is permitted (the call is read-only).
   */
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

  // Validate the explicit address first, regardless of mode — a
  // malformed value is wrong in either case.
  let explicitAddress: string | undefined;
  if (args.address !== undefined) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(args.address)) {
      throw new OspexValidationError('Invalid Ethereum address.', { field: 'address' });
    }
    explicitAddress = args.address.toLowerCase();
  }

  let address: string;
  if (!dryRun) {
    // Live mode: a signer is mandatory because the on-chain
    // `claimPosition(speculationId, positionType)` runs as `msg.sender`.
    // Sweeping a plan for any wallet other than the signer is a footgun:
    // either the signer doesn't hold those positions and every tx
    // reverts (gas wasted), or — worse — the signer happens to hold a
    // matching `(speculationId, positionType)` and we silently sweep
    // an unrelated position under the wrong description. So in live
    // mode we require an explicit address to match the signer, or we
    // derive the address from the signer.
    const signer = ctx.requireSigner();
    const signerAddr = (await signer.getAddress()).toLowerCase();
    if (explicitAddress === undefined) {
      address = signerAddr;
    } else if (explicitAddress !== signerAddr) {
      throw new OspexValidationError(
        `claimAll: address ${explicitAddress} does not match the configured signer ${signerAddr}. ` +
          `claimPosition runs as the signer on-chain — sweeping another wallet's plan would either ` +
          `revert or claim something unrelated. Either omit the address (defaults to the signer) or ` +
          `use the dry-run path to inspect another wallet's plan read-only.`,
        { field: 'address' },
      );
    } else {
      address = explicitAddress;
    }
  } else if (explicitAddress !== undefined) {
    // Dry-run, explicit address: read-only, any wallet is fine.
    address = explicitAddress;
  } else {
    // Dry-run, no explicit address: derive from signer; surface a
    // clearer error if neither was provided.
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
      // so the caller can render the plan. Aggregate into the total
      // too — otherwise the dry-run summary reports $0.00 while every
      // entry shows a non-zero predicted payout.
      entryResult.success = true;
      entryResult.payoutWei6 = entry.estimatedPayoutWei6;
      entryResult.payoutUSDC = entry.estimatedPayoutUSDC;
      totalPayoutWei6 += BigInt(entry.estimatedPayoutWei6);
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
