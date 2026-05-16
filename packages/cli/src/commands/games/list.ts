/**
 * `ospex games list [--sport mlb] [--hours 72] [--creatable-only]` —
 * lists upcoming games on the schedule.
 *
 * The default shows every upcoming game; the `creatable` column is the
 * source of truth for whether each row can be passed to
 * `ospex contests create --game-id`. The previous default (hide
 * non-creatable rows) confused operators who expected the schedule to
 * include rows whose external IDs hadn't landed yet — those rows
 * become creatable later as the writer fills them in.
 *
 * `--creatable-only` re-applies the strict filter for users who only
 * want rows they can act on right now.
 *
 * `--all` is a no-op alias for the new default; kept for back-compat
 * with scripts written before the flip.
 *
 * Human output omits the three external IDs intentionally — the
 * user-facing identifier is `gameId`. JSON output includes the
 * `externalIds` field for advanced consumers.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { GameSport } from '@ospex/sdk';
import { getClient } from '../../lib/client.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { formatMatchTime, formatOutput } from '../../lib/format.js';

const SPORT_VALUES = ['mlb', 'nba', 'ncaab', 'ncaaf', 'nfl', 'nhl'] as const;

const optionsSchema = z.object({
  json: z.boolean().optional(),
  sport: z.enum(SPORT_VALUES).optional(),
  hours: z.coerce.number().int().positive().max(720).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  all: z.boolean().optional(),
  creatableOnly: z.boolean().optional(),
});

export const gamesListCommand = new Command('list')
  .description('List upcoming games on the schedule (creatable + pending).')
  .option('--json', 'output as JSON (includes externalIds)')
  .option('--sport <sport>', 'sport filter (mlb, nba, ncaab, ncaaf, nfl, nhl)')
  .option('--hours <n>', 'hours into the future (1-720, default 168)')
  .option('--limit <n>', 'page size (1-200)')
  .option('--offset <n>', 'pagination offset')
  .option('--creatable-only', 'show only rows where contest creation is possible right now (default: show all upcoming)')
  .option('--all', '(deprecated; same as the new default — kept for back-compat with older scripts)')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });

    const listOpts: Parameters<typeof client.games.list>[0] = {};
    if (opts.sport !== undefined) listOpts.sport = opts.sport as GameSport;
    if (opts.hours !== undefined) listOpts.hours = opts.hours;
    if (opts.limit !== undefined) listOpts.limit = opts.limit;
    if (opts.offset !== undefined) listOpts.offset = opts.offset;
    // Default: show every upcoming game (availableOnly=false). `--creatable-only`
    // re-applies the strict filter. `--all` is preserved as a no-op alias.
    listOpts.availableOnly = opts.creatableOnly === true;

    const games = await client.games.list(listOpts);

    if (opts.json === true) {
      const chainId = client.chainId();
      writeAgentEnvelope(
        buildAgentEnvelope({
          ok: true,
          action: 'games.list',
          stage: 'read',
          network: networkForChainId(chainId),
          chainId,
          payload: games,
        }),
      );
      return;
    }
    if (games.length === 0) {
      process.stdout.write('(no games)\n');
      return;
    }
    formatOutput(
      games.map((g) => ({
        gameId: g.gameId,
        slug: g.slug,
        sport: g.sport,
        away: g.awayTeam.abbreviation,
        home: g.homeTeam.abbreviation,
        matchTime: formatMatchTime(g.matchTime),
        creatable: g.canCreateContest ? 'yes' : 'no',
      })),
      { json: false },
    );
  });
