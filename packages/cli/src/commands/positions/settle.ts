/**
 * `ospex settle <speculationId>` — call SpeculationModule.settleSpeculation.
 *
 * Permissionless; useful for settling a position you hold (so you can
 * later claim) or for helping another holder finalize a speculation
 * they own a winning position on. Prints the resolved on-chain
 * winSide.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const positionsSettleCommand = addSignerOptions(
  new Command('settle')
    .description('Settle a speculation on-chain (permissionless). Required before any of its positions can be claimed.')
    .argument('<speculationId>', 'speculation id (uint256)')
    .option('--json', 'output as JSON'),
)
  .action(async (speculationIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const speculationId = BigInt(speculationIdArg);

    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });
    const result = await client.positions.settleSpeculation({ speculationId });

    if (opts.json === true) {
      formatOutput(
        {
          txHash: result.txHash,
          blockNumber: result.blockNumber.toString(),
          winSide: result.winSide,
        },
        { json: true },
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        blockNumber: result.blockNumber.toString(),
        winSide: result.winSide,
      },
      { json: false },
    );
  });
