import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../lib/client.js';
import { formatOutput } from '../lib/format.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  withReadFailureEnvelope,
  writeAgentEnvelope,
} from '../lib/agentEnvelope.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

/** Named once so the success envelope and the §6 failure envelope cannot drift. */
const ACTION = 'health';

export const healthCommand = new Command('health')
  .description('Check the API liveness probe.')
  .option('--json', 'output as JSON')
  .action(async (opts) => {
    const parsed = optionsSchema.parse(opts);
    const wantJson = parsed.json === true;
    const client = await getClient({ requiresSigner: false });
    // Hoisted out of the `--json` branch so the catch can name the chain.
    // Pure getter over a field the constructor always sets; cannot throw.
    const chainId = client.chainId();

    // No `subject`: this command has no wallet context at all (§5.3 `∅/none/∅`).
    await withReadFailureEnvelope({ action: ACTION, chainId, json: wantJson }, async () => {
      const result = await client.health.check();

      if (wantJson) {
        writeAgentEnvelope(
          buildAgentEnvelope({
            ok: true,
            action: ACTION,
            stage: 'read',
            network: networkForChainId(chainId),
            chainId,
            payload: result,
          }),
        );
        return;
      }
      formatOutput(result, { json: false });
    });
  });
