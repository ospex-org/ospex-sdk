/**
 * Supabase Realtime subscription for `current_odds`. Each call opens a
 * dedicated channel filtered to a single (jsonodds_id, market) tuple,
 * routes UPDATE / INSERT events through the classifier, and dispatches
 * to the user's `onChange` / `onRefresh` handlers.
 *
 * The Realtime payload includes the OLD row only because the table is
 * declared `REPLICA IDENTITY FULL` — see ospex-indexer/migrations.
 * Without that, oldRow is empty `{}` and every update would classify
 * as 'change' (initial-state fallback).
 */

import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
  SupabaseClient,
} from '@supabase/supabase-js';

import type { CurrentOddsRow } from '../db/types.js';
import type {
  OddsSnapshot,
  OddsSubscribeArgs,
  OddsSubscribeHandlers,
  Subscription,
} from '../types/odds.js';
import type { MarketType } from '../types/market.js';
import type { Network } from '../types/protocol.js';
import { classifyOddsUpdate } from './classifier.js';

interface SubscribeOptions extends OddsSubscribeArgs {
  network?: Network;
}

export function subscribeToOdds(
  supabase: SupabaseClient,
  options: SubscribeOptions,
  handlers: OddsSubscribeHandlers,
): Subscription {
  const network: Network = options.network ?? 'polygon';
  const channelId = `ospex-odds:${network}:${options.jsonoddsId}:${options.market}`;

  const channel: RealtimeChannel = supabase
    .channel(channelId)
    .on(
      // The supabase-js types narrow `event` strictly; pass-through cast
      // keeps the runtime correct without bringing the full PG event union
      // into our public surface.
      'postgres_changes' as never,
      {
        event: '*',
        schema: 'public',
        table: 'current_odds',
        filter: `jsonodds_id=eq.${options.jsonoddsId}`,
      },
      (payload: RealtimePostgresChangesPayload<CurrentOddsRow>) => {
        try {
          handleEvent(payload, options.market, network, handlers);
        } catch (err) {
          handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      },
    )
    .subscribe((status, err) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        handlers.onError?.(err ?? new Error(`Realtime channel ${status}`));
      }
    });

  return {
    async unsubscribe(): Promise<void> {
      await supabase.removeChannel(channel);
    },
  };
}

function handleEvent(
  payload: RealtimePostgresChangesPayload<CurrentOddsRow>,
  market: MarketType,
  network: Network,
  handlers: OddsSubscribeHandlers,
): void {
  const newRow = (payload.new ?? null) as CurrentOddsRow | null;
  if (!newRow || newRow.market !== market) return;

  const oldRow = (payload.old ?? null) as CurrentOddsRow | null;
  // INSERT events (oldRow empty) and UPDATE events both flow through
  // the classifier; DELETE leaves newRow empty and is filtered above.
  const classification = classifyOddsUpdate(
    oldRow && Object.keys(oldRow).length > 0 ? oldRow : null,
    newRow,
  );
  if (classification === 'none') return;

  const snapshot = toSnapshot(newRow, market, network);
  if (classification === 'change') {
    handlers.onChange(snapshot);
  } else {
    handlers.onRefresh?.(snapshot);
  }
}

function toSnapshot(row: CurrentOddsRow, market: MarketType, network: Network): OddsSnapshot {
  return {
    jsonoddsId: row.jsonodds_id,
    market,
    network,
    line: row.line,
    awayOddsAmerican: row.away_odds_american,
    homeOddsAmerican: row.home_odds_american,
    upstreamLastUpdated: row.upstream_last_updated,
    pollCapturedAt: row.poll_captured_at,
    changedAt: row.changed_at,
  };
}
