import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
  maker: z.string().optional(),
  scorer: z.string().optional(),
  contestId: z.string().optional(),
  status: z.string().optional(),
  includeInvalidated: z.boolean().optional(),
  includeExpired: z.boolean().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const commitmentsListCommand = new Command('list')
  .description('List open commitments (optionally filtered).')
  .option('--json', 'output as JSON')
  .option('--maker <address>', 'filter by maker address')
  .option('--scorer <address>', 'filter by scorer contract address')
  .option('--contest-id <id>', 'filter by contest id')
  .option('--status <list>', 'comma-separated statuses (default: open,partially_filled)')
  .option('--include-invalidated', 'include nonce-invalidated commitments')
  .option('--include-expired', 'include expired commitments')
  .option('--limit <n>', 'page size (1-1000)')
  .option('--offset <n>', 'pagination offset')
  .action(async (opts) => {
    const parsed = optionsSchema.parse(opts);
    const client = await getClient({ requiresSigner: false });
    const listOpts: Parameters<typeof client.commitments.list>[0] = {};
    if (parsed.maker !== undefined) listOpts.maker = parsed.maker;
    if (parsed.scorer !== undefined) listOpts.scorer = parsed.scorer;
    if (parsed.contestId !== undefined) listOpts.contestId = parsed.contestId;
    if (parsed.status !== undefined) listOpts.status = parsed.status;
    if (parsed.includeInvalidated !== undefined) {
      listOpts.includeInvalidated = parsed.includeInvalidated;
    }
    if (parsed.includeExpired !== undefined) {
      listOpts.includeExpired = parsed.includeExpired;
    }
    if (parsed.limit !== undefined) listOpts.limit = parsed.limit;
    if (parsed.offset !== undefined) listOpts.offset = parsed.offset;
    const commitments = await client.commitments.list(listOpts);
    if (parsed.json === true) {
      formatOutput(commitments, { json: true });
      return;
    }
    formatOutput(
      commitments.map((c) => ({
        hash: c.commitmentHash.slice(0, 10) + '…',
        maker: c.maker,
        contest: c.contestId ?? '-',
        market: c.marketType ?? '-',
        line: c.lineTicks ?? '-',
        side: c.positionType === 0 ? 'upper' : c.positionType === 1 ? 'lower' : '-',
        odds: c.oddsTick ?? '-',
        risk: c.riskAmount,
        remaining: c.remainingRiskAmount,
        status: c.status,
      })),
      { json: false },
    );
  });
