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
  /**
   * Upstream JSONOdds ID. Populated only by `markets.get(contestId)` —
   * the list endpoint does not surface it. Null when the contest has
   * no JSONOdds linkage (fed from a different upstream). Required for
   * opening a `current_odds` Realtime channel.
   */
  jsonoddsId?: string | null;
}

export interface MarketsListOptions {
  sport?: string;
  status?: string;
  /** Hours into the future. Defaults to API-side default (72h). */
  hours?: number;
  limit?: number;
  offset?: number;
}
