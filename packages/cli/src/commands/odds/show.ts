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

const MARKET_VALUES = ['moneyline', 'spread', 'total'] as const;

const optionsSchema = z.object({
  json: z.boolean().optional(),
  market: z.enum(MARKET_VALUES).optional(),
});

export const oddsShowCommand = new Command('show')
  .description(
    'Show current upstream reference odds for a contest (single snapshot).',
  )
  .argument('<contestId>', 'contest ID')
  .option('--json', 'emit a single JSON envelope')
  .option(
    '--market <type>',
    'filter human output to one market (moneyline | spread | total). Has no effect on --json — the JSON envelope shape stays stable for agents.',
  )
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

    // --market filters the human render to a single market. The JSON
    // envelope shape (above) is intentionally NOT filtered so an agent
    // sees the same `{ moneyline, spread, total }` triple regardless of
    // whether the flag was passed — let the agent's own pipeline pick
    // the field it cares about.
    if (opts.market === undefined || opts.market === 'moneyline') {
      renderMoneyline(snapshot.odds.moneyline, contest);
    }
    if (opts.market === undefined || opts.market === 'spread') {
      renderSpread(snapshot.odds.spread, contest);
    }
    if (opts.market === undefined || opts.market === 'total') {
      renderTotal(snapshot.odds.total);
    }
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
  process.stdout.write(`    ${formatFreshness(odds)}\n\n`);
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
  process.stdout.write(`    ${formatFreshness(odds)}\n\n`);
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
  process.stdout.write(`    ${formatFreshness(odds)}\n\n`);
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

/**
 * Render the two-part freshness line shown beneath each market.
 *
 * Why two parts: `changedAt` (price last moved) and `pollCapturedAt`
 * (writer last fetched the row from the upstream) answer different
 * questions:
 *
 *   - "Has this price been moving?"   → changedAt
 *   - "Is the data stale?"            → pollCapturedAt
 *
 * Showing only `changedAt` (the previous behavior) made a stable
 * line look like a stale row. The new format is unambiguous: how
 * long the price has been steady, and how recently we re-confirmed
 * it from the upstream.
 *
 * Example: a Pistons-Cavaliers total at 212.5 -105/-115 that the
 * market hasn't moved in 12 hours but the writer re-polled 5 minutes
 * ago renders as:
 *
 *   price stable for 12h · writer polled 5m ago
 */
export function formatFreshness(odds: { changedAt: string; pollCapturedAt: string }): string {
  return (
    `price stable for ${formatDuration(odds.changedAt)}` +
    ` · writer polled ${formatRelative(odds.pollCapturedAt)}`
  );
}

function formatRelative(iso: string): string {
  const e = elapsedSince(iso);
  if (e === null) return iso;
  return `${e.text} ago`;
}

function formatDuration(iso: string): string {
  const e = elapsedSince(iso);
  if (e === null) return iso;
  return e.text;
}

/**
 * Common bucketing for relative-time display. Returns the unit-suffixed
 * magnitude (e.g. "5m", "12h", "3d") without "ago" so the caller can
 * decide whether to attach a tense.
 */
function elapsedSince(iso: string): { text: string } | null {
  const then = new Date(iso).getTime();
  const now = Date.now();
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return { text: `${seconds}s` };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { text: `${minutes}m` };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { text: `${hours}h` };
  const days = Math.round(hours / 24);
  return { text: `${days}d` };
}
