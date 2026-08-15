/**
 * `ospex contests list [--sport NFL] [--hours 72] [--date 2026-08-14]` —
 * lists contests via the off-chain projected `/v1/contests` endpoint.
 * Default is the upcoming forward window; `--date` switches to dated /
 * historical discovery of one UTC day, whose rows carry the linked game's
 * finality (`gameFinalType`) for postgame settle-and-claim flows.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { formatMatchTime, formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
  sport: z.string().optional(),
  status: z.string().optional(),
  hours: z.coerce.number().int().positive().max(168).optional(),
  // Shape only — calendar reality (no Feb 30) is the API's check, and its
  // 400 message surfaces verbatim.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '--date must be a UTC day in YYYY-MM-DD form')
    .optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const contestListCommand = new Command('list')
  .description(
    'List contests (upcoming by default; --date lists one UTC day, past or future, with game finality).',
  )
  .option('--json', 'output as JSON')
  .option('--sport <sport>', 'sport filter (mlb, nba, ncaab, ncaaf, nfl, nhl)')
  .option('--status <status>', 'contest status filter')
  .option('--hours <n>', 'hours into future (1-168)')
  .option('--date <yyyy-mm-dd>', 'UTC day for dated/historical discovery (mutually exclusive with --hours)')
  .option('--limit <n>', 'page size (1-200)')
  .option('--offset <n>', 'pagination offset')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    if (opts.date !== undefined && opts.hours !== undefined) {
      throw new Error('--date and --hours are mutually exclusive. Pass exactly one.');
    }
    const client = await getClient({ requiresSigner: false });
    const listOpts: Parameters<typeof client.contests.list>[0] = {};
    if (opts.sport !== undefined) listOpts.sport = opts.sport;
    if (opts.status !== undefined) listOpts.status = opts.status;
    if (opts.hours !== undefined) listOpts.hours = opts.hours;
    if (opts.date !== undefined) listOpts.date = opts.date;
    if (opts.limit !== undefined) listOpts.limit = opts.limit;
    if (opts.offset !== undefined) listOpts.offset = opts.offset;

    const contests = await client.contests.list(listOpts);
    if (opts.json === true) {
      const chainId = client.chainId();
      writeAgentEnvelope(
        buildAgentEnvelope({
          ok: true,
          action: 'contests.list',
          stage: 'read',
          network: networkForChainId(chainId),
          chainId,
          payload: contests,
        }),
      );
      return;
    }
    formatOutput(
      contests.map((c) => {
        const row: Record<string, unknown> = {
          contestId: c.contestId,
          away: c.awayTeam,
          home: c.homeTeam,
          sport: c.sport,
          matchTime: formatMatchTime(c.matchTime),
          status: c.status,
          speculations: c.speculations.length,
        };
        // Dated rows carry event finality; the default table is unchanged.
        if (opts.date !== undefined) row.finality = c.gameFinalType ?? '';
        return row;
      }),
      { json: false },
    );
  });
