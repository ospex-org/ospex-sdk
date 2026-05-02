/**
 * `ospex commitments approve <amount|max>` — approve PositionModule
 * (NOT MatchingModule) to spend USDC from the configured wallet. The
 * approval target is hard-coded by the SDK based on the configured
 * chain id, so the CLI just needs the amount.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';

const argSchema = z.union([z.literal('max'), z.string().regex(/^[0-9]+$/, 'amount must be an integer (USDC units, 6 decimals)')]);

export const commitmentsApproveCommand = new Command('approve')
  .description('Approve PositionModule for USDC. Pass `max` for unlimited or a USDC-units integer.')
  .argument('<amount>', 'USDC units (6 decimals) or "max"')
  .option('--json', 'output as JSON')
  .action(async (amountArg, opts) => {
    const amount = argSchema.parse(amountArg);
    const client = await getClient({ requiresSigner: true, requiresChain: true });
    const result = await client.commitments.approve(amount === 'max' ? 'max' : BigInt(amount));
    if (opts.json === true) {
      formatOutput(result, { json: true });
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        amount: amount === 'max' ? '(uint256 max)' : result.amount.toString(),
        spender: result.spender,
        token: result.token,
        status: result.receipt.status,
        blockNumber: result.receipt.blockNumber.toString(),
      },
      { json: false },
    );
  });
