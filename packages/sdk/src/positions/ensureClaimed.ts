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
 *   3. Send reverted → recover ONLY for a benign already-claimed, by one of
 *      two signals:
 *        (a) the pre-send (`estimateGas`) revert decoded to `AlreadyClaimed`
 *            (no tx broadcast), or
 *        (b) this wallet broadcast a claim that PROVABLY reverted on
 *            inclusion (the error carries a `'reverted'` receipt) AND a
 *            re-read shows `claimed === true`.
 *      An inclusion-time recovery preserves `revertedTxHash` + `revertedReceipt`
 *      (gas was spent — account it). Otherwise the revert is a genuine
 *      failure (`NotSettled`, `NoPayout`, RPC error, …) and propagates
 *      unchanged.
 *
 * Why the proven-revert gate in (b) is load-bearing: the strict `claim()`
 * throws a tx-hash-bearing `OspexChainError` in TWO situations, distinguished
 * by `err.receipt.status` — a real on-chain revert (`status: 'reverted'`),
 * and a tx that SUCCEEDED but whose receipt had no parseable `POSITION_CLAIMED`
 * event (`status: 'success'`). The latter is a genuine claim (payout
 * transferred) we just can't read back — it MUST stay loud, never be relabeled
 * a recovered/no-payout claim. So recovery keys off `receipt.status ===
 * 'reverted'`, never receipt presence, a bare tx hash, or a bare post-read of
 * `claimed`.
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
   * broadcast a claim that PROVABLY reverted on inclusion (lost the race —
   * gas was spent). Absent when recovery came via a pre-send (`estimateGas`)
   * `AlreadyClaimed` revert, where no tx was broadcast. The audit trail must
   * not lose this hash. Always travels together with `revertedReceipt`. */
  revertedTxHash?: Hash;
  /** The receipt of the reverted claim tx (`revertedTxHash`) — the
   * authoritative one `broadcastSignedTx` saw (status `'reverted'`), so
   * consumers can account the POL gas it spent (carries `gasUsed` /
   * `effectiveGasPrice`). Present iff `revertedTxHash` is — the two are set
   * together (the receipt is what PROVES the revert, so a recovery never
   * happens without it). */
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
    // 3. Recovery is deliberately narrow — a benign already-claimed is the
    //    ONLY thing we convert to success. Two recognizers:
    //
    //    (a) The pre-send (estimateGas) revert decoded to AlreadyClaimed —
    //        the contract told us directly, and no tx was broadcast.
    //
    //    (b) This wallet broadcast a claim that REVERTED on inclusion (lost a
    //        race to a concurrent claim) AND a re-read confirms the position
    //        is now claimed. The "actually reverted" proof is load-bearing:
    //        strict claim() ALSO throws `OspexChainError({ txHash })` when a
    //        SUCCESSFUL tx had no parseable POSITION_CLAIMED event — that is
    //        NOT a revert, the payout really happened, and it MUST stay loud
    //        rather than be silently relabeled a recovered claim with the
    //        payout dropped. So we key off the structured reverted receipt
    //        `broadcastSignedTx` attaches (present only on a genuine on-chain
    //        revert) — never a bare tx hash, and never a bare post-read.
    //
    //    Everything else — NotSettled, NoPayout, RPC errors, a confirmed-but-
    //    unparseable claim, or a reverted tx where the position still isn't
    //    claimed — propagates unchanged.
    if (isAlreadyClaimedRevert(err)) {
      return { speculationId, positionType, outcome: 'recovered' };
    }

    const revertedReceipt = revertedReceiptOf(err);
    if (revertedReceipt !== undefined) {
      const post = await tryReadPositionState(publicClient, positionModule, speculationId, user, positionType);
      if (post?.claimed === true) {
        // Inclusion-time race lost, but the position ended up claimed. Keep
        // the reverted tx's hash AND receipt so the POL gas it spent is
        // accounted (e.g. the market-maker's daily gas budget must include
        // reverted txs).
        return {
          speculationId,
          positionType,
          outcome: 'recovered',
          revertedTxHash: revertedReceipt.transactionHash,
          revertedReceipt,
        };
      }
    }
    // Genuine failure (not claimed, couldn't confirm, or a non-revert error)
    // — surface it.
    throw err;
  }
}

/** Pull a *reverted* receipt off a caught error. Keys specifically on
 * `receipt.status === 'reverted'` — NOT on receipt presence: a confirmed-but-
 * unparseable claim (`claim()`'s missing-`POSITION_CLAIMED`-event throw) also
 * carries a receipt, but with `status: 'success'`, and must stay loud rather
 * than be treated as a recoverable revert. Only a `'reverted'`-status receipt
 * is authoritative proof the tx reverted on-chain. See `OspexChainError.receipt`
 * for the full status contract. */
function revertedReceiptOf(err: unknown): TransactionReceipt | undefined {
  return err instanceof OspexChainError && err.receipt?.status === 'reverted'
    ? err.receipt
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
