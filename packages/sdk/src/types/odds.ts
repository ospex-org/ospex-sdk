import type { Network } from './protocol.js';

/**
 * Tag for the kind of odds row / scorer pairing this represents. Used
 * by `Commitment.marketType` (which scorer the wager points at) and by
 * `OddsSnapshot.market` (which scorer's odds row this is).
 *
 * Named `MarketType` because it tags the market-data layer (mirrors
 * the `ContestMarket` struct in `OspexTypes.sol` and the
 * `current_odds.market` Supabase column). It is *not* an alias for
 * the (now removed) `Market` SDK entity — that role belongs to
 * `Contest` from `./contest.ts`.
 */
export type MarketType = 'moneyline' | 'spread' | 'total';

/**
 * One row from `current_odds`, mapped to the SDK's camelCase shape.
 * This is the payload the `onChange` and `onRefresh` callbacks receive.
 */
export interface OddsSnapshot {
  jsonoddsId: string;
  market: MarketType;
  network: Network;
  /** Spread/total line value; null for moneyline. */
  line: number | null;
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
  /** ISO-8601 string. When the source data changed upstream. */
  upstreamLastUpdated: string;
  /** ISO-8601 string. When the writer last fetched the upstream row. */
  pollCapturedAt: string;
  /** ISO-8601 string. When any tracked price column last changed. */
  changedAt: string;
}

export interface OddsSubscribeArgs {
  jsonoddsId: string;
  market: MarketType;
}

export interface OddsSubscribeHandlers {
  /**
   * Fires when a tracked price column moves, or `changed_at` advances.
   * Always fires at least once per genuine price update.
   */
  onChange: (odds: OddsSnapshot) => void;
  /**
   * Fires when the writer re-polled the upstream and saw no price
   * change but the upstream row was re-fetched. Useful for liveness;
   * usually you only want `onChange`.
   */
  onRefresh?: (odds: OddsSnapshot) => void;
  /**
   * Fires for transport-level errors from the Realtime channel.
   * If omitted, errors are swallowed silently.
   */
  onError?: (err: Error) => void;
}

export interface Subscription {
  unsubscribe(): Promise<void>;
}

/**
 * Timestamp envelope shared across the three market-specific snapshot
 * shapes:
 *   - upstreamLastUpdated — when the upstream provider's row last moved
 *   - pollCapturedAt      — when the row was last re-fetched upstream
 *   - changedAt           — when any tracked price column last changed
 */
export interface OddsTimestamps {
  upstreamLastUpdated: string;
  pollCapturedAt: string;
  changedAt: string;
}

/**
 * Moneyline snapshot — one entry under `ContestOddsSnapshot.odds.moneyline`.
 * Carries per-side American odds only; moneyline is line-less by definition,
 * so there is intentionally no `line` field in the shape.
 */
export interface MoneylineOdds extends OddsTimestamps {
  market: 'moneyline';
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

/**
 * Spread snapshot — both sides of the spread line are labelled
 * (`awayLine = -homeLine` always). Convention: `homeLine` is negative
 * if home is favored. No un-labelled `line` field on this type — that
 * ambiguity is exactly what the per-market shapes were introduced to
 * remove.
 */
export interface SpreadOdds extends OddsTimestamps {
  market: 'spread';
  /** Away team's spread (= -homeLine when home line is set). */
  awayLine: number | null;
  /** Home team's spread (negative if home favored). */
  homeLine: number | null;
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

/**
 * Total snapshot — `line` is the over/under threshold (perspective-
 * neutral, single value). Over and under odds are named explicitly;
 * over/under is the canonical labelling for this market regardless of
 * how the upstream stores it.
 */
export interface TotalOdds extends OddsTimestamps {
  market: 'total';
  /** Over/under threshold (perspective-neutral). */
  line: number | null;
  overOddsAmerican: number | null;
  underOddsAmerican: number | null;
}

/**
 * Public shape returned by `client.odds.snapshot(contestId)` — the
 * one-shot counterpart to the Realtime `subscribe` channel. Always
 * carries all three market keys so consumers don't need to null-check
 * the keys themselves; per-market values are `null` when the writer
 * hasn't populated that market for the contest's upstream game (or
 * when the contest has no upstream linkage at all, in which case
 * `jsonoddsId` is also null).
 * * Each market entry uses an explicit, market-specific shape rather
 * than a generic envelope — see `MoneylineOdds`, `SpreadOdds`,
 * `TotalOdds`. This avoids the kind of side-ambiguity (spread `line`
 * = home or away?) and storage-detail leakage (total `awayOdds` =
 * over odds?) that a shared shape would invite.
 *
 * These are upstream market reference odds. Ospex commitments are
 * user-priced and don't have to match these.
 */
export interface ContestOddsSnapshot {
  contestId: string;
  jsonoddsId: string | null;
  odds: {
    moneyline: MoneylineOdds | null;
    spread: SpreadOdds | null;
    total: TotalOdds | null;
  };
}
