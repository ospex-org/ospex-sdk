/**
 * `client.positions.ensureSpeculationSettled({ speculationId })` — the
 * idempotent "make this settled" path.
 *
 * Unlike the strict `settleSpeculation` primitive (which always sends a
 * tx and throws `AlreadySettled` if the speculation is already closed),
 * this resolves to success whenever the speculation IS settled — whether
 * this call settled it, it was already settled, or a concurrent caller
 * settled it mid-flight. Agents and multi-wallet postgame sweeps can call
 * it without treating projection lag (core-API still reporting
 * `pendingSettle` after the chain settled) as a failure.
 *
 * Resolution:
 *   1. Pre-flight read `getSpeculation`. Already closed → `alreadySettled`,
 *      no tx. (A failed read degrades gracefully — fall through to 2.)
 *   2. Send the strict settle → `settled` (carries txHash/receipt/winSide).
 *   3. Send reverted → re-read on-chain state. If the revert decoded to
 *      `AlreadySettled` OR the re-read shows the speculation is now closed,
 *      a concurrent settle won the race → `recovered`, no tx. Otherwise the
 *      revert is a genuine failure (`ContestNotFinalized`, `InvalidStartTime`,
 *      RPC error, …) and propagates unchanged.
 *
 * The recover/abort decision in step 3 is driven by the authoritative
 * on-chain re-read, not by parsing the revert string — so it covers both
 * the pre-send (`estimateGas`) revert and an inclusion-time revert (whose
 * receipt carries no decoded selector). The decoded selector is a second,
 * independent "already settled" signal layered on top.
 */

import { type Hash, type PublicClient, type TransactionReceipt } from 'viem';
import { OspexChainError } from '../errors.js';
import { settleSpeculation, type SettleResult } from './settle.js';
import { readSpeculationState } from './readSpeculation.js';
import { isAlreadySettledRevert } from './speculationErrors.js';
import type { PositionsContext } from './context.js';
import type { Hex } from '../types/signer.js';

export interface EnsureSettledArgs {
  speculationId: bigint;
}

export type EnsureSettledOutcome =
  /** This call sent the settle tx. */
  | 'settled'
  /** A pre-flight read found it already settled; no tx was sent. */
  | 'alreadySettled'
  /** A concurrent settle won the race; recovered after a reverted send. */
  | 'recovered';

export interface EnsureSettledResult {
  speculationId: bigint;
  outcome: EnsureSettledOutcome;
  /** Resolved winning side. From the settle event on `settled`; from the
   * on-chain read on `alreadySettled` / `recovered`. */
  winSide: SettleResult['winSide'];
  /** The confirmed settle tx. Present only on `outcome === 'settled'`. */
  txHash?: Hash;
  /** Present only on `outcome === 'settled'`. */
  blockNumber?: bigint;
  /** Present only on `outcome === 'settled'`. */
  receipt?: TransactionReceipt;
  /** Present only on `outcome === 'recovered'` AND only when this wallet
   * actually broadcast a settle tx that then reverted (an inclusion-time
   * race loss — gas was spent). Absent when recovery came via a pre-flight
   * read or a pre-send (`estimateGas`) revert, where no tx was sent. The
   * audit trail must not lose this hash. */
  revertedTxHash?: Hash;
}

export async function ensureSpeculationSettled(
  ctx: PositionsContext,
  args: EnsureSettledArgs,
): Promise<EnsureSettledResult> {
  const { speculationId } = args;
  if (speculationId <= 0n) {
    throw new OspexChainError('ensureSpeculationSettled: speculationId must be a positive bigint.');
  }

  // A chain client is required to read state (and to settle). Surface a
  // missing-rpcUrl config error immediately rather than after a settle
  // attempt.
  const publicClient = ctx.requireChainClient();
  const { speculationModule } = ctx.getAddresses();

  // 1. Pre-flight: already settled? Skip the tx entirely.
  const pre = await tryReadSpeculationState(publicClient, speculationModule, speculationId);
  if (pre?.status === 'closed') {
    return { speculationId, outcome: 'alreadySettled', winSide: pre.winSide };
  }

  // 2. Attempt the strict settle.
  try {
    const r = await settleSpeculation(ctx, { speculationId });
    return {
      speculationId,
      outcome: 'settled',
      winSide: r.winSide,
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      receipt: r.receipt,
    };
  } catch (err) {
    // 3. Race recovery. Re-read authoritative state; recover if the
    //    speculation is settled now, by either signal.
    const post = await tryReadSpeculationState(publicClient, speculationModule, speculationId);
    if (isAlreadySettledRevert(err) || post?.status === 'closed') {
      const recovered: EnsureSettledResult = {
        speculationId,
        outcome: 'recovered',
        winSide: post?.winSide ?? 'tbd',
      };
      // If this wallet actually broadcast a settle tx that reverted on
      // inclusion (lost the race), keep its hash for the audit trail.
      // Pre-send / pre-flight recoveries broadcast nothing, so there's
      // no hash to carry.
      const revertedTxHash = revertTxHashOf(err);
      if (revertedTxHash !== undefined) recovered.revertedTxHash = revertedTxHash;
      return recovered;
    }
    // Genuine failure (not settled, or couldn't confirm) — surface it.
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

/** Read on-chain speculation state, returning `null` on any read error
 * so a flaky read never aborts the ensure flow (we fall back to the
 * settle attempt / the genuine revert). */
async function tryReadSpeculationState(
  publicClient: PublicClient,
  speculationModule: Hex,
  speculationId: bigint,
): Promise<Awaited<ReturnType<typeof readSpeculationState>> | null> {
  try {
    return await readSpeculationState(publicClient, speculationModule, speculationId);
  } catch {
    return null;
  }
}
