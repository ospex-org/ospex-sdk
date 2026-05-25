/**
 * `client.positions.claimAll({ address?, opts? })` — sweep every
 * settle+claim a wallet is owed in a single SDK call.
 *
 * Pipeline:
 *   1. Fetch /v1/positions/:address/claim-params from core-api.
 *      Each entry carries an ordered `txParams[]` array — claimable
 *      rows have a single `claimPosition` step; pendingSettle rows
 *      have `settleSpeculation` then `claimPosition`.
 *   2. For each entry, walk the steps in order. BOTH legs are idempotent:
 *      the settle step runs through `ensureSpeculationSettled` and the
 *      claim step through `ensurePositionClaimed`. If the speculation is
 *      already settled on chain — common when another wallet just settled
 *      and core-api's `pendingSettle` projection hasn't caught up — the
 *      settle tx is skipped (or recovered after a race) and the sweep
 *      proceeds straight to the claim. Likewise, if the position was
 *      already claimed (a prior run, a manual claim, a concurrent caller,
 *      or `claimable`-projection lag), the claim tx is skipped/recovered
 *      and the entry still counts as success — with NO payout (the
 *      contract zeroes economic fields post-claim, so there's nothing to
 *      read back, and the SDK never fabricates one). A genuine settle/claim
 *      failure (`NotSettled`, `NoPayout`, RPC error, …) halts THIS entry
 *      only; the loop moves on so one bad position can't block the rest.
 *   3. Aggregate per-entry success/failure into the result array. Each
 *      entry carries an explicit `steps[]` record of what actually
 *      happened (sent / skipped / recovered / failed) so consumers
 *      never re-derive step semantics from bucket+index.
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

import {
  OspexChainError,
  OspexConfigError,
  OspexError,
  OspexValidationError,
} from '../errors.js';
import { ensureSpeculationSettled, type EnsureSettledResult } from './ensureSettled.js';
import { ensurePositionClaimed, type EnsureClaimedResult } from './ensureClaimed.js';
import type { SettleResult } from './settle.js';
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

export type ClaimAllStepName = 'settleSpeculation' | 'claimPosition';

export type ClaimAllStepOutcome =
  /** A tx was broadcast and confirmed. */
  | 'sent'
  /** Settle only: a pre-flight read found the speculation already
   * settled, so no settle tx was sent. */
  | 'skippedAlreadySettled'
  /** Settle only: the settle attempt reverted because a concurrent caller
   * settled first, and an on-chain re-read confirmed it. If this wallet
   * broadcast a settle that reverted on inclusion, its (reverted) hash is
   * on `txHash`; a pre-send revert broadcasts nothing. */
  | 'recoveredAlreadySettled'
  /** Claim only: a pre-flight read found the position already claimed, so
   * no claim tx was sent. No payout (the contract zeroes economic fields
   * post-claim — the SDK never derives one). */
  | 'skippedAlreadyClaimed'
  /** Claim only: the claim attempt reverted because the position was
   * already claimed (a benign overlap / rerun / projection lag), and an
   * on-chain re-read (or the decoded `AlreadyClaimed` selector) confirmed
   * it. If this wallet broadcast a claim that reverted on inclusion, its
   * (reverted) hash is on `txHash`; a pre-send revert broadcasts nothing.
   * No payout. */
  | 'recoveredAlreadyClaimed'
  /** The step threw. The entry as a whole is marked failed. */
  | 'failed';

/**
 * One executed step of an entry's plan. The agent-envelope mapper maps
 * each of these to exactly one effect or warning — there is no
 * re-derivation of "was this a settle or a claim?" from bucket+index.
 */
export interface ClaimAllStep {
  name: ClaimAllStepName;
  outcome: ClaimAllStepOutcome;
  /** For `sent`, the confirmed tx hash (this one DOES appear in the entry's
   * `txHashes`). For `recoveredAlreadySettled` / `recoveredAlreadyClaimed`,
   * the hash of a tx that PROVABLY reverted on-chain. For `failed`, the hash
   * of a tx this wallet broadcast — its actual on-chain status is in
   * `txStatus` (it may have reverted OR confirmed). A non-`sent` hash never
   * appears in the entry's `txHashes` (confirmed-successful only). */
  txHash?: string;
  /** For a `failed` step carrying a `txHash`, that tx's ACTUAL on-chain
   * status — `'reverted'` (the common failure) or `'confirmed'` (a tx that
   * landed successfully but whose result the SDK couldn't parse, e.g. a claim
   * with no decodable `POSITION_CLAIMED` event). Absent when no tx was
   * broadcast or its status is unknown. Lets the envelope report the true
   * on-chain outcome instead of assuming every failed-step tx reverted. */
  txStatus?: 'confirmed' | 'reverted';
  /** Settle steps only — resolved on-chain winning side. */
  winSide?: SettleResult['winSide'];
  /** Claim steps only, and only on a fresh `sent` claim — the
   * event-sourced payout. Absent on `skippedAlreadyClaimed` /
   * `recoveredAlreadyClaimed` (no on-chain payout to read post-claim; the
   * SDK never fabricates one). */
  payoutWei6?: string;
  payoutUSDC?: number;
  /** `failed` steps only — the `OspexError.code` of the failure. */
  errorCode?: string;
}

