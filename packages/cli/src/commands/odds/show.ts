/**
 * `ospex odds show <contestId>` — one-shot snapshot of upstream
 * reference odds for a contest's underlying game. Prints all three
 * markets (moneyline / spread / total) with both decimal and American
 * odds, the line value where applicable, and a relative "last updated"
 * timestamp.
 *
 * Distinct from `ospex odds watch` (the streaming/agent primitive):
 *
 *   show  → "what are the current reference odds so I can decide what
 *            commitment price to write?" — single round-trip, exits.
 *   watch → "subscribe me to future upstream odds changes so I can
 *            react." — opens a Realtime channel, runs until SIGINT.
 *
 * Output is upstream reference odds (JSONOdds / Sportspage via
 * ospex-writer), NOT Ospex liquidity. Ospex commitments are user-priced
 * and don't have to match these. The footer line in human output and
 * the `source` field in --json output both label this explicitly.
 *
 * --json emits a single envelope object (NOT line-delimited like watch),
 * so consumers know they got exactly one snapshot per invocation.
 *
 * Spread `line` semantics: `home team's spread` (negative if home
 * favored). Matches the writer's pollCycle.ts:523 convention. Total
 * line is the over/under threshold. Moneyline line is null.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { ContestOddsSnapshot, OddsSnapshot } from '@ospex/sdk';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const oddsShowCommand = new Command('show')
  .description(
    'Show current upstream reference odds for a contest (single snapshot).',
  )
  .argument('<contestId>', 'contest ID')
  .option('--json', 'emit a single JSON envelope (snapshot + source label)')
  .action(async (contestId, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });

    // Fetch contest detail + odds snapshot in parallel — the contest
    // gives us team names + matchup display, the snapshot gives us
    // the prices.
    const [contest, snapshot] = await Promise.all([
      client.contests.get(contestId),
      client.odds.snapshot(contestId),
    ]);

    if (opts.json === true) {
      formatOutput(
        {
          source: 'upstream-reference',
          sourceNote:
            'JSONOdds / Sportspage market averages via ospex-writer. ' +
            'Ospex commitments are user-priced; these are reference data only.',
          contest: {
            contestId: contest.contestId,
            awayTeam: contest.awayTeam,
            homeTeam: contest.homeTeam,
            sport: contest.sport,
            startTime: contest.matchTime,
            jsonoddsId: snapshot.jsonoddsId,
          },
          odds: snapshot.odds,
        },
        { json: true },
      );
      return;
    }

    // Human output.
    process.stdout.write(
      `${contest.awayTeam} @ ${contest.homeTeam} — ${contest.sport.toUpperCase()}\n`,
    );
    process.stdout.write(`  start:    ${contest.matchTime}\n`);
    process.stdout.write(`  contest:  ${contest.contestId}\n`);
    if (snapshot.jsonoddsId !== null) {
      process.stdout.write(`  upstream: ${snapshot.jsonoddsId}\n`);
    }
    process.stdout.write('\n');

    if (snapshot.jsonoddsId === null) {
      process.stdout.write(
        '  (no upstream JSONOdds linkage — reference odds unavailable for this contest)\n',
      );
      return;
    }

    const allEmpty =
      snapshot.odds.moneyline === null &&
      snapshot.odds.spread === null &&
      snapshot.odds.total === null;
    if (allEmpty) {
      process.stdout.write(
        '  (writer has not populated any markets yet — try again in ~30s)\n',
      );
      return;
    }

    renderMarket('moneyline', snapshot.odds.moneyline, contest);
    renderMarket('spread', snapshot.odds.spread, contest);
    renderMarket('total', snapshot.odds.total, contest);

    process.stdout.write(
      '\n  Source: JSONOdds / Sportspage via ospex-writer. These are upstream reference\n' +
        '  odds — Ospex commitments are user-priced and don’t have to match these.\n',
    );
  });

function renderMarket(
  market: 'moneyline' | 'spread' | 'total',
  odds: OddsSnapshot | null,
  contest: { awayTeam: string; homeTeam: string },
): void {
  if (odds === null) {
    process.stdout.write(`  ${market.padEnd(9)} (not available)\n\n`);
    return;
  }
  const updated = relativeTime(odds.changedAt);
  if (market === 'moneyline') {
    process.stdout.write(`  moneyline\n`);
    process.stdout.write(
      `    away (${contest.awayTeam}):  ${formatAmerican(odds.awayOddsAmerican)}  (decimal ${formatDecimal(odds.awayOddsAmerican)})\n`,
    );
    process.stdout.write(
      `    home (${contest.homeTeam}):  ${formatAmerican(odds.homeOddsAmerican)}  (decimal ${formatDecimal(odds.homeOddsAmerican)})\n`,
    );
    process.stdout.write(`    updated: ${updated}\n\n`);
    return;
  }
  if (market === 'spread') {
    const homeLine = odds.line;
    const awayLine = homeLine !== null ? -homeLine : null;
    process.stdout.write(`  spread\n`);
    process.stdout.write(
      `    away (${contest.awayTeam}) ${formatLine(awayLine)}:  ${formatAmerican(odds.awayOddsAmerican)}  (decimal ${formatDecimal(odds.awayOddsAmerican)})\n`,
    );
    process.stdout.write(
      `    home (${contest.homeTeam}) ${formatLine(homeLine)}:  ${formatAmerican(odds.homeOddsAmerican)}  (decimal ${formatDecimal(odds.homeOddsAmerican)})\n`,
    );
    process.stdout.write(`    updated: ${updated}\n\n`);
    return;
  }
  // total
  process.stdout.write(`  total\n`);
  process.stdout.write(
    `    over  ${formatLine(odds.line)}:  ${formatAmerican(odds.awayOddsAmerican)}  (decimal ${formatDecimal(odds.awayOddsAmerican)})\n`,
  );
  process.stdout.write(
    `    under ${formatLine(odds.line)}:  ${formatAmerican(odds.homeOddsAmerican)}  (decimal ${formatDecimal(odds.homeOddsAmerican)})\n`,
  );
  process.stdout.write(`    updated: ${updated}\n\n`);
}

function formatAmerican(american: number | null): string {
  if (american === null) return '   —   ';
  if (american > 0) return `+${american}`;
  return String(american);
}

function formatDecimal(american: number | null): string {
  if (american === null) return '—';
  // Standard American → decimal conversion. Positive American: 1 + (a/100).
  // Negative American: 1 + (100/|a|). Round to 2 decimals.
  const decimal = american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
  return decimal.toFixed(2);
}

function formatLine(line: number | null): string {
  if (line === null) return '';
  if (line > 0) return `+${line}`;
  return String(line);
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
