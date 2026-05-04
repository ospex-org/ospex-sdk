/**
 * `ospex commitments cancel-onchain <hash>` — call
 * `MatchingModule.cancelCommitment(commitment)` on chain. Authoritative
 * cancel: blocks future matchCommitment attempts even from takers who
 * already hold the signed payload.
 *
 * Prints the txHash + Polygonscan link on success. The contract has no
 * `AlreadyCancelled` revert path, so calling this on an already-cancelled
 * commitment succeeds without changing state — be aware of that when
 * scripting against this command.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexChainError } from '@ospex/sdk';
import type { Hex } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { polygonscanTxUrl } from '../../lib/explorer.js';
import { getClient } from '../../lib/client.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const commitmentsCancelOnchainCommand = new Command('cancel-onchain')
  .description('On-chain cancel: call MatchingModule.cancelCommitment(commitment).')
  .argument('<hash>', '0x-prefixed 32-byte commitment hash')
  .option('--json', 'output as JSON')
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const hash = hashArg as Hex;

    const client = await getClient({ requiresSigner: true, requiresChain: true });

    let result;
    try {
      result = await client.commitments.cancelOnchain(hash);
    } catch (err) {
      if (err instanceof OspexChainError && err.reason === 'NotCommitmentMaker') {
        process.stderr.write(
          'Cancel reverted: signer is not the commitment maker. Only the original maker can cancel on chain.\n',
        );
      }
      throw err;
    }

    const explorerUrl = polygonscanTxUrl(client.chainId(), result.txHash);
    if (opts.json === true) {
      formatOutput(
        {
          txHash: result.txHash,
          commitmentHash: result.commitmentHash,
          blockNumber: result.receipt.blockNumber.toString(),
          explorer: explorerUrl,
        },
        { json: true },
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        commitmentHash: result.commitmentHash,
        blockNumber: result.receipt.blockNumber.toString(),
        explorer: explorerUrl,
      },
      { json: false },
    );
  });
