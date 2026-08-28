import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { Hex } from '@ospex/sdk';
import { getClient } from '../../lib/client.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  withReadFailureEnvelope,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

/** Named once so the success envelope and the §6 failure envelope cannot drift. */
const ACTION = 'positions.list';

export const positionsListCommand = new Command('list')
  .description('List positions for an address.')
  .argument('<address>', 'wallet address (0x…)')
  .option('--json', 'output as JSON')
  .action(async (address, opts) => {
    const parsed = optionsSchema.parse(opts);
    const client = await getClient({ requiresSigner: false });
    // Hoisted out of the `--json` branch so the catch can name the chain.
    const chainId = client.chainId();
    // The subject is the positional argument, so it is known before the read
    // and stays known if the read fails. Lowercased HERE as well as on the
    // success path, or the same argv would report two spellings of one wallet.
    const wallet = address.toLowerCase() as Hex;

    await withReadFailureEnvelope(
      {
        action: ACTION,
        chainId,
        json: parsed.json === true,
        subject: () => ({ wallet, walletRole: 'subject' }),
      },
      async () => {
        const positions = await client.positions.byAddress(address);
        if (parsed.json === true) {
          writeAgentEnvelope(
            buildAgentEnvelope({
              ok: true,
              action: ACTION,
              stage: 'read',
              network: networkForChainId(chainId),
              chainId,
              wallet,
              walletRole: 'subject',
              payload: positions,
            }),
          );
          return;
        }
        formatOutput(positions, { json: false });
      },
    );
  });
