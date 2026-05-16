import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { Hex } from '@ospex/sdk';
import { getClient } from '../../lib/client.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const positionsListCommand = new Command('list')
  .description('List positions for an address.')
  .argument('<address>', 'wallet address (0x…)')
  .option('--json', 'output as JSON')
  .action(async (address, opts) => {
    const parsed = optionsSchema.parse(opts);
    const client = await getClient({ requiresSigner: false });
    const positions = await client.positions.byAddress(address);
    if (parsed.json === true) {
      const chainId = client.chainId();
      const wallet = address.toLowerCase() as Hex;
      writeAgentEnvelope(
        buildAgentEnvelope({
          ok: true,
          action: 'positions.list',
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
  });
