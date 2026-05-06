/**
 * `ospex games list [--sport mlb] [--hours 72] [--all]` — lists
 * upcoming games available for contest creation.
 *
 * The default narrows to games where all three external IDs are
 * present, status is `upcoming`, and no on-chain contest exists yet
 * — i.e. games a user can pass to `ospex contests create --game-id`
 * right now. `--all` widens the view to include incomplete /
 * already-created / past-status games.
 *
 * Human output omits the three external IDs intentionally — the
 * user-facing identifier is `gameId`. JSON output includes the
 * `externalIds` field for advanced consumers.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { GameSport } from '@ospex/sdk';
import { getClient } from '../../lib/client.js';
import { formatMatchTime, formatOutput } from '../../lib/format.js';

const SPORT_VALUES = ['mlb', 'nba', 'ncaab', 'ncaaf', 'nfl', 'nhl'] as const;

const optionsSchema = z.object({
  json: z.boolean().optional(),
  sport: z.enum(SPORT_VALUES).optional(),
  hours: z.coerce.number().int().positive().max(720).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  all: z.boolean().optional(),
});

export const gamesListCommand = new Command('list')
  .description('List upcoming games available for contest creation.')
  .option('--json', 'output as JSON (includes externalIds)')
  .option('--sport <sport>', 'sport filter (mlb, nba, ncaab, ncaaf, nfl, nhl)')
  .option('--hours <n>', 'hours into the future (1-720, default 168)')
  .option('--limit <n>', 'page size (1-200)')
  .option('--offset <n>', 'pagination offset')
  .option('--all', 'include games that cannot have a contest created (incomplete IDs / non-upcoming status / contest already created)')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });

    const listOpts: Parameters<typeof client.games.list>[0] = {};
    if (opts.sport !== undefined) listOpts.sport = opts.sport as GameSport;
    if (opts.hours !== undefined) listOpts.hours = opts.hours;
    if (opts.limit !== undefined) listOpts.limit = opts.limit;
    if (opts.offset !== undefined) listOpts.offset = opts.offset;
    if (opts.all === true) listOpts.availableOnly = false;

    const games = await client.games.list(listOpts);

    if (opts.json === true) {
      formatOutput(games, { json: true });
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
