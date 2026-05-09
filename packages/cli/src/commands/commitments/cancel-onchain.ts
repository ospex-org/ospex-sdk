/**
 * `ospex commitments cancel-onchain <hash-or-prefix>` — call
 * `MatchingModule.cancelCommitment(commitment)` on chain. Authoritative
 * cancel: blocks future matchCommitment attempts even from takers who
 * already hold the signed payload.
 *
 * Prints the txHash + Polygonscan link on success. The contract has no
 * `AlreadyCancelled` revert path, so calling this on an already-cancelled
 * commitment succeeds without changing state — be aware of that when
 * scripting against this command.
 *
 * Accepts a full 32-byte hash OR a unique 0x-prefixed hex prefix (≥ 8
 * hex chars). On-chain cancel always requires API access to reconstruct
 * the commitment struct (full ABI fields needed for
 * MatchingModule.cancelCommitment), regardless of whether the input is
 * a full hash or a prefix.
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
  .description(
    'On-chain cancel: call MatchingModule.cancelCommitment(commitment). ' +
      'Accepts a full hash or a unique 0x-prefixed hex prefix (≥ 8 hex chars). ' +
      'Always requires API access to reconstruct the commitment struct.',
  )
  .argument('<hash-or-prefix>', 'full commitment hash, or unique 0x-prefixed hex prefix')
  .option('--json', 'output as JSON')
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);

    const client = await getClient({ requiresSigner: true, requiresChain: true });

    const commitment = await client.commitments.resolveByPrefix(hashArg, {
      status: ['open', 'partially_filled'],
    });
    const hash = commitment.commitmentHash as Hex;
    if (commitment.commitmentHash.toLowerCase() !== hashArg.toLowerCase()) {
      process.stderr.write(`Resolved ${hashArg} → ${commitment.commitmentHash}\n`);
    }

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
