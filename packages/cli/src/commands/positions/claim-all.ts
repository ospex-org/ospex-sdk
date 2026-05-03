/**
 * `ospex claim-all [--address <addr>] [--dry-run]` — sweep every
 * settle+claim a wallet is owed.
 *
 * `--dry-run` fetches the action plan from the API without sending any
 * txs, then prints a per-row table of what would be done. Useful for
 * verifying the plan before paying gas.
 *
 * Live runs: per-row progress is streamed to stdout, then a summary
 * (N successful, M failed) at the end. Per-position errors do not
 * abort the loop — each row's outcome is reported independently.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';

const optionsSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 0x-prefixed 20-byte hex string').optional(),
  dryRun: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const positionsClaimAllCommand = new Command('claim-all')
  .description('Sweep all settle + claim actions for a wallet.')
  .option('--address <addr>', 'wallet to sweep (defaults to the configured signer\'s address)')
  .option('--dry-run', 'print the action plan without sending txs')
  .option('--json', 'output as JSON (default: human-readable summary)')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const dryRun = opts.dryRun === true;

    // Dry-run only needs read paths — no signer required if --address is set.
    const requiresSigner = !dryRun || opts.address === undefined;
    const requiresChain = !dryRun;
    const client = await getClient({ requiresSigner, requiresChain });

    const result = await client.positions.claimAll({
      ...(opts.address !== undefined ? { address: opts.address } : {}),
      opts: { dryRun },
    });

    if (opts.json === true) {
      formatOutput(
        {
          address: result.address,
          dryRun,
          success: result.success,
          totals: result.totals,
          entries: result.entries.map((e) => ({
            positionId: e.positionId,
            speculationId: e.speculationId,
            bucket: e.bucket,
            description: e.description,
            success: e.success,
            txHashes: e.txHashes,
            payoutUSDC: e.payoutUSDC,
            payoutWei6: e.payoutWei6,
            winSide: e.winSide,
            error: e.error?.message,
          })),
        },
        { json: true },
      );
      return;
    }

    if (dryRun) {
      process.stdout.write(`\nDry run for ${result.address}:\n\n`);
    } else {
      process.stdout.write(`\nClaim sweep for ${result.address}:\n\n`);
    }

    if (result.entries.length === 0) {
      process.stdout.write('Nothing to do — no claimable or pending-settle positions.\n');
      return;
    }

    let i = 1;
    for (const e of result.entries) {
      const tag = `[${i}/${result.entries.length}]`;
      const stepCount = e.bucket === 'pendingSettle' ? 'settle + claim' : 'claim';
      if (dryRun) {
        const payout = e.payoutUSDC !== undefined ? `$${e.payoutUSDC.toFixed(2)}` : '?';
        process.stdout.write(`${tag} would ${stepCount}: ${e.description} (~${payout})\n`);
      } else if (e.success) {
        const payout = e.payoutUSDC !== undefined ? `$${e.payoutUSDC.toFixed(2)}` : 'unknown';
        const txList = e.txHashes.join(', ');
        const winSide = e.winSide ? `, winSide=${e.winSide}` : '';
        process.stdout.write(`${tag} ✓ ${e.description} → payout ${payout} (txs: ${txList}${winSide})\n`);
      } else {
        const reason = e.error?.message ?? 'unknown error';
        const txList = e.txHashes.length > 0 ? ` (partial txs: ${e.txHashes.join(', ')})` : '';
        process.stdout.write(`${tag} ✗ ${e.description} → ${reason}${txList}\n`);
      }
      i += 1;
    }

    process.stdout.write(
      `\nSummary: ${result.totals.claimed} succeeded, ${result.totals.failed} failed, ` +
        `total payout ${result.totals.totalPayoutUSDC.toFixed(2)} USDC.\n`,
    );
  });
