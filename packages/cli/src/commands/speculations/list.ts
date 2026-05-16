/**
 * `ospex speculations list [--contest <id>] [--sport <name>] [--status open|closed]`
 * — list speculations across one or more contests.
 *
 * `--contest <id>` is the fast indexed path. `--sport` joins through
 * the contests table on the server (slower; bounded by active contests).
 * Without either filter, returns all speculations on the configured
 * network (paginated).
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

const optionsSchema = z.object({
  json: z.boolean().optional(),
  contest: z.string().optional(),
  sport: z.string().optional(),
  status: z.enum(['open', 'closed']).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const speculationsListCommand = new Command('list')
  .description('List speculations (optionally scoped to a contest, sport, or status).')
  .option('--json', 'output as JSON')
  .option('--contest <contestId>', 'filter to a single contest (fast path)')
  .option('--sport <sport>', 'sport filter (nba, nhl, ncaab, nfl, mlb)')
  .option('--status <status>', 'speculation status: open or closed')
  .option('--limit <n>', 'page size (1-500)')
  .option('--offset <n>', 'pagination offset')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });

    const listOpts: Parameters<typeof client.speculations.list>[0] = {};
    if (opts.contest !== undefined) listOpts.contestId = opts.contest;
    if (opts.sport !== undefined) listOpts.sport = opts.sport;
    if (opts.status !== undefined) listOpts.status = opts.status;
    if (opts.limit !== undefined) listOpts.limit = opts.limit;
    if (opts.offset !== undefined) listOpts.offset = opts.offset;

    const speculations = await client.speculations.list(listOpts);

    if (opts.json === true) {
      const chainId = client.chainId();
      writeAgentEnvelope(
        buildAgentEnvelope({
          ok: true,
          action: 'speculations.list',
          stage: 'read',
          network: networkForChainId(chainId),
          chainId,
          payload: speculations,
        }),
      );
      return;
    }
    formatOutput(
      speculations.map((s) => ({
        speculationId: s.speculationId,
        contestId: s.contestId,
        type: s.type,
        line: s.line ?? '-',
        status: s.speculationStatus === 0 ? 'open' : 'closed',
      })),
      { json: false },
    );
  });
