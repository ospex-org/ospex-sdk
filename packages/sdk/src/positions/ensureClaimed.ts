/**
 * `client.positions.ensurePositionClaimed({ speculationId, positionType })`
 * — the idempotent "make this claimed" path. The claim-side analog of
 * `ensureSpeculationSettled`.
 *
 * Unlike the strict `claim` primitive (which always sends a tx and throws
 * `PositionModule__AlreadyClaimed` if the position was already claimed),
 * this resolves to success whenever the position IS claimed — whether
 * this call claimed it, it was already claimed, or a concurrent caller /
 * a prior run claimed it. Agents, the MM auto-claim loop, and postgame
 * sweeps can call it without treating a benign already-claimed (core-API
 * `claimable` projection lag, a manual overlap, a rerun) as a failure.
 *
 * Resolution (a direct mirror of `ensureSettled.ts`):
 *   1. Pre-flight read `getPosition`. `claimed === true` → `alreadyClaimed`,
 *      no tx, no payout. (A failed read degrades gracefully — fall through
 *      to 2.)
 *   2. Send the strict claim → `claimed` (carries txHash/receipt + the
 *      authoritative `POSITION_CLAIMED` payout).
 *   3. Send reverted → re-read on-chain state. If the revert decoded to
 *      `AlreadyClaimed` OR the re-read shows `claimed === true`, a benign
 *      already-claimed won the race → `recovered`. A pre-send
 *      (`estimateGas`) revert broadcasts nothing; an inclusion-time revert
 *      DID broadcast a tx that reverted (gas spent) — its hash is preserved
 *      on `revertedTxHash` (+ best-effort `revertedReceipt`, so its gas can
 *      be accounted). Otherwise the revert is a genuine failure
 *      (`NotSettled`, `NoPayout`, RPC error, …) and propagates unchanged.
 *
 * The recover/abort decision in step 3 is driven by the authoritative
 * on-chain re-read, not by parsing the revert string — so it covers both
 * the pre-send (`estimateGas`) revert and an inclusion-time revert (whose
 * receipt carries no decoded selector). The decoded `AlreadyClaimed`
 * selector is a second, independent signal layered on top.
 *
 * IMPORTANT — no derived payout. `recovered` / `alreadyClaimed` carry NO
 * payout. The contract zeroes `riskAmount` / `profitAmount` once `claimed`
 * flips true, so an already-claimed position has no on-chain economic
 * fields to read back; the realized payout for such a position lives in
 * the original `POSITION_CLAIMED` event (or an API/indexer projection),
 * never in a post-claim `getPosition`. Only `claimed` surfaces a payout —
 * it's event-sourced.
 */

import { type Hash, type PublicClient, type TransactionReceipt } from 'viem';
import { OspexChainError, OspexValidationError } from '../errors.js';
import { claim } from './claim.js';
import { readPositionState } from './readPosition.js';
import { isAlreadyClaimedRevert } from './positionErrors.js';
import type { PositionsContext } from './context.js';
import type { Hex } from '../types/signer.js';

export interface EnsureClaimedArgs {
  speculationId: bigint;
  positionType: 0 | 1;
}

export type EnsureClaimedOutcome =
  /** This call sent the claim tx — payout is event-sourced. */
  | 'claimed'
  /** A pre-flight read found it already claimed; no tx, no payout. */
  | 'alreadyClaimed'
  /** A benign already-claimed won the race — the claim attempt reverted
   * but a re-read (or the decoded `AlreadyClaimed` selector) confirmed the
   * position is claimed. Carries `revertedTxHash` (+ `revertedReceipt`, so
   * its gas can be accounted) iff this wallet broadcast a tx that reverted
   * (inclusion-time loss); pre-send / pre-flight recovery broadcasts
   * nothing. No payout (not event-sourced — see file header). */
  | 'recovered';

export interface EnsureClaimedResult {
  speculationId: bigint;
  positionType: 0 | 1;
  outcome: EnsureClaimedOutcome;
  /** Event-sourced payout, present ONLY on `outcome === 'claimed'`. wei6
   * (USDC, 6 decimals). Deliberately absent on `alreadyClaimed` /
   * `recovered`: a benign already-claimed has no on-chain payout to read
   * (economic fields are zeroed post-claim), and the SDK never fabricates
   * one. */
  payoutWei6?: bigint;
  /** Convenience number in USDC; present only on `claimed`. Lossy for
   * sub-cent values — use `payoutWei6` for exact precision. */
  payoutUSDC?: number;
  /** The confirmed claim tx. Present only on `outcome === 'claimed'`. */
  txHash?: Hash;
  /** Present only on `outcome === 'claimed'`. */
  blockNumber?: bigint;
  /** Present only on `outcome === 'claimed'`. */
  receipt?: TransactionReceipt;
  /** Present only on `outcome === 'recovered'` AND only when this wallet
   * actually broadcast a claim tx that then reverted (an inclusion-time
   * race loss — gas was spent). Absent when recovery came via a pre-flight
   * read or a pre-send (`estimateGas`) revert, where no tx was sent. The
   * audit trail must not lose this hash. */
  revertedTxHash?: Hash;
  /** The receipt of the reverted claim tx (`revertedTxHash`), re-fetched
   * so consumers can account the gas it spent — a recovered inclusion-time
   * race still cost POL, and gas budgets must include it. Present whenever
   * `revertedTxHash` is set AND the receipt fetch succeeded; absent if the
   * fetch failed (the caller still has `revertedTxHash` to look up / flag
   * an accounting gap). Carries the usual `gasUsed` / `effectiveGasPrice`. */
  revertedReceipt?: TransactionReceipt;
}

