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
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({ json: z.boolean().optional() });

export const speculationsShowCommand = new Command('show')
  .description('Show a speculation by id (with orderbook + parent contest context).')
  .argument('<speculationId>', 'speculation id (uint256)')
  .option('--json', 'output as JSON')
  .action(async (speculationIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });
    const detail = await client.speculations.get(speculationIdArg);

    if (opts.json === true) {
      formatOutput(detail, { json: true });
      return;
    }
    formatOutput(
      {
        speculationId: detail.speculationId,
        contestId: detail.contestId,
        type: detail.type,
        line: detail.line ?? '-',
        status: detail.speculationStatus === 0 ? 'open' : 'closed',
        contest: `${detail.contest.awayTeam} @ ${detail.contest.homeTeam} (${detail.contest.sport}, ${detail.contest.matchTime}) — ${detail.contest.status}`,
        orderbookEntries: detail.orderbook.length,
      },
      { json: false },
    );
  });
