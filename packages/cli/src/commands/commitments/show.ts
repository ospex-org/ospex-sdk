/**
 * `ospex commitments show <hash>` — single-row lookup by EIP-712
 * commitment hash. Thin wrapper around `client.commitments.get(hash)`,
 * which itself wraps `GET /v1/commitments/:hash`.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';
import type { Hex } from '@ospex/sdk';

const optionsSchema = z.object({ json: z.boolean().optional() });
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export const commitmentsShowCommand = new Command('show')
  .description('Show a single commitment by EIP-712 hash.')
  .argument('<hash>', '0x-prefixed 32-byte commitment hash')
  .option('--json', 'output as JSON')
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    if (!HASH_PATTERN.test(hashArg)) {
      throw new Error('hash must be a 0x-prefixed 32-byte hex string');
    }
    const client = await getClient({ requiresSigner: false });
    const commitment = await client.commitments.get(hashArg as Hex);

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