export async function ensurePositionClaimed(
  ctx: PositionsContext,
  args: EnsureClaimedArgs,
): Promise<EnsureClaimedResult> {
  const { speculationId, positionType } = args;
  if (speculationId <= 0n) {
    throw new OspexValidationError('speculationId must be a positive bigint.', { field: 'speculationId' });
  }
  if (positionType !== 0 && positionType !== 1) {
    throw new OspexValidationError('positionType must be 0 (upper) or 1 (lower).', { field: 'positionType' });
  }

  // A signer + chain client are required to read the position (keyed by
  // the holder) and to claim. Surface a missing-rpcUrl / missing-signer
  // config error immediately rather than after a claim attempt.
  const publicClient = ctx.requireChainClient();
  const signer = ctx.requireSigner();
  const { positionModule } = ctx.getAddresses();
  const user = (await signer.getAddress()).toLowerCase() as Hex;

  // 1. Pre-flight: already claimed? Skip the tx entirely (no payout —
  //    the economic fields are zeroed once claimed).
  const pre = await tryReadPositionState(publicClient, positionModule, speculationId, user, positionType);
  if (pre?.claimed === true) {
    return { speculationId, positionType, outcome: 'alreadyClaimed' };
  }

  // 2. Attempt the strict claim.
  try {
    const r = await claim(ctx, { speculationId, positionType });
    return {
      speculationId,
      positionType,
      outcome: 'claimed',
      payoutWei6: r.payoutWei6,
      payoutUSDC: r.payoutUSDC,
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      receipt: r.receipt,
    };
  } catch (err) {
    // 3. Race recovery. Re-read authoritative state; recover ONLY if the
    //    position is claimed now, by either signal. `NotSettled` /
    //    `NoPayout` / RPC errors leave `claimed === false` and don't decode
    //    to AlreadyClaimed, so they propagate as genuine failures.
    const post = await tryReadPositionState(publicClient, positionModule, speculationId, user, positionType);
    if (isAlreadyClaimedRevert(err) || post?.claimed === true) {
      const recovered: EnsureClaimedResult = {
        speculationId,
        positionType,
        outcome: 'recovered',
      };
      // If this wallet actually broadcast a claim tx that reverted on
      // inclusion (lost the race), keep its hash AND re-fetch its receipt —
      // that tx spent POL, and consumers (e.g. the market-maker's daily gas
      // budget) must account for it even though it reverted. Pre-send /
      // pre-flight recoveries broadcast nothing, so there's no hash. The
      // receipt fetch is best-effort: on failure we still return the hash so
      // the caller can look it up or flag an accounting gap.
      const revertedTxHash = revertTxHashOf(err);
      if (revertedTxHash !== undefined) {
        recovered.revertedTxHash = revertedTxHash;
        try {
          recovered.revertedReceipt = await publicClient.getTransactionReceipt({ hash: revertedTxHash });
        } catch {
          // leave revertedReceipt undefined — revertedTxHash still surfaced
        }
      }
      return recovered;
    }
    // Genuine failure (not claimed, or couldn't confirm) — surface it.
    throw err;
  }
}

/** Pull a receipt-level revert tx hash off a caught error.
 * `broadcastSignedTx` throws `OspexChainError({ txHash })` for a reverted
 * receipt; pre-send (`estimateGas`) reverts carry no `txHash`. */
function revertTxHashOf(err: unknown): Hash | undefined {
  return err instanceof OspexChainError && err.txHash !== undefined
    ? (err.txHash as Hash)
    : undefined;
}

/** Read on-chain position state, returning `null` on any read error so a
 * flaky read never aborts the ensure flow (we fall back to the claim
 * attempt / the genuine revert). */
async function tryReadPositionState(
  publicClient: PublicClient,
  positionModule: Hex,
  speculationId: bigint,
  user: Hex,
  positionType: 0 | 1,
): Promise<Awaited<ReturnType<typeof readPositionState>> | null> {
  try {
    return await readPositionState(publicClient, positionModule, speculationId, user, positionType);
  } catch {
    return null;
  }
}
