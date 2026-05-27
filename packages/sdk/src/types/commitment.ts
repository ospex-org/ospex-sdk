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
 * Advisory maker-funding headline for a commitment (Layer-D orderbook advisory):
 * `fully_backed` / `overcommitted` from a fresh snapshot, `unknown` when the
 * maker has no snapshot, `stale` when the snapshot aged past the API's freshness
 * threshold. Advisory + point-in-time — never authoritative.
 */
export type MakerFundingStatus = 'fully_backed' | 'overcommitted' | 'unknown' | 'stale';

/**
 * Advisory maker-funding fillability for a commitment, surfaced by the core API
 * when a list is fetched with {@link CommitmentsListOptions.includeFillability}.
 * Derived from the indexer's ~30s `maker_funding` snapshot (the maker's USDC
 * balance + PositionModule allowance vs. their visible committed book risk).
 *
 * It answers "is this visible liquidity actually backed right now?" without a
 * per-fill on-chain read. It is **advisory + point-in-time** and is NEVER folded
 * into {@link Commitment.status}. The `…BackedNow` booleans assert CURRENT
 * backed-ness, so they are `null` when the verdict is `unknown` (no snapshot) or
 * `stale` (too old to assert) — the numeric fields are last-known facts as-of
 * `checkedAtBlock`. A maker can be `orderIndividuallyBackedNow` (covers THIS
 * order) yet not `makerBookBackedNow` (can't cover their whole visible book) —
 * `makerFundingStatus: 'overcommitted'` — which is the "fake liquidity" this flags.
 * For a definitive single-fill check, use `commitments.checkCommitmentFillability`.
 */
export interface CommitmentFillability {
  /** Always true — a point-in-time advisory, never a guarantee. */
  advisory: true;
  makerFundingStatus: MakerFundingStatus;
  /** backing ≥ THIS order's remaining maker risk. `null` when unknown/stale. */
  orderIndividuallyBackedNow: boolean | null;
  /** backing ≥ the maker's whole VISIBLE committed book risk. `null` when unknown/stale. */
  makerBookBackedNow: boolean | null;
  /** min(USDC balance, USDC→PositionModule allowance), wei6 string. `null` when unknown. */
  makerBackingWei6: string | null;
  /** Σ remaining maker risk over the maker's visible matchable book, wei6 string. `null` when unknown. */
  makerVisibleCommittedWei6: string | null;
  /** backing / visibleCommitted, in basis points. `null` when unknown. */
  makerCoverageRatioBps: number | null;
  /** Chain block the balance/allowance were read at, as a string. `null` when unknown. */
  checkedAtBlock: string | null;
  /**
   * True only when a snapshot exists but its age exceeds the API's freshness
   * threshold (paired with `makerFundingStatus: 'stale'`). A *missing* snapshot
   * is reported as `makerFundingStatus: 'unknown'` with `stale: false` — so use
   * `makerFundingStatus` as the primary discriminator, not `stale`.
   */
  stale: boolean;
}

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
   * Derived: the raw on-chain lifecycle ({@link Commitment.storedStatus}) is `'open'`
   * or `'partially_filled'`, the row isn't `nonceInvalidated`, `remainingRiskAmount > 0`,
   * and the expiry is in the future. The canonical "is this commitment still matchable
   * on chain?" predicate — mirrors every precondition `matchCommitment` enforces.
   *
   * Keys off `storedStatus`, NOT the effective `status`: a *book-hidden* commitment
   * (pulled from the orderbook off-chain, but whose signed payload is still matchable on
   * chain) reads effective `status: 'cancelled'` yet is still `isLive` — `matchCommitment`
   * doesn't check book-visibility. On-chain matchability and orderbook visibility are
   * distinct questions; to filter to commitments still on the public book, use the
   * orderbook listing (which excludes hidden rows), not `isLive`.
   *
   * Computed at API decode time, so the expiry comparison is a snapshot — a commitment
   * held in memory across its expiry won't silently flip to `false` without re-fetching.
   */
  isLive: boolean;
  /** ISO-8601 string. */
  createdAt: string;
  /**
   * Advisory maker-funding fillability. Present ONLY when the list was fetched
   * with {@link CommitmentsListOptions.includeFillability} (the CLI's
   * `commitments list --with-fillability`). Advisory + point-in-time — see
   * {@link CommitmentFillability}. Absent on single-row / non-opt-in reads.
   */
  fillability?: CommitmentFillability;
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
  /**
   * Opt-in to advisory maker-funding fillability: each returned commitment gets
   * a {@link Commitment.fillability} object derived from the indexer's ~30s
   * `maker_funding` snapshot. Advisory + point-in-time, never a guarantee, never
   * folded into `status`. Defaults to false (fillability omitted).
   */
  includeFillability?: boolean;
  limit?: number;
  offset?: number;
}
