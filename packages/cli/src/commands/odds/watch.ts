/**
 * `ospex odds watch <contestId>` — opens a Realtime subscription for
 * every speculation under the given contest and prints a line each
 * time onChange fires. Lines are line-delimited JSON in --json mode
 * (one object per line, suitable for piping); human mode prints a
 * compact text summary per line.
 *
 * onRefresh is gated behind --include-refreshes (off by default —
 * usually you only care about real price moves).
 *
 * Stays running until SIGINT (Ctrl+C). Cleans up channels on exit.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { OddsSnapshot, Subscription } from '@ospex/sdk';
import { getClient } from '../../lib/client.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
  includeRefreshes: z.boolean().optional(),
});

const MARKETS = ['moneyline', 'spread', 'total'] as const;

export const oddsWatchCommand = new Command('watch')
  .description('Stream live odds updates for a contest.')
  .argument('<contestId>', 'contest ID')
  .option('--json', 'output line-delimited JSON (one object per line)')
  .option('--include-refreshes', 'include refresh events (default: only price changes)')
  .action(async (contestId, opts) => {
    const parsed = optionsSchema.parse(opts);
    const json = parsed.json === true;
    const includeRefreshes = parsed.includeRefreshes === true;

    const client = await getClient({ requiresSigner: false });
    const market = await client.markets.get(contestId);
    if (market.speculations.length === 0) {
      console.error(`No speculations found for contest ${contestId}.`);
      process.exit(1);
    }

    // We need the contest's jsonodds_id to subscribe — that lives on the
    // contest record but isn't exposed via /v1/markets. The current_odds
    // table is keyed by (jsonodds_id, market). For M1 we look it up via
    // the analytics endpoint, which exposes it; long-term it should
    // surface on the market record itself.
    const jsonoddsId = await fetchJsonoddsId(client, contestId);

    const subs: Subscription[] = [];
    const onSnapshot =
      (kind: 'change' | 'refresh') =>
      (odds: OddsSnapshot): void => {
        if (kind === 'refresh' && !includeRefreshes) return;
        if (json) {
          process.stdout.write(JSON.stringify({ kind, ...odds }) + '\n');
        } else {
          process.stdout.write(formatLine(kind, odds) + '\n');
        }
      };

    for (const m of MARKETS) {
      const sub = await client.odds.subscribe(
        { jsonoddsId, market: m },
        {
          onChange: onSnapshot('change'),
          ...(includeRefreshes ? { onRefresh: onSnapshot('refresh') } : {}),
          onError: (err) => {
            console.error(`[${m}] realtime error: ${err.message}`);
          },
        },
      );
      subs.push(sub);
    }

    if (!json) {
      console.error(
        `Watching contest ${contestId} (jsonoddsId=${jsonoddsId}). Ctrl+C to stop.`,
      );
    }

    const stop = async (): Promise<void> => {
      await Promise.all(subs.map((s) => s.unsubscribe().catch(() => undefined)));
      process.exit(0);
    };
    process.on('SIGINT', () => {
      void stop();
    });
    process.on('SIGTERM', () => {
      void stop();
    });
  });

function formatLine(kind: 'change' | 'refresh', o: OddsSnapshot): string {
  const tag = kind === 'change' ? 'CHG' : 'REF';
  const line = o.line ?? '-';
  const away = o.awayOddsAmerican ?? '-';
  const home = o.homeOddsAmerican ?? '-';
  return `[${tag}] ${o.changedAt} ${o.market.padEnd(9)} line=${line} away=${away} home=${home}`;
}

async function fetchJsonoddsId(
  client: { api: { request: <T>(path: string) => Promise<T> } },
  contestId: string,
): Promise<string> {
  // Reuse the analytics endpoint which already returns jsonoddsId.
  const body = await client.api.request<{ jsonoddsId: string }>(
    `/v1/analytics/odds-history/${encodeURIComponent(contestId)}`,
  );
  return body.jsonoddsId;
}
