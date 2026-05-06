/**
 * `ospex contests list [--sport NFL] [--hours 72]` — lists upcoming
 * contests via the off-chain projected `/v1/contests` endpoint.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatMatchTime, formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
  sport: z.string().optional(),
  status: z.string().optional(),
  hours: z.coerce.number().int().positive().max(168).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const contestListCommand = new Command('list')
  .description('List upcoming contests (optionally filtered by sport / status / window).')
  .option('--json', 'output as JSON')
  .option('--sport <sport>', 'sport filter (nba, nhl, ncaab, nfl, mlb)')
  .option('--status <status>', 'contest status filter')
  .option('--hours <n>', 'hours into future (1-168)')
  .option('--limit <n>', 'page size (1-200)')
  .option('--offset <n>', 'pagination offset')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });
    const listOpts: Parameters<typeof client.contests.list>[0] = {};
    if (opts.sport !== undefined) listOpts.sport = opts.sport;
    if (opts.status !== undefined) listOpts.status = opts.status;
    if (opts.hours !== undefined) listOpts.hours = opts.hours;
    if (opts.limit !== undefined) listOpts.limit = opts.limit;
    if (opts.offset !== undefined) listOpts.offset = opts.offset;

    const contests = await client.contests.list(listOpts);
    if (opts.json === true) {
      formatOutput(contests, { json: true });
      return;
    }
    formatOutput(
      contests.map((c) => ({
        contestId: c.contestId,
        away: c.awayTeam,
        home: c.homeTeam,
        sport: c.sport,
        matchTime: formatMatchTime(c.matchTime),
        status: c.status,
        speculations: c.speculations.length,
      })),
      { json: false },
    );
  });
