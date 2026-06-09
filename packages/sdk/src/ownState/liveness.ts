/**
 * The single, authoritative "is this owner commitment still matchable on
 * chain?" predicate — shared by the own-state snapshot decoder (which stamps
 * `OwnerCommitment.isLive` at decode time) AND any consumer that needs to
 * RE-derive liveness against a different clock (e.g. the `ospex own-state
 * watch` CLI recomputing its live count on heartbeat / at summary).
 *
 * It exists so there is exactly ONE copy of the predicate. A second,
 * prose-derived copy in the CLI drifted on the `expiry === null` and
 * unparseable-expiry edges (it treated them as non-expiring/live); this
 * module is the fix — both sites now call the same function.
 *
 * Mirrors `MatchingModule.matchCommitment`'s preconditions exactly, the same
 * way core-api derives effective status (`commitmentStatus.ts`): a row is
 * live iff
 *   1. raw stored lifecycle is `open` or `partially_filled`;
 *   2. not nonce-invalidated;
 *   3. remainingRiskAmount > 0;
 *   4. expiry is a PARSEABLE timestamp STRICTLY in the future.
 *
 * Critically (4): a `null` expiry, an unparseable expiry, and an expiry at or
 * before `nowMs` are ALL **not live**. On chain a null/invalid expiry behaves
 * as `expiry == 0` ⇒ already expired ⇒ unmatchable — so the conservative
 * "not live" is the correct, contract-faithful answer, never "non-expiring".
 *
 * Hidden bodies (`visibility === 'hidden'`) report `isLive` honestly too —
 * they remain matchable on chain until they reach a terminal state.
 */

import type { CommitmentStatus } from '../types/commitment.js';

/**
 * The liveness-relevant slice of an owner commitment. `storedStatus` is the
 * RAW on-chain lifecycle (resolved from any `storedStatus ?? status` fallback
 * by the caller). Typed as the wider {@link CommitmentStatus} so the decoder's
 * `storedStatus ?? status` fallback (which can surface the effective-only
 * `'expired'`) fits without a cast — the predicate only treats `open` /
 * `partially_filled` as live, so any other value (incl. `'expired'`) is
 * correctly not-live.
 */
export interface OwnerLivenessInput {
  storedStatus: CommitmentStatus;
  /** wei6 decimal string. */
  remainingRiskAmount: string;
  /** ISO-8601 timestamp, or `null`. A null expiry is treated as expired. */
  expiry: string | null;
  nonceInvalidated: boolean;
}

/**
 * Re-derive on-chain matchability at time `nowMs`. See module JSDoc for the
 * exact contract. Total + side-effect-free; never throws (an unparseable
 * `remainingRiskAmount` — impossible after wire validation — degrades to
 * `false` rather than throwing, since callers re-run this on a hot path).
 */
export function isOwnerCommitmentLiveAt(input: OwnerLivenessInput, nowMs: number): boolean {
  if (input.storedStatus !== 'open' && input.storedStatus !== 'partially_filled') return false;
  if (input.nonceInvalidated) return false;
  let remaining: bigint;
  try {
    remaining = BigInt(input.remainingRiskAmount);
  } catch {
    return false;
  }
  if (remaining <= 0n) return false;
  // Temporal guard — null / unparseable / non-future all read as expired,
  // matching core-api's `expiry == 0` ⇒ expired contract.
  if (input.expiry === null) return false;
  const expiryMs = Date.parse(input.expiry);
  if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) return false;
  return true;
}
