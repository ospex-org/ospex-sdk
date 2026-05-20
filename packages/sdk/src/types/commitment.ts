import type { MarketType } from './odds.js';

/**
 * Raw lifecycle status as stored by the indexer / submission relay. These are
 * the only values the `GET /v1/commitments?status=` filter accepts — `'expired'`
 * is never stored (the server returns 400 for it).
 */
export type StoredCommitmentStatus =
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled';

/**
 * Effective lifecycle status: the stored statuses plus the time-driven
 * `'expired'` transition the API derives. This is what `Commitment.status`
 * reports; the raw value is on `Commitment.storedStatus`.
 */
export type CommitmentStatus = StoredCommitmentStatus | 'expired';

/**
 * Public commitment shape. All on-chain numeric values that may exceed
 * Number.MAX_SAFE_INTEGER are strings (`riskAmount`, `nonce`, etc.) and
 * remain stringified when handed to the caller — it's their choice
 * whether to parse them as BigInt.
 */
export interface Commitment {
  commitmentHash: string;
  maker: string;
  contestId: string | null;
  scorer: string | null;
  lineTicks: number | null;
  positionType: 0 | 1 | null;
  oddsTick: number | null;
  marketType: MarketType | null;
  riskAmount: string;
  filledRiskAmount: string;
  remainingRiskAmount: string;
  nonce: string;
  /** ISO-8601 string. Null when not present (legacy rows). */
  expiry: string | null;
  speculationKey: string | null;
  signature: string | null;
  /**
   * EFFECTIVE lifecycle status. The core API folds time-expiry and nonce
   * invalidation into this value: an `open`/`partially_filled` row past its
   * expiry reads `'expired'`, and a nonce-invalidated one reads `'cancelled'`.
   * Use {@link Commitment.storedStatus} for the raw indexed value.
   */
  status: CommitmentStatus;
  /**
   * Raw status as stored by the indexer / submission relay
   * (`open | partially_filled | filled | cancelled`), before effective-status
   * derivation. Falls back to {@link Commitment.status} when read from an older
   * core-api build that doesn't return it.
   */
  storedStatus: StoredCommitmentStatus;
  source: string;
  network: string;
  nonceInvalidated: boolean;
  /**
   * Derived: status is `'open'` or `'partially_filled'`, the row isn't
   * `nonceInvalidated`, `remainingRiskAmount > 0`, and the expiry is in
   * the future. The canonical "is this commitment still matchable?"
   * predicate — mirrors every precondition `matchCommitment` enforces on
   * chain. Strictly stronger than `status !== 'expired'/'cancelled'`: it also
   * rejects the zero-remaining edge (a `partially_filled` row whose remaining
   * is 0), which effective `status` does NOT fold in. Computed at API decode
   * time, so the expiry comparison is a snapshot — a commitment held in memory
   * across its expiry won't silently flip to `false` without re-fetching.
   */
  isLive: boolean;
  /** ISO-8601 string. */
  createdAt: string;
}

export interface CommitmentsListOptions {
  maker?: string;
  scorer?: string;
  contestId?: string | number;
  /**
   * Filter to commitments matching this speculation. Resolves to a
   * `speculation_key` server-side (single lookup), then `.eq()`-filters
   * commitments — faster than passing `contestId + scorer` and matching
   * on `lineTicks` client-side.
   */
  speculationId?: string | number;
  /**
   * Comma-separated status list (or array) filtering the API's **stored**
   * status column. `'expired'` is NOT accepted here — it is an effective-only
   * status the API never stores (the server returns 400). To surface
   * time-expired rows, pass `includeExpired: true` and read the effective
   * `Commitment.status`. Defaults API-side to `'open,partially_filled'`.
   */
  status?: StoredCommitmentStatus | StoredCommitmentStatus[] | string;
  includeInvalidated?: boolean;
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
}
