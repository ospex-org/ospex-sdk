/**
 * `ospex odds show <contestId>` — one-shot snapshot of upstream market
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
 * --json emits a single envelope object (NOT line-delimited like watch),
 * so consumers know they got exactly one snapshot per invocation.
 *
 * Spread `line` semantics: home team's spread (negative if home
 * favored); the API serves both `awayLine` (= -homeLine) and `homeLine`
 * directly so this command never has to flip signs client-side. Total
 * `line` is the over/under threshold. Moneyline `line` is omitted.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { MoneylineOdds, SpreadOdds, TotalOdds } from '@ospex/sdk';
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
  .option('--json', 'emit a single JSON envelope')
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
          contest: {
            contestId: contest.contestId,
            awayTeam: contest.awayTeam,
            homeTeam: contest.homeTeam,
            sport: contest.sport,
            matchTime: contest.matchTime,
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
        '  (no upstream odds linkage — reference odds unavailable for this contest)\n',
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

    renderMoneyline(snapshot.odds.moneyline, contest);
    renderSpread(snapshot.odds.spread, contest);
    renderTotal(snapshot.odds.total);
  });

function renderMoneyline(
  odds: MoneylineOdds | null,
  contest: { awayTeam: string; homeTeam: string },
): void {
  if (odds === null) {
    process.stdout.write(`  moneyline (not available)\n\n`);
    return;
  }
  process.stdout.write(`  moneyline\n`);
  process.stdout.write(
    `    away (${contest.awayTeam}):  ${formatAmerican(odds.awayOddsAmerican)}  (decimal ${formatDecimal(odds.awayOddsAmerican)})\n`,
  );
  process.stdout.write(
    `    home (${contest.homeTeam}):  ${formatAmerican(odds.homeOddsAmerican)}  (decimal ${formatDecimal(odds.homeOddsAmerican)})\n`,
  );
  process.stdout.write(`    updated: ${relativeTime(odds.changedAt)}\n\n`);
}

function renderSpread(
  odds: SpreadOdds | null,
  contest: { awayTeam: string; homeTeam: string },
): void {
  if (odds === null) {
    process.stdout.write(`  spread (not available)\n\n`);
    return;
  }
  // awayLine + homeLine come labelled from the API — no client-side
  // line-flipping logic needed.
  process.stdout.write(`  spread\n`);
  process.stdout.write(
    `    away (${contest.awayTeam}) ${formatLine(odds.awayLine)}:  ${formatAmerican(odds.awayOddsAmerican)}  (decimal ${formatDecimal(odds.awayOddsAmerican)})\n`,
  );
  process.stdout.write(
    `    home (${contest.homeTeam}) ${formatLine(odds.homeLine)}:  ${formatAmerican(odds.homeOddsAmerican)}  (decimal ${formatDecimal(odds.homeOddsAmerican)})\n`,
  );
  process.stdout.write(`    updated: ${relativeTime(odds.changedAt)}\n\n`);
}

function renderTotal(odds: TotalOdds | null): void {
  if (odds === null) {
    process.stdout.write(`  total (not available)\n\n`);
    return;
  }
  // overOdds/underOdds come from the API directly — no away/home →
  // over/under remapping. Total has one line (the threshold), shared
  // by both sides.
  process.stdout.write(`  total\n`);
  process.stdout.write(
    `    over  ${formatLine(odds.line)}:  ${formatAmerican(odds.overOddsAmerican)}  (decimal ${formatDecimal(odds.overOddsAmerican)})\n`,
  );
  process.stdout.write(
    `    under ${formatLine(odds.line)}:  ${formatAmerican(odds.underOddsAmerican)}  (decimal ${formatDecimal(odds.underOddsAmerican)})\n`,
  );
  process.stdout.write(`    updated: ${relativeTime(odds.changedAt)}\n\n`);
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
