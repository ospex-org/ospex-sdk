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
