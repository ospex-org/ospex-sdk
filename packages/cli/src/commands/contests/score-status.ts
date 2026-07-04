/**
 * `ospex contests score-status <contestId>` — one-shot, signer-free,
 * non-blocking on-chain read of a contest's scoring state + final
 * scores. Reads on-chain (authoritative) rather than the core-api
 * projection, so a "not scored" answer can't be a stale indexer
 * projection — the same rationale that puts `wait-verified` on-chain.
 * Distinct from `contests show`: that reads the off-chain projection and
 * foregrounds status + speculations; this foregrounds the actual scores.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { formatOutput } from '../../lib/format.js';
import { renderScoredLine, resolveTeamsBestEffort } from './scoreDisplay.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const contestScoreStatusCommand = new Command('score-status')
  .description('Read on-chain scoring status + final scores for a contest (signer-free, one-shot).')
  .argument('<contestId>', 'contest id (uint256)')
  .option('--json', 'output as JSON')
  .action(async (contestIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false, requiresChain: true });

    const result = await client.contests.scoreStatus(BigInt(contestIdArg));
    if (opts.json === true) {
      const chainId = client.chainId();
      writeAgentEnvelope(
        buildAgentEnvelope({
          ok: true,
          action: 'contests.score-status',
          stage: 'read',
          network: networkForChainId(chainId),
          chainId,
          payload: {
            contestId: result.contestId.toString(),
            status: result.status,
            scored: result.scored,
            awayScore: result.awayScore,
            homeScore: result.homeScore,
          },
        }),
      );
    } else if (result.scored) {
      const teams = await resolveTeamsBestEffort(client, result.contestId);
      formatOutput(renderScoredLine(teams, result.awayScore, result.homeScore), { json: false });
    } else {
      formatOutput(`Contest ${result.contestId} status: ${result.status} (not scored).`, {
        json: false,
      });
    }
  });
