import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
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
const ACTION = 'leaderboard.show';

export const leaderboardShowCommand = new Command('show')
  .description('Show the active leaderboard.')
  .option('--json', 'output as JSON')
  .action(async (opts) => {
    const parsed = optionsSchema.parse(opts);
    const client = await getClient({ requiresSigner: false });
    // Hoisted out of the `--json` branch so the catch can name the chain.
    const chainId = client.chainId();

    // No `subject`: §5.3 gives this read `none` — it has no wallet context.
    await withReadFailureEnvelope({ action: ACTION, chainId, json: parsed.json === true }, async () => {
      const entries = await client.leaderboard.active();
      if (parsed.json === true) {
        writeAgentEnvelope(
          buildAgentEnvelope({
            ok: true,
            action: ACTION,
            stage: 'read',
            network: networkForChainId(chainId),
            chainId,
            payload: entries,
          }),
        );
        return;
      }
      formatOutput(entries, { json: false });
    });
  });
