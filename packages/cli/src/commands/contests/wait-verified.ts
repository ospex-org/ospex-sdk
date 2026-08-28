/**
 * `ospex contests wait-verified <contestId>` — standalone polling
 * helper. Useful when an earlier `create --no-wait` call needs to be
 * picked back up.
 */
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
  timeoutSeconds: z.coerce.number().int().positive().max(3600).optional(),
});

/** Named once so the success envelope and the §6 failure envelope cannot drift. */
const ACTION = 'contests.wait-verified';

export const contestWaitVerifiedCommand = new Command('wait-verified')
  .description('Poll on-chain ContestModule.getContest until the contest reaches Verified.')
  .argument('<contestId>', 'contest id (uint256)')
  .option('--json', 'output as JSON')
  .option('--timeout-seconds <n>', 'override the default 120s timeout')
  .action(async (contestIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false, requiresChain: true });
    // Hoisted out of the `--json` branch so the catch can name the chain.
    const chainId = client.chainId();

    // No `subject`: this signer-free read has no wallet context at all.
    await withReadFailureEnvelope({ action: ACTION, chainId, json: opts.json === true }, async () => {
      const waitOpts: Parameters<typeof client.contests.waitForVerified>[1] = {};
      if (opts.timeoutSeconds !== undefined) waitOpts.timeoutMs = opts.timeoutSeconds * 1000;

      const result = await client.contests.waitForVerified(BigInt(contestIdArg), waitOpts);
      if (opts.json === true) {
        writeAgentEnvelope(
          buildAgentEnvelope({
            ok: true,
            action: ACTION,
            stage: 'read',
            network: networkForChainId(chainId),
            chainId,
            payload: { contestId: result.contestId.toString(), status: result.status },
          }),
        );
      } else {
        formatOutput(`Verified. Status: ${result.status}.`, { json: false });
      }
    });
  });
