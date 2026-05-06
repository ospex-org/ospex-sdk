/**
 * `ospex contests show <contestId>` — read off-chain projected contest
 * detail (with the orderbook-populated speculations) via core-api
 * `/v1/contests/:contestId`.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatMatchTime, formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({ json: z.boolean().optional() });

export const contestShowCommand = new Command('show')
  .description('Show a contest by id (off-chain projected data, includes orderbook).')
  .argument('<contestId>', 'contest id (uint256)')
  .option('--json', 'output as JSON')
  .action(async (contestIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });
    const contest = await client.contests.get(contestIdArg);

    if (opts.json === true) {
      formatOutput(contest, { json: true });
      return;
    }
    formatOutput(
      {
        contestId: contest.contestId,
        away: contest.awayTeam,
        home: contest.homeTeam,
        sport: contest.sport,
        matchTime: formatMatchTime(contest.matchTime),
        status: contest.status,
        speculations: contest.speculations.length,
      },
      { json: false },
    );
  });
