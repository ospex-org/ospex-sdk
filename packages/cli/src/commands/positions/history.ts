/**
 * `ospex positions history [--address <addr>] [--include-claimed]`
 *
 * Read-only: paginated history view of all positions for a wallet.
 * `--include-claimed` (default: false) controls whether already-claimed
 * positions are shown alongside open / unclaimed ones.
 *
 * The underlying endpoint (/v1/positions/:address) returns every row;
 * filtering happens client-side here. That's fine for the CLI's
 * use case — the 200-row cap inside the SDK is more than enough for
 * a human review session.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 0x-prefixed 20-byte hex string').optional(),
  includeClaimed: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const positionsHistoryCommand = new Command('history')
  .description('Show position history for an address (defaults to the configured signer).')
  .option('--address <addr>', 'wallet to read (defaults to the configured signer\'s address)')
  .option('--include-claimed', 'include already-claimed positions in the output')
  .option('--json', 'output as JSON')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const includeClaimed = opts.includeClaimed === true;

    // No chain required — pure read.
    const requiresSigner = opts.address === undefined;
    const client = await getClient({ requiresSigner });

    let address = opts.address;
    if (address === undefined) {
      const signer = client.signer();
      address = (await signer.getAddress()).toLowerCase();
    }

    const all = await client.positions.byAddress(address);
    const filtered = includeClaimed ? all : all.filter((p) => !p.claimed);

    formatOutput(filtered, { json: opts.json === true });
  });
