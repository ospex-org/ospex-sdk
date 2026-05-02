import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const marketsShowCommand = new Command('show')
  .description('Show a single market (with orderbook).')
  .argument('<contestId>', 'contest ID')
  .option('--json', 'output as JSON')
  .action(async (contestId, opts) => {
    const parsed = optionsSchema.parse(opts);
    const client = await getClient({ requiresSigner: false });
    const market = await client.markets.get(contestId);
    formatOutput(market, { json: parsed.json === true });
  });
