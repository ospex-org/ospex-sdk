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
import type {
  AgentEffect,
  AgentEnvelope,
  AgentPayout,
  ChainId,
  Hex,
  OspexClient,
  PerspectiveAmount,
} from '@ospex/sdk';
import { usdcDecimalToWei6 } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';

const optionsSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 0x-prefixed 20-byte hex string').optional(),
  dryRun: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const positionsClaimAllCommand = addSignerOptions(
  new Command('claim-all')
    .description('Sweep all settle + claim actions for a wallet.')
    .option('--address <addr>', 'wallet to sweep (defaults to the configured signer\'s address)')
    .option('--dry-run', 'print the action plan without sending txs')
    .option('--json', 'output as JSON (default: human-readable summary)'),
)
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const dryRun = opts.dryRun === true;

    const requiresSigner = !dryRun || opts.address === undefined;
    const requiresChain = !dryRun;
    const client = await getClient({ requiresSigner, requiresChain, signerIntent });

    const result = await client.positions.claimAll({
      ...(opts.address !== undefined ? { address: opts.address } : {}),
      opts: { dryRun },
    });

    if (opts.json === true) {
      const signerAddress = requiresSigner
        ? (((await client.signer().getAddress()) as string).toLowerCase() as Hex)
        : null;
      writeAgentEnvelope(
        toClaimAllAgentEnvelope(result, {
          chainId: client.chainId(),
          signerAddress,
          dryRun,
        }),
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

// ── v1 → v2 envelope transform ──────────────────────────────────────

export type ClaimAllResult = Awaited<
  ReturnType<OspexClient['positions']['claimAll']>
>;

export interface ClaimAllPayload {
  address: string;
  dryRun: boolean;
  success: boolean;
  totals: ClaimAllResult['totals'];
  entries: Array<{
    positionId: string;
    speculationId: string;
    bucket: string;
    description: string;
    success: boolean;
    txHashes: string[];
    payoutUSDC: number | undefined;
    payoutWei6: string | undefined;
    winSide: string | undefined;
    error: string | undefined;
  }>;
}

export interface ToClaimAllEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex | null;
  dryRun: boolean;
}

/**
 * Wrap a `claimAll` result in the v2 envelope. Per spec §3.1:
 *   dry-run: stage 'dry-run', no effects, requiresSignature/Transaction true
 *   execute: stage 'execute', one transaction effect per tx across all
 *            entries (chronological — entries iterate in order, txs
 *            within an entry are settle-then-claim for pendingSettle).
 *
 * Payout shoulder aggregates the totals — agents reading top-level
 * `payout.profit.usdc` see the swept total without scanning entries.
 *
 * `envelope.ok` mirrors `result.success` (true iff every entry's
 * action(s) succeeded).
 */
export function toClaimAllAgentEnvelope(
  result: ClaimAllResult,
  args: ToClaimAllEnvelopeArgs,
): AgentEnvelope<ClaimAllPayload> {
  const subjectAddress = result.address.toLowerCase() as Hex;
  // Wallet is the signer (the one being asked to sign each tx).
  // Subject (--address) goes in payload. For self-sweep they're
  // the same.
  const wallet = args.signerAddress;
  const effects: AgentEffect[] = args.dryRun
    ? []
    : buildClaimAllEffects(result);
  const payout = buildClaimAllPayout(result);

  return buildAgentEnvelope<ClaimAllPayload>({
    ok: result.success,
    action: 'claim-all',
    stage: args.dryRun ? 'dry-run' : 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet,
    walletRole: wallet !== null ? 'signer' : 'none',
    signer: wallet,
    requiresSignature: args.dryRun,
    requiresTransaction: args.dryRun,
    payout,
    effects,
    payload: {
      address: subjectAddress,
      dryRun: args.dryRun,
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
  });
}

/**
 * Flatten claim-all entries into a chronological list of transaction
 * effects. For each entry the txHashes are ordered (settle-first for
 * pendingSettle, then claim); top-level entries are themselves
 * processed in the SDK's order. We don't have per-tx block numbers
 * or per-tx success — entry.success is the aggregate. Mark each tx
 * with the entry's outcome; a future SDK enrichment could surface
 * per-tx receipts.
 */
function buildClaimAllEffects(result: ClaimAllResult): AgentEffect[] {
  const out: AgentEffect[] = [];
  for (const entry of result.entries) {
    for (let i = 0; i < entry.txHashes.length; i++) {
      const txHash = entry.txHashes[i] as string;
      const isSettle = entry.bucket === 'pendingSettle' && i === 0;
      out.push({
        type: 'transaction',
        purpose: isSettle ? 'settle-speculation' : 'claim-position',
        ok: entry.success,
        txHash: txHash as Hex,
        status: entry.success ? 'confirmed' : 'reverted',
      });
    }
  }
  return out;
}

/**
 * Aggregate payout shoulder from claim-all totals. profit and
 * totalReturn are both the swept total — at claim time the risk
 * was settled long ago, so payout IS profit IS return.
 */
function buildClaimAllPayout(result: ClaimAllResult): AgentPayout | null {
  if (result.entries.length === 0) return null;
  const totalUsdcStr = result.totals.totalPayoutUSDC.toFixed(6);
  let totalWei6: bigint;
  try {
    totalWei6 = usdcDecimalToWei6(totalUsdcStr);
  } catch {
    return null;
  }
  const amount: PerspectiveAmount = {
    wei6: totalWei6.toString(),
    usdc: totalUsdcStr,
  };
  return { profit: amount, totalReturn: amount };
}