export interface ClaimAllEntryResult {
  positionId: string;
  speculationId: string;
  bucket: 'claimable' | 'pendingSettle';
  description: string;
  /** Whether the full pipeline (settle if needed, then claim)
   * succeeded for this entry. A skipped/recovered settle OR a
   * skipped/recovered (already-claimed) claim still counts as success —
   * the goal (settled, then claimed) was achieved. Only a genuine
   * failure (`NotSettled`, `NoPayout`, RPC error, …) flips this false. */
  success: boolean;
  /** Confirmed tx hashes only, in execution order. A skipped settle and a
   * pre-send recovery broadcast nothing; a recovered settle that reverted
   * on inclusion DID broadcast, but that reverted hash lives on
   * `steps[].txHash`, never here. Empty on dry-run, or when the first step
   * failed before any tx confirmed. */
  txHashes: string[];
  /** Ordered record of the steps actually executed (empty on dry-run).
   * Canonical source for what happened — `txHashes`, `winSide`, and
   * `payout*` below are conveniences derived from it. */
  steps: ClaimAllStep[];
  /** Populated when the claim step sent a fresh claim tx; absent on
   * dry-run, failure, or an already-claimed skip/recover (no payout). */
  payoutWei6?: string;
  payoutUSDC?: number;
  /** Populated when the settle step ran, skipped, or recovered. */
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
    /** Successful ENTRIES (every step sent/skipped/recovered, none
     * failed). Not the same as `claimedFresh` — an already-claimed entry
     * is a successful entry that sent no claim tx. */
    claimed: number;
    failed: number;
    /** Claim-leg outcome breakdown (additive — sums to the number of
     * claim steps across all entries). Lets a consumer distinguish "swept
     * a fresh payout" from "was already claimed" without walking
     * `entries[].steps`. */
    claimedFresh: number;
    alreadyClaimed: number;
    recoveredAlreadyClaimed: number;
    /** Fresh successful claim payouts in THIS run only — never includes
     * already-claimed/recovered positions (the contract zeroes their
     * economic fields, and the SDK never fabricates a payout). On dry-run,
     * the predicted total. */
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
      steps: [],
    };

    if (dryRun) {
      // Pretend each step succeeds and surface the predicted payout
      // so the caller can render the plan. Aggregate into the total
      // too — otherwise the dry-run summary reports $0.00 while every
      // entry shows a non-zero predicted payout. No on-chain work is
      // done in dry-run, so `steps` stays empty (like `txHashes`).
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
      // Per spec: per-position errors don't abort the loop. The failed
      // step itself was already recorded into `entryResult.steps` by
      // `runEntry` before it rethrew.
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

  // Claim-leg outcome breakdown, derived from the canonical `steps[]` so
  // it can't drift from what actually executed. Empty (all zero) on
  // dry-run, where no steps run.
  let claimedFresh = 0;
  let alreadyClaimed = 0;
  let recoveredAlreadyClaimed = 0;
  for (const e of entries) {
    for (const s of e.steps) {
      if (s.name !== 'claimPosition') continue;
      if (s.outcome === 'sent') claimedFresh += 1;
      else if (s.outcome === 'skippedAlreadyClaimed') alreadyClaimed += 1;
      else if (s.outcome === 'recoveredAlreadyClaimed') recoveredAlreadyClaimed += 1;
    }
  }

  return {
    address,
    success: dryRun ? false : failed === 0 && entries.length > 0,
    entries,
    totals: {
      claimed,
      failed,
      claimedFresh,
      alreadyClaimed,
      recoveredAlreadyClaimed,
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
      let r: EnsureSettledResult;
      try {
        r = await ensureSpeculationSettled(ctx, {
          speculationId: BigInt(step.args.speculationId),
        });
      } catch (err) {
        result.steps.push(failedStep('settleSpeculation', err));
        throw err;
      }
      result.winSide = r.winSide;
      if (r.outcome === 'settled') {
        // `txHash` is always present on the 'settled' outcome.
        result.txHashes.push(r.txHash as string);
        result.steps.push({
          name: 'settleSpeculation',
          outcome: 'sent',
          txHash: r.txHash as string,
          winSide: r.winSide,
        });
      } else if (r.outcome === 'alreadySettled') {
        result.steps.push({
          name: 'settleSpeculation',
          outcome: 'skippedAlreadySettled',
          winSide: r.winSide,
        });
      } else {
        const recoveredStep: ClaimAllStep = {
          name: 'settleSpeculation',
          outcome: 'recoveredAlreadySettled',
          winSide: r.winSide,
        };
        // If this wallet broadcast a settle that reverted on inclusion
        // (lost the race), preserve its hash — gas was spent, so the
        // audit trail must show it even though the entry recovered.
        if (r.revertedTxHash !== undefined) recoveredStep.txHash = r.revertedTxHash;
        result.steps.push(recoveredStep);
      }
    } else if (step.method === 'claimPosition') {
      let r: EnsureClaimedResult;
      try {
        r = await ensurePositionClaimed(ctx, {
          speculationId: BigInt(step.args.speculationId),
          positionType: step.args.positionType,
        });
      } catch (err) {
        result.steps.push(failedStep('claimPosition', err));
        throw err;
      }
      if (r.outcome === 'claimed') {
        // Fresh claim — event-sourced payout. `txHash`/`payout*` are always
        // present on 'claimed'. ONLY fresh payouts feed the run's realized
        // total (see the caller's `totalPayoutWei6` accumulation).
        result.txHashes.push(r.txHash as string);
        result.payoutWei6 = (r.payoutWei6 as bigint).toString();
        result.payoutUSDC = r.payoutUSDC as number;
        result.steps.push({
          name: 'claimPosition',
          outcome: 'sent',
          txHash: r.txHash as string,
          payoutWei6: (r.payoutWei6 as bigint).toString(),
          payoutUSDC: r.payoutUSDC as number,
        });
      } else if (r.outcome === 'alreadyClaimed') {
        // Benign — the payout was collected earlier (a prior run, a
        // concurrent caller, a manual claim). No tx, no payout; the entry
        // still succeeds. NOT added to `txHashes` or any payout total.
        result.steps.push({ name: 'claimPosition', outcome: 'skippedAlreadyClaimed' });
      } else {
        // recovered — a benign already-claimed won a race. No payout.
        const recoveredStep: ClaimAllStep = {
          name: 'claimPosition',
          outcome: 'recoveredAlreadyClaimed',
        };
        // If this wallet broadcast a claim that reverted on inclusion (lost
        // the race), preserve its hash — gas was spent, so the audit trail
        // must show it even though the entry recovered. (Pre-flight skip /
        // pre-send recovery carry no hash.) A reverted hash never enters
        // `txHashes` (confirmed-only).
        if (r.revertedTxHash !== undefined) recoveredStep.txHash = r.revertedTxHash;
        result.steps.push(recoveredStep);
      }
    } else {
      // Unknown method — surface clearly. Keeps the SDK forward-
      // compatible: if core-api adds new step types in the future,
      // existing SDK versions fail loudly rather than silently. No
      // typed step is recorded (the method isn't one we model); the
      // envelope mapper's no-step-failure fallback covers it.
      const stepRef = step as { method?: unknown };
      throw new OspexChainError(
        `claimAll: unrecognized txParams.method "${String(stepRef.method)}". SDK upgrade required.`,
      );
    }
  }
}

