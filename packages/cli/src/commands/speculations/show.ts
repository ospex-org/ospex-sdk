/**
 * `ospex speculations show <speculationId>` — read a single speculation
 * with its orderbook (open + partially_filled commitments) plus a small
 * parent-contest context block (teams, sport, matchTime, status).
 *
 * Implemented against `GET /v1/speculations/:speculationId` so a
 * lookup-by-id "just works" without the caller knowing the parent
 * contest id.
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
const ACTION = 'speculations.show';

export const speculationsShowCommand = new Command('show')
  .description('Show a speculation by id (with orderbook + parent contest context).')
  .argument('<speculationId>', 'speculation id (uint256)')
  .option('--json', 'output as JSON')
  .action(async (speculationIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });
    // Hoisted out of the `--json` branch so the catch can name the chain.
    const chainId = client.chainId();

    // No `subject`: this command reads by speculation id and has no wallet
    // context at all (§5.3 `∅/none/∅`).
    await withReadFailureEnvelope(
      {
        action: ACTION,
        chainId,
        json: opts.json === true,
      },
      async () => {
        const detail = await client.speculations.get(speculationIdArg);

        if (opts.json === true) {
          // Top-level `contest` / `speculation` shoulder fields not
          // populated: the v1 SpeculationDetail and v2 PreviewContest /
          // SpeculationMode shoulder shapes differ (the latter are
          // resolver-preview-specific). Mappers queued for PR-6. Full
          // detail (including parent-contest context block + orderbook)
          // still lives in payload.
          writeAgentEnvelope(
            buildAgentEnvelope({
              ok: true,
              action: ACTION,
              stage: 'read',
              network: networkForChainId(chainId),
              chainId,
              payload: detail,
            }),
          );
          return;
        }
        formatOutput(
          {
            speculationId: detail.speculationId,
            contestId: detail.contestId,
            type: detail.type,
            line: detail.line ?? '-',
            status: detail.speculationStatus === 0 ? 'open' : 'closed',
            winSide: detail.winSide ?? '-',
            settledAt: detail.settledAt != null ? formatMatchTime(detail.settledAt) : '-',
            contest: `${detail.contest.awayTeam} @ ${detail.contest.homeTeam} (${detail.contest.sport}, ${formatMatchTime(detail.contest.matchTime)}) — ${detail.contest.status}`,
            orderbookEntries: detail.orderbook.length,
          },
          { json: false },
        );
      },
    );
  });
