import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../lib/client.js';
import { formatOutput } from '../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const healthCommand = new Command('health')
  .description('Check the API liveness probe.')
  .option('--json', 'output as JSON')
  .action(async (opts) => {
    const parsed = optionsSchema.parse(opts);
    const client = await getClient({ requiresSigner: false });
    const result = await client.health.check();
    formatOutput(result, { json: parsed.json === true });
  });
