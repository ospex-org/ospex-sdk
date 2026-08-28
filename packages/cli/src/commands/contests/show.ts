/**
 * `ospex contests show <contestId>` — read off-chain projected contest
 * detail (with the orderbook-populated speculations) via core-api
 * `/v1/contests/:contestId`.
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
import { formatMatchTime, formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({ json: z.boolean().optional() });

/** Named once so the success envelope and the §6 failure envelope cannot drift. */
const ACTION = 'contests.show';

export const contestShowCommand = new Command('show')
  .description('Show a contest by id (off-chain projected data, includes orderbook).')
  .argument('<contestId>', 'contest id (uint256)')
  .option('--json', 'output as JSON')
  .action(async (contestIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });
    // Hoisted out of the `--json` branch so the catch can name the chain.
    const chainId = client.chainId();

    // No `subject`: §5.3 gives this command no wallet context.
    await withReadFailureEnvelope({ action: ACTION, chainId, json: opts.json === true }, async () => {
      const contest = await client.contests.get(contestIdArg);

      if (opts.json === true) {
        // Top-level `contest` shoulder field intentionally left null:
        // the v1 `Contest` shape and the v2 `PreviewContest` shoulder
        // shape differ (the latter is preview-resolver-specific). A
        // Contest→PreviewContest mapper is queued for the same
        // follow-up as the nextCommands registry (PR-6). Full contest
        // detail still lives in payload.
        writeAgentEnvelope(
          buildAgentEnvelope({
            ok: true,
            action: ACTION,
            stage: 'read',
            network: networkForChainId(chainId),
            chainId,
            payload: contest,
          }),
        );
        return;
      }
      formatOutput(
        {
          contestId: contest.contestId,
          away: contest.awayTeam,
          home: contest.homeTeam,
          sport: contest.sport,
          matchTime: formatMatchTime(contest.matchTime),
          status: contest.status,
          speculations: contest.speculations.length,
        },
        { json: false },
      );
    });
  });
