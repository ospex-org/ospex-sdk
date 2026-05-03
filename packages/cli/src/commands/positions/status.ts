import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const positionsStatusCommand = new Command('status')
  .description('Categorize positions for an address (active / pendingSettle / claimable).')
  .argument('<address>', 'wallet address (0x…)')
  .option('--json', 'output as JSON')
  .action(async (address, opts) => {
    const parsed = optionsSchema.parse(opts);
    const client = await getClient({ requiresSigner: false });
    const status = await client.positions.status(address);
    if (parsed.json === true) {
      formatOutput(status, { json: true });
      return;
    }
    formatOutput(
      {
        active: status.active.length,
        pendingSettle: status.pendingSettle.length,
        claimable: status.claimable.length,
        estimatedPayoutUSDC: status.totals.estimatedPayoutUSDC,
        pendingSettlePayoutUSDC: status.totals.pendingSettlePayoutUSDC,
      },
      { json: false },
    );
  });
