/**
 * `ospex commitments cancel <hash> [--also-onchain]`
 *
 * Default: off-chain cancel via DELETE /v1/commitments/:hash. Marks the
 * row cancelled in the API so it stops surfacing in the open book, but
 * does NOT prevent a taker who already holds the signed payload from
 * matching on chain.
 *
 * `--also-onchain`: after the DELETE succeeds, additionally call
 * `MatchingModule.cancelCommitment(commitment)` on chain so the cancel
 * is authoritative. This is the safest pattern (per
 * `ospex-core-api/docs/CANCEL_FLOW.md`) — strongly recommended any time
 * the maker truly wants to revoke an unmatched commitment.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexChainError } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { polygonscanTxUrl } from '../../lib/explorer.js';
import { getClient } from '../../lib/client.js';
import type { Hex } from '@ospex/sdk';

const optionsSchema = z.object({
  alsoOnchain: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const commitmentsCancelCommand = new Command('cancel')
  .description('Off-chain cancel via signed DELETE. Add --also-onchain for an authoritative cancel.')
  .argument('<hash>', '0x-prefixed 32-byte commitment hash')
  .option(
    '--also-onchain',
    'after the DELETE, also call MatchingModule.cancelCommitment on chain (recommended)',
  )
  .option('--json', 'output as JSON')
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const hash = hashArg as Hex;
    const wantsOnchain = opts.alsoOnchain === true;

    // The off-chain DELETE only needs a signer (for the EIP-712 cancel
    // signature). The on-chain leg additionally needs an rpcUrl.
    const client = await getClient({
      requiresSigner: true,
      requiresChain: wantsOnchain,
    });

    const offChainResult = await client.commitments.cancel(hash);

    if (!wantsOnchain) {
      if (opts.json === true) {
        formatOutput(offChainResult, { json: true });
        return;
      }
      formatOutput({ ok: offChainResult.ok, hash }, { json: false });
      return;
    }

    let onChainResult;
    try {
      onChainResult = await client.commitments.cancelOnchain(hash);
    } catch (err) {
      if (err instanceof OspexChainError && err.reason === 'NotCommitmentMaker') {
        process.stderr.write(
          'On-chain cancel reverted: signer is not the commitment maker. ' +
            'Off-chain DELETE already applied; the row is hidden from the relay but the taker is not blocked.\n',
        );
      }
      throw err;
    }
    const explorerUrl = polygonscanTxUrl(client.chainId(), onChainResult.txHash);

    const summary = {
      hash,
      offChainOk: offChainResult.ok,
      txHash: onChainResult.txHash,
      blockNumber: onChainResult.receipt.blockNumber.toString(),
      explorer: explorerUrl,
    };
    formatOutput(summary, { json: opts.json === true });
  });
