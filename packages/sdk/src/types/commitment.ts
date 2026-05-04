import type { MarketType } from './odds.js';

export type CommitmentStatus =
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'expired';

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
  status: CommitmentStatus;
  source: string;
  network: string;
  nonceInvalidated: boolean;
  /**
   * Derived: status is `'open'` or `'partially_filled'`, the row isn't
   * `nonceInvalidated`, `remainingRiskAmount > 0`, and the expiry is in
   * the future. The canonical "is this commitment still matchable?"
   * predicate — mirrors every precondition `matchCommitment` enforces
   * on chain. Computed at API decode time, so the expiry comparison is
   * a snapshot — a commitment held in memory across its expiry won't
   * silently flip to `false` without re-fetching.
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
   * Comma-separated status list, or array. Defaults API-side to
   * `'open,partially_filled'`.
   */
  status?: CommitmentStatus | CommitmentStatus[] | string;
  includeInvalidated?: boolean;
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
}
