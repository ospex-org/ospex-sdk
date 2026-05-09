/**
 * `ospex commitments show <hash-or-prefix>` — single-row lookup. Accepts
 * either the full EIP-712 hash OR a unique 0x-prefixed hex prefix
 * (≥ 8 hex chars after 0x). The prefix path resolves over ALL statuses
 * (`status: 'any'`) — `show` is a read, no constraint on whether the
 * commitment is still live.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({ json: z.boolean().optional() });

export const commitmentsShowCommand = new Command('show')
  .description('Show a single commitment by full hash or unique 0x-prefixed prefix (≥ 8 hex chars).')
  .argument('<hash-or-prefix>', 'full commitment hash, or unique 0x-prefixed hex prefix')
  .option('--json', 'output as JSON')
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });
    // 'any' status — show is a read, resolves cancelled/expired/invalidated rows too.
    const commitment = await client.commitments.resolveByPrefix(hashArg, {
      status: 'any',
    });
    if (commitment.commitmentHash.toLowerCase() !== hashArg.toLowerCase()) {
      process.stderr.write(`Resolved ${hashArg} → ${commitment.commitmentHash}\n`);
    }

    if (opts.json === true) {
      formatOutput(commitment, { json: true });
      return;
    }
    formatOutput(
      {
        hash: commitment.commitmentHash,
        maker: commitment.maker,
        contestId: commitment.contestId ?? '-',
        scorer: commitment.scorer ?? '-',
        market: commitment.marketType ?? '-',
        line: commitment.lineTicks ?? '-',
        side: commitment.positionType === 0 ? 'upper' : commitment.positionType === 1 ? 'lower' : '-',
        odds: commitment.oddsTick ?? '-',
        risk: commitment.riskAmount,
        filled: commitment.filledRiskAmount,
        remaining: commitment.remainingRiskAmount,
        nonce: commitment.nonce,
        expiry: commitment.expiry ?? '-',
        speculationKey: commitment.speculationKey ?? '-',
        status: commitment.status,
        createdAt: commitment.createdAt,
      },
      { json: false },
    );
  });
