/**
 * Internal DB row types — only the tables / columns the SDK actually
 * consumes via Supabase Realtime. Hand-written to mirror the live
 * indexer schema; refresh when those tables change. Not exported
 * from the package.
 */

export type DBNetwork = 'polygon' | 'amoy';

export interface CurrentOddsRow {
  network: DBNetwork;
  jsonodds_id: string;
  /** Constrained to 'moneyline' | 'spread' | 'total' by check constraint. */
  market: string;
  line: number | null;
  away_odds_american: number | null;
  home_odds_american: number | null;
  upstream_last_updated: string;
  poll_captured_at: string;
  changed_at: string;
}
