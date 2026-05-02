import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
  sport: z.string().optional(),
  status: z.string().optional(),
  hours: z.coerce.number().int().positive().max(168).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const marketsListCommand = new Command('list')
  .description('List upcoming markets (optionally filtered by sport / status / window).')
  .option('--json', 'output as JSON')
  .option('--sport <sport>', 'sport filter (nba, nhl, ncaab, nfl, mlb)')
  .option('--status <status>', 'contest status filter')
  .option('--hours <n>', 'hours into future (1-168)')
  .option('--limit <n>', 'page size (1-200)')
  .option('--offset <n>', 'pagination offset')
  .action(async (opts) => {
    const parsed = optionsSchema.parse(opts);
    const client = await getClient({ requiresSigner: false });
    const listOpts: Parameters<typeof client.markets.list>[0] = {};
    if (parsed.sport !== undefined) listOpts.sport = parsed.sport;
    if (parsed.status !== undefined) listOpts.status = parsed.status;
    if (parsed.hours !== undefined) listOpts.hours = parsed.hours;
    if (parsed.limit !== undefined) listOpts.limit = parsed.limit;
    if (parsed.offset !== undefined) listOpts.offset = parsed.offset;
    const markets = await client.markets.list(listOpts);
    if (parsed.json === true) {
      formatOutput(markets, { json: true });
      return;
    }
    formatOutput(
      markets.map((m) => ({
        contestId: m.contestId,
        away: m.awayTeam,
        home: m.homeTeam,
        sport: m.sport,
        matchTime: m.matchTime,
        status: m.status,
        speculations: m.speculations.length,
      })),
      { json: false },
    );
  });
