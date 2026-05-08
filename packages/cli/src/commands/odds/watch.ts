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
    const contest = await client.contests.get(contestId);

    // The Realtime channel filter is on (jsonodds_id, market) where the
    // markets are the protocol's three constants (moneyline / spread /
    // total). Existing Ospex speculations under the contest are NOT a
    // precondition — speculations are lazy and not created until first
    // commitment match. Previous code gated on `speculations.length > 0`,
    // which made `odds watch` unusable on a freshly-created contest.
    // The actual precondition is `jsonoddsId !== null` (without an
    // upstream linkage there's no current_odds row to subscribe to).
    const jsonoddsId = contest.jsonoddsId;
    if (!jsonoddsId) {
      console.error(
        `Contest ${contestId} has no upstream odds linkage — odds watching is ` +
          `unavailable for this contest.`,
      );
      process.exit(1);
    }

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
