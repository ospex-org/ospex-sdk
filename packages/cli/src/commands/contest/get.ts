/**
 * `ospex contest get <contestId>` — read off-chain projected contest
 * detail via core-api `/v1/markets/:contestId`.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({ json: z.boolean().optional() });

export const contestGetCommand = new Command('get')
  .description('Show a contest by id (off-chain projected data).')
  .argument('<contestId>', 'contest id (uint256)')
  .option('--json', 'output as JSON')
  .action(async (contestIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });
    const market = await client.contests.get(contestIdArg);

    if (opts.json === true) {
      formatOutput(market, { json: true });
      return;
    }
    formatOutput(
      {
        contestId: market.contestId,
        away: market.awayTeam,
        home: market.homeTeam,
        sport: market.sport,
        matchTime: market.matchTime,
        status: market.status,
        speculations: market.speculations.length,
      },
      { json: false },
    );
  });
