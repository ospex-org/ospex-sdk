import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  MIN_PREFIX_HEX_LEN,
  tickToAmericanOdds,
  tickToDecimalOdds,
  wei6ToDecimalUSDC,
} from '@ospex/sdk';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
  maker: z.string().optional(),
  scorer: z.string().optional(),
  contestId: z.string().optional(),
  speculation: z.string().optional(),
  status: z.string().optional(),
  includeInvalidated: z.boolean().optional(),
  includeExpired: z.boolean().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  fullHash: z.boolean().optional(),
});

export const commitmentsListCommand = new Command('list')
  .description('List open commitments (optionally filtered).')
  .option('--json', 'output as JSON')
  .option('--maker <address>', 'filter by maker address')
  .option('--scorer <address>', 'filter by scorer contract address')
  .option('--contest-id <id>', 'filter by contest id')
  .option('--speculation <id>', 'filter to commitments on a single speculation')
  .option('--status <list>', 'comma-separated statuses (default: open,partially_filled)')
  .option('--include-invalidated', 'include nonce-invalidated commitments')
  .option('--include-expired', 'include expired commitments')
  .option('--limit <n>', 'page size (1-1000)')
  .option('--offset <n>', 'pagination offset')
  .option(
    '--full-hash',
    'human output: show the full 32-byte hash instead of the 0x+8hex truncated form. JSON output always includes the full hash.',
  )
  .action(async (opts) => {
    const parsed = optionsSchema.parse(opts);
    const client = await getClient({ requiresSigner: false });
    const listOpts: Parameters<typeof client.commitments.list>[0] = {};
    if (parsed.maker !== undefined) listOpts.maker = parsed.maker;
    if (parsed.scorer !== undefined) listOpts.scorer = parsed.scorer;
    if (parsed.contestId !== undefined) listOpts.contestId = parsed.contestId;
    if (parsed.speculation !== undefined) listOpts.speculationId = parsed.speculation;
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
        hash: parsed.fullHash === true
          ? c.commitmentHash
          : c.commitmentHash.slice(0, 2 + MIN_PREFIX_HEX_LEN) + '…',
        maker: c.maker,
        contest: c.contestId ?? '-',
        market: c.marketType ?? '-',
        line: c.lineTicks ?? '-',
        side: c.positionType === 0 ? 'upper' : c.positionType === 1 ? 'lower' : '-',
        odds:
          c.oddsTick !== null
            ? `${tickToDecimalOdds(c.oddsTick)} / ${tickToAmericanOdds(c.oddsTick)}`
            : '-',
        risk: formatUSDC(c.riskAmount),
        remaining: formatUSDC(c.remainingRiskAmount),
        status: c.status,
      })),
      { json: false },
    );
  });

function formatUSDC(wei6Str: string): string {
  try {
    return wei6ToDecimalUSDC(BigInt(wei6Str));
  } catch {
    // Defensive: if a row arrives with a non-numeric riskAmount string,
    // fall through to the raw value rather than crashing the table.
    return wei6Str;
  }
}
