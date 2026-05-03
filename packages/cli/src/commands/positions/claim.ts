/**
 * `ospex claim <speculationId> --type <upper|lower>` — claim a single
 * settled position. Uses the configured signer + RPC.
 *
 * If the API surfaces this position as `pendingSettle` (its parent
 * speculation hasn't been settled yet), `claim` does NOT auto-settle —
 * the user explicitly chose `claim`. We surface a clear error pointing
 * at `ospex settle` or `ospex claim-all` instead.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexChainError } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';

const positionSchema = z.enum(['upper', 'lower', '0', '1']);
const optionsSchema = z.object({
  type: positionSchema,
  json: z.boolean().optional(),
});

function parsePosition(raw: string): 0 | 1 {
  const parsed = positionSchema.parse(raw);
  if (parsed === 'upper' || parsed === '0') return 0;
  return 1;
}

export const positionsClaimCommand = new Command('claim')
  .description('Claim a single settled position. Reverts if the parent speculation is not yet settled.')
  .argument('<speculationId>', 'speculation id (uint256)')
  .requiredOption('--type <upper|lower>', 'position side (upper = away/over, lower = home/under)')
  .option('--json', 'output as JSON')
  .action(async (speculationIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const speculationId = BigInt(speculationIdArg);
    const positionType = parsePosition(opts.type);

    const client = await getClient({ requiresSigner: true, requiresChain: true });

    let result;
    try {
      result = await client.positions.claim({ speculationId, positionType });
    } catch (err) {
      if (err instanceof OspexChainError && /NotSettled/i.test(err.message)) {
        process.stderr.write(
          'This position requires settlement first. Run `ospex settle ' +
            `${speculationIdArg}` +
            '` (or `ospex claim-all` to handle both steps automatically).\n',
        );
        throw err;
      }
      throw err;
    }

    if (opts.json === true) {
      formatOutput(
        {
          txHash: result.txHash,
          blockNumber: result.blockNumber.toString(),
          payoutWei6: result.payoutWei6.toString(),
          payoutUSDC: result.payoutUSDC,
        },
        { json: true },
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        blockNumber: result.blockNumber.toString(),
        payoutUSDC: result.payoutUSDC,
        payoutWei6: result.payoutWei6.toString(),
      },
      { json: false },
    );
  });
