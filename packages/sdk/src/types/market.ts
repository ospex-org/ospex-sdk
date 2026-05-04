import type { Commitment } from './commitment.js';

export type MarketType = 'moneyline' | 'spread' | 'total';

/**
 * A single bettable line on a contest. `lineTicks` is the raw int32 from
 * chain (1.0× ticks); `line` is the human-readable value (`lineTicks / 10`).
 * `awayLine` / `homeLine` are populated for spread markets only.
 *
 * `orderbook` is undefined on list-style endpoints and populated by
 * `markets.get(contestId)`.
 */
export interface MarketSpeculation {
  speculationId: string;
  type: MarketType;
  lineTicks: number | null;
  line: number | null;
  awayLine?: number;
  homeLine?: number;
  /** 0 = active (open for new commitments), 1 = closed. */
  speculationStatus: 0 | 1;
  orderbook?: Commitment[];
}

export interface Market {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  sport: string;
  sportId: number;
  /** ISO-8601 string. */
  matchTime: string;
  status: string;
  speculations: MarketSpeculation[];
  // ── Detail-endpoint-only fields ───────────────────────────────────
  // The list endpoint stays lean — these are populated only when a
  // Market is fetched via `client.markets.get(contestId)` /
  // `client.contests.get(contestId)`. M4 SDK consumers needing
  // post-creation contest detail (creator, source hashes, scores,
  // lifecycle timestamps) read them off this Market shape.
  //
  // Naming conflates Contest and Market knowingly; a future rename
  // pass (`client.markets` → `client.speculations`, separating
  // Contest as its own entity) will untangle this.
  /**
   * Upstream JSONOdds ID. Null when the contest has no JSONOdds
   * linkage. Required for opening a `current_odds` Realtime channel.
   */
  jsonoddsId?: string | null;
  /** External Rundown id the contest was created against. */
  rundownId?: string | null;
  /** External Sportspage id the contest was created against. */
  sportspageId?: string | null;
  /** Wallet that called createContestFromOracle. Lower-case hex string. */
  contestCreator?: string;
  /** Resolved league enum string ("nfl", "nba", … "unknown"). */
  leagueId?: string;
  /** keccak256 of the verify Chainlink Functions JS source. */
  verifySourceHash?: string | null;
  /** keccak256 of the market-update Chainlink Functions JS source. */
  marketUpdateSourceHash?: string | null;
  /** keccak256 of the score Chainlink Functions JS source. */
  scoreContestSourceHash?: string | null;
  /** Final away-team score, populated on CONTEST_SCORES_SET. */
  awayScore?: number | null;
  /** Final home-team score, populated on CONTEST_SCORES_SET. */
  homeScore?: number | null;
  /** ISO timestamp of CONTEST_CREATED projection. */
  contestCreatedAt?: string | null;
  /** ISO timestamp of CONTEST_VERIFIED projection. */
  verifiedAt?: string | null;
  /** ISO timestamp of CONTEST_SCORES_SET projection. */
  scoredAt?: string | null;
  /** ISO timestamp of CONTEST_VOIDED projection. */
  voidedAt?: string | null;
}

export interface MarketsListOptions {
  sport?: string;
  status?: string;
  /** Hours into the future. Defaults to API-side default (72h). */
  hours?: number;
  limit?: number;
  offset?: number;
}