function errorCodeOf(err: unknown): string {
  return err instanceof OspexError ? err.code : 'CHAIN_ERROR';
}

/**
 * Construct a `failed` step from a thrown error. Single source of truth
 * for failed-step shape across BOTH the settle and claim legs — when the
 * error carries a `txHash`, `broadcastSignedTx` (and `claim()`) attached it,
 * and that hash MUST survive into the step (and thus the agent envelope) so
 * a gas-spending failure is auditable. Routing both legs through here keeps
 * that invariant from being applied to one site and forgotten at the other.
 *
 * Crucially, it ALSO records the tx's real on-chain status (`txStatus`) from
 * the error's receipt — never assuming a failed-step tx reverted. A
 * receipt-level revert → `'reverted'`; a tx that confirmed but whose result
 * couldn't be parsed (e.g. a claim with no `POSITION_CLAIMED` event, which
 * carries a SUCCESS receipt) → `'confirmed'`. The envelope mapper keys off
 * this so it can't mislabel a confirmed-but-unparseable claim as reverted.
 */
function failedStep(name: ClaimAllStepName, err: unknown): ClaimAllStep {
  const step: ClaimAllStep = { name, outcome: 'failed', errorCode: errorCodeOf(err) };
  if (err instanceof OspexChainError && err.txHash !== undefined) {
    step.txHash = err.txHash;
    if (err.receipt?.status === 'reverted') step.txStatus = 'reverted';
    else if (err.receipt?.status === 'success') step.txStatus = 'confirmed';
  }
  return step;
}
