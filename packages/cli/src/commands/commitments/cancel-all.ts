/**
 * `ospex commitments cancel-all --contest-id <id> --scorer <addr> --line <ticks>
 *                              [--new-min-nonce <n>] [--dry-run]`
 *
 * Bulk-invalidate every one of the maker's open commitments on a single
 * speculation by raising the on-chain nonce floor. Friendly wrapper over
 * `MatchingModule.raiseMinNonce`.
 *
 * `--dry-run` lists the maker's currently-matchable commitments on the
 * speculation and prints a count without sending a tx — useful for
 * sanity-checking before the gas spend.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexChainError } from '@ospex/sdk';
import type { Hex } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { polygonscanTxUrl } from '../../lib/explorer.js';
import { getClient } from '../../lib/client.js';

const optionsSchema = z.object({
  contestId: z.string().regex(/^[0-9]+$/, 'must be a non-negative integer'),
  scorer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address'),
  line: z.string().regex(/^-?[0-9]+$/, 'must be an int32'),
  newMinNonce: z.string().regex(/^[0-9]+$/, 'must be a non-negative integer').optional(),
  dryRun: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const commitmentsCancelAllCommand = new Command('cancel-all')
  .description(
    'Bulk-cancel every open commitment from this maker on one speculation by raising the nonce floor.',
  )
  .requiredOption('--contest-id <id>', 'contest id (uint256)')
  .requiredOption('--scorer <addr>', 'scorer module address')
  .requiredOption('--line <ticks>', 'line ticks (int32, 10× scale)')
  .option('--new-min-nonce <n>', 'override the computed default (must exceed current floor)')
  .option('--dry-run', 'count what would be invalidated; do not send a tx')
  .option('--json', 'output as JSON')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const contestId = BigInt(opts.contestId);
    const scorer = opts.scorer.toLowerCase() as Hex;
    const lineTicks = Number(opts.line);

    const client = await getClient({ requiresSigner: true, requiresChain: true });
    const maker = (await client.signer().getAddress()).toLowerCase() as Hex;

    if (opts.dryRun === true) {
      // Mirror the cancel-all targeting filter: open + partially_filled,
      // not nonce-invalidated, only this maker's rows on this speculation.
      const rows = (
        await client.commitments.list({
          maker,
          contestId: contestId.toString(),
          scorer,
          status: ['open', 'partially_filled'],
          limit: 1000,
        })
      ).filter((c) => c.lineTicks === lineTicks);
      const count = rows.length;
      if (opts.json === true) {
        formatOutput(
          {
            dryRun: true,
            invalidatedCount: count,
            commitments: rows.map((c) => ({
              hash: c.commitmentHash,
              status: c.status,
              nonce: c.nonce,
              riskAmount: c.riskAmount,
              remainingRiskAmount: c.remainingRiskAmount,
            })),
          },
          { json: true },
        );
        return;
      }
      formatOutput({ dryRun: true, invalidatedCount: count }, { json: false });
      if (count > 0) {
        process.stdout.write('\nWould invalidate:\n');
        formatOutput(
          rows.map((c) => ({
            hash: c.commitmentHash,
            status: c.status,
            nonce: c.nonce,
            remainingRisk: c.remainingRiskAmount,
          })),
          { json: false },
        );
      }
      return;
    }

    let result;
    try {
      result = await client.commitments.cancelAllOnSpeculation({
        contestId,
        scorer,
        lineTicks,
        ...(opts.newMinNonce !== undefined ? { newMinNonce: BigInt(opts.newMinNonce) } : {}),
      });
    } catch (err) {
      if (err instanceof OspexChainError && err.reason === 'NonceMustIncrease') {
        process.stderr.write(
          'Cancel-all reverted: newMinNonce must strictly exceed the current on-chain floor. ' +
            'Use `ospex commitments nonce-floor --maker <addr> ...` to read the current value.\n',
        );
      }
      throw err;
    }

    const explorerUrl = polygonscanTxUrl(client.chainId(), result.txHash);
    if (opts.json === true) {
      formatOutput(
        {
          txHash: result.txHash,
          blockNumber: result.receipt.blockNumber.toString(),
          newMinNonce: result.newMinNonce.toString(),
          invalidatedCount: result.invalidatedCount,
          explorer: explorerUrl,
        },
        { json: true },
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        blockNumber: result.receipt.blockNumber.toString(),
        newMinNonce: result.newMinNonce.toString(),
        invalidatedCount: result.invalidatedCount,
        explorer: explorerUrl,
      },
      { json: false },
    );
  });
