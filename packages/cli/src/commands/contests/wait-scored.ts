/**
 * `ospex contests wait-scored <contestId>` — standalone polling helper.
 * Blocks (signer-free) on the on-chain ContestModule.getContest read
 * until the contest reaches Scored (or Voided). Useful to pick up an
 * earlier `contests score` (fired without `--wait`) without re-sending
 * the request. Mirrors `wait-verified`.
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
import { contestVoidedWarning, renderScoredLine, resolveTeamsBestEffort } from './scoreDisplay.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
  timeoutSeconds: z.coerce.number().int().positive().max(3600).optional(),
  pollIntervalSeconds: z.coerce.number().int().positive().max(3600).optional(),
});

/** Named once so the success envelope and the §6 failure envelope cannot drift. */
const ACTION = 'contests.wait-scored';

export const contestWaitScoredCommand = new Command('wait-scored')
  .description('Poll on-chain ContestModule.getContest until the contest reaches Scored (or Voided).')
  .argument('<contestId>', 'contest id (uint256)')
  .option('--json', 'output as JSON')
  .option('--timeout-seconds <n>', 'override the default 120s timeout')
  .option('--poll-interval-seconds <n>', 'override the default 4s poll interval')
  .action(async (contestIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false, requiresChain: true });
    // Hoisted out of the `--json` branch so the catch can name the chain.
    const chainId = client.chainId();

    // No `subject`: this signer-free read has no wallet context at all.
    await withReadFailureEnvelope({ action: ACTION, chainId, json: opts.json === true }, async () => {
      const waitOpts: Parameters<typeof client.contests.waitForScored>[1] = {};
      if (opts.timeoutSeconds !== undefined) waitOpts.timeoutMs = opts.timeoutSeconds * 1000;
      if (opts.pollIntervalSeconds !== undefined) {
        waitOpts.pollIntervalMs = opts.pollIntervalSeconds * 1000;
      }

      const result = await client.contests.waitForScored(BigInt(contestIdArg), waitOpts);
      if (opts.json === true) {
        writeAgentEnvelope(
          buildAgentEnvelope({
            ok: true,
            action: ACTION,
            stage: 'read',
            network: networkForChainId(chainId),
            chainId,
            ...(result.status === 'voided'
              ? { warnings: [contestVoidedWarning(result.contestId)] }
              : {}),
            payload: {
              contestId: result.contestId.toString(),
              status: result.status,
              awayScore: result.awayScore,
              homeScore: result.homeScore,
            },
          }),
        );
      } else if (result.status === 'voided') {
        formatOutput(`Contest ${result.contestId} voided; it will not be scored.`, { json: false });
      } else {
        const teams = await resolveTeamsBestEffort(client, result.contestId);
        formatOutput(renderScoredLine(teams, result.awayScore, result.homeScore), { json: false });
      }
    });
  });
