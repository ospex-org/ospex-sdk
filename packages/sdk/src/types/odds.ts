import type { OspexStreamError } from '../errors.js';
import type { StreamStatus } from './stream.js';

/**
 * Tag for the kind of odds row / scorer pairing this represents. Used
 * by `Commitment.marketType` (which scorer the wager points at) and by
 * the per-market odds shapes (`MoneylineOdds`, `SpreadOdds`, `TotalOdds`).
 *
 * Named `MarketType` because it tags the market-data layer (mirrors
 * the `ContestMarket` struct in `OspexTypes.sol` and the writer's
 * `current_odds.market` column). It is *not* an alias for
 * the (now removed) `Market` SDK entity — that role belongs to
 * `Contest` from `./contest.ts`.
 */
export type MarketType = 'moneyline' | 'spread' | 'total';

/**
 * Timestamp envelope shared across the three market-specific odds
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
 * Moneyline odds. Carries per-side American odds only; moneyline is
 * line-less by definition, so there is intentionally no `line` field.
 */
export interface MoneylineOdds extends OddsTimestamps {
  market: 'moneyline';
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

/**
 * Spread odds — both sides of the spread line are labelled
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
 * Total odds — `line` is the over/under threshold (perspective-
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
 * The odds shape delivered for a given market: `subscribe({ market: 'spread' })`
 * delivers `SpreadOdds`, `'moneyline'` delivers `MoneylineOdds`, and so on.
 * Lets the subscription handlers be precisely typed to the subscribed market
 * rather than the three-way union.
 */
export type OddsForMarket<M extends MarketType> = M extends 'moneyline'
  ? MoneylineOdds
  : M extends 'spread'
    ? SpreadOdds
    : M extends 'total'
      ? TotalOdds
      : never;

/** Identity/scope for `client.odds.subscribe` — one stream is one (contest, market). */
export interface OddsSubscribeArgs<M extends MarketType = MarketType> {
  /**
   * On-chain contest id. The stream resolves it to the contest's upstream
   * game server-side, so callers stay in contest-id vocabulary (no upstream
   * id needed). A contest with no upstream linkage simply never emits odds.
   */
  contestId: string | number;
  /** Which market's odds to stream. */
  market: M;
}

/**
 * Handlers for an odds subscription. `T` is the subscribed market's shape
 * (`MoneylineOdds`, `SpreadOdds`, or `TotalOdds`).
 *
 * Odds streams are latest-state: the server sends a `snapshot` baseline
 * once live, then `change` / `refresh` deltas. There is no cursor and no
 * replay — on reconnect (or after a `degraded` pause) the server re-sends a
 * fresh `snapshot`. Treat each delivered value as the current odds.
 */
export interface OddsSubscribeHandlers<T> {
  /**
   * The current baseline for this (contest, market), delivered once the
   * stream is live and again after every `degraded` recovery. `null` means
   * the stream is live but the writer has no odds for this market yet. Omit
   * if you only want change/refresh deltas.
   */
  onSnapshot?: (odds: T | null) => void;
  /**
   * A tracked price move — a line or per-side American-odds column changed,
   * or the upstream's own change timestamp advanced. Fires once per genuine
   * odds change; this is the signal most consumers want.
   */
  onChange: (odds: T) => void;
  /**
   * A re-poll that found no price change (liveness only). Usually you want
   * just `onChange`; subscribe here if you need to confirm the feed is still
   * being refreshed upstream.
   */
  onRefresh?: (odds: T) => void;
  /**
   * Connection lifecycle. Odds streams emit `connected` (live, baseline
   * delivered), `reconnecting` (dropped, retrying with backoff), and
   * `degraded` (upstream source is behind — updates paused until the next
   * snapshot). They never emit `resync`: odds is latest-state, so recovery
   * is a fresh snapshot rather than a cursor replay.
   */
  onStatus?: (status: StreamStatus) => void;
  /**
   * Transport errors. `OspexStreamError.reason` discriminates retry
   * (`connection_failed` / `capacity_exceeded` — the transport keeps
   * reconnecting; this fires for observability) from stop (`fatal` — the
   * subscription has ended). If omitted, errors are swallowed.
   */
  onError?: (err: OspexStreamError) => void;
}

export interface Subscription {
  unsubscribe(): Promise<void>;
}

/**
 * Public shape returned by `client.odds.snapshot(contestId)` — the
 * one-shot counterpart to the `subscribe` stream. Always carries all
 * three market keys so consumers don't need to null-check the keys
 * themselves; per-market values are `null` when the writer hasn't
 * populated that market for the contest's upstream game (or when the
 * contest has no upstream linkage at all).
 *
 * Each market entry uses an explicit, market-specific shape rather than
 * a generic envelope — see `MoneylineOdds`, `SpreadOdds`, `TotalOdds`.
 * This avoids the kind of side-ambiguity (spread `line` = home or away?)
 * and storage-detail leakage (total `awayOdds` = over odds?) that a
 * shared shape would invite.
 *
 * These are upstream market reference odds. Ospex commitments are
 * user-priced and don't have to match these.
 */
export interface ContestOddsSnapshot {
  contestId: string;
  odds: {
    moneyline: MoneylineOdds | null;
    spread: SpreadOdds | null;
    total: TotalOdds | null;
  };
}
