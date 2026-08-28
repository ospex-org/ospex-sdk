import { exitAfterStdoutFlush } from '../../lib/agentEnvelope.js';
/**
 * `ospex odds watch <contestId>` — opens a live odds stream (core-api
 * SSE) for the contest across all three markets and prints a line per
 * event. Lines are line-delimited JSON in --json mode (one object per
 * line, suitable for piping); human mode prints a compact text summary.
 *
 * Events: `snapshot` (SNAP — the current baseline on connect / after a
 * degraded recovery), `change` (CHG — a real price move), `refresh`
 * (REF — a re-poll with no price change, gated behind
 * --include-refreshes). Connection status transitions
 * (connected / reconnecting / degraded) print to stderr in human mode
 * and as `{ kind: 'status' }` lines in --json mode.
 *
 * Stays running until SIGINT (Ctrl+C). Cleans up streams on exit.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type {
  MarketType,
  MoneylineOdds,
  SpreadOdds,
  StreamStatus,
  Subscription,
  TotalOdds,
} from '@ospex/sdk';
import { getClient } from '../../lib/client.js';
import { sanitizeUntargetedMessage } from '../../lib/redact.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
  includeRefreshes: z.boolean().optional(),
});

const MARKETS = ['moneyline', 'spread', 'total'] as const;

type AnyOdds = MoneylineOdds | SpreadOdds | TotalOdds;
type EventKind = 'snapshot' | 'change' | 'refresh';

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

    // A contest with no upstream linkage has no reference odds to stream —
    // the stream would just idle. Fail fast with a clear message instead.
    // (`subscribe` is contest-id native; the upstream id is resolved
    // server-side, so this check is purely for friendly UX.)
    if (!contest.jsonoddsId) {
      console.error(
        `Contest ${contestId} has no upstream odds linkage — odds watching is ` +
          `unavailable for this contest.`,
      );
      await exitAfterStdoutFlush(1);
    }

    const emit = (market: MarketType, kind: EventKind, odds: AnyOdds | null): void => {
      if (kind === 'refresh' && !includeRefreshes) return;
      if (json) {
        process.stdout.write(JSON.stringify({ kind, market, odds }) + '\n');
      } else {
        process.stdout.write(formatLine(kind, market, odds) + '\n');
      }
    };

    const emitStatus = (market: MarketType, status: StreamStatus): void => {
      if (json) {
        process.stdout.write(JSON.stringify({ kind: 'status', market, status }) + '\n');
      } else {
        process.stderr.write(`[${market}] ${status}\n`);
      }
    };

    const subs: Subscription[] = [];
    for (const m of MARKETS) {
      const sub = await client.odds.subscribe(
        { contestId, market: m },
        {
          onSnapshot: (odds) => emit(m, 'snapshot', odds),
          onChange: (odds) => emit(m, 'change', odds),
          ...(includeRefreshes
            ? { onRefresh: (odds: AnyOdds) => emit(m, 'refresh', odds) }
            : {}),
          onStatus: (status) => emitStatus(m, status),
          onError: (err) => {
            // Mirror own-state watch: scrub before logging in case a
            // configured stream URL carries credentials (defense-in-depth).
            console.error(`[${m}] stream error: ${sanitizeUntargetedMessage(err.message)}`);
          },
        },
      );
      subs.push(sub);
    }

    if (!json) {
      console.error(`Watching contest ${contestId}. Ctrl+C to stop.`);
    }

    const stop = async (): Promise<void> => {
      await Promise.all(subs.map((s) => s.unsubscribe().catch(() => undefined)));
      await exitAfterStdoutFlush(0);
    };
    process.on('SIGINT', () => {
      void stop();
    });
    process.on('SIGTERM', () => {
      void stop();
    });
  });

function formatLine(kind: EventKind, market: MarketType, odds: AnyOdds | null): string {
  const tag = kind === 'change' ? 'CHG' : kind === 'refresh' ? 'REF' : 'SNAP';
  if (odds === null) {
    return `[${tag}] ${market.padEnd(9)} (no odds yet)`;
  }
  switch (odds.market) {
    case 'moneyline':
      return (
        `[${tag}] ${odds.changedAt} ${'moneyline'.padEnd(9)} ` +
        `away=${fmtOdds(odds.awayOddsAmerican)} home=${fmtOdds(odds.homeOddsAmerican)}`
      );
    case 'spread':
      return (
        `[${tag}] ${odds.changedAt} ${'spread'.padEnd(9)} ` +
        `away ${fmtLine(odds.awayLine)} (${fmtOdds(odds.awayOddsAmerican)}) ` +
        `home ${fmtLine(odds.homeLine)} (${fmtOdds(odds.homeOddsAmerican)})`
      );
    case 'total':
      return (
        `[${tag}] ${odds.changedAt} ${'total'.padEnd(9)} ` +
        `${fmtLine(odds.line)} over=${fmtOdds(odds.overOddsAmerican)} under=${fmtOdds(odds.underOddsAmerican)}`
      );
  }
}

function fmtOdds(n: number | null): string {
  return n === null ? '-' : String(n);
}

function fmtLine(n: number | null): string {
  if (n === null) return '-';
  return n > 0 ? `+${n}` : String(n);
}
