import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const leaderboardShowCommand = new Command('show')
  .description('Show the active leaderboard.')
  .option('--json', 'output as JSON')
  .action(async (opts) => {
    const parsed = optionsSchema.parse(opts);
    const client = await getClient({ requiresSigner: false });
    const entries = await client.leaderboard.active();
    formatOutput(entries, { json: parsed.json === true });
  });
