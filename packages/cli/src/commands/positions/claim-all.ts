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
import { wei6ToDecimalUSDC } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  emitJsonFailure,
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
    const chainId = client.chainId();
    const wantJson = opts.json === true;
    let signerAddress: Hex | null = null;

    try {
    const result = await client.positions.claimAll({
      ...(opts.address !== undefined ? { address: opts.address } : {}),
      opts: { dryRun },
    });

    if (wantJson) {
      signerAddress = requiresSigner
        ? (((await client.signer().getAddress()) as string).toLowerCase() as Hex)
        : null;
      writeAgentEnvelope(
        toClaimAllAgentEnvelope(result, {
          chainId,
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
    } catch (err) {
      // Hermes PR-6 scope: when claimAll itself throws (e.g. API
      // fetch fails before any tx is dispatched), emit a failure
      // envelope. Per-entry failures are NOT thrown by the SDK —
      // they land in result.entries[].success and surface as failed
      // effects in the success-envelope path above.
      if (wantJson) {
        emitJsonFailure({
          action: 'claim-all',
          stage: dryRun ? 'dry-run' : 'execute',
          chainId,
          wallet: signerAddress,
          walletRole: signerAddress !== null ? 'signer' : 'none',
          signer: signerAddress,
          error: err,
        });
        process.exit(1);
      }
      throw err;
    }
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
 *   execute: stage 'execute', effects per actual on-chain tx (per
 *            entry: 0–2 confirmed + optional failure marker).
 *
 * Payout shoulder uses the SDK's exact `totals.totalPayoutWei6`
 * bigint string — preserves wei6 precision (Hermes PR-70 review).
 *
 * `envelope.ok` is `true` for any cleanly-produced envelope: dry-run
 * plans, live no-op sweeps, and successful live sweeps. `false` only
 * when at least one execute entry failed (`totals.failed > 0`). The
 * SDK's `result.success` is dry-run-aware (intentionally `false` for
 * dry-runs) and so doesn't map to envelope-level success.
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

  // Hermes PR-70 blocker 1: envelope-level ok is "command produced a
  // valid response" — not "domain-level claimed at least one thing".
  // Dry-run + live no-op are normal successful completions; only
  // live execute with failed entries flips ok to false.
  const ok = result.totals.failed === 0;

  return buildAgentEnvelope<ClaimAllPayload>({
    ok,
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
 * effects. Hermes PR-70 blocker 2: every recorded txHash is a
 * confirmed-successful tx because the SDK's chain client throws on
 * a reverted receipt before pushing — so collapsing per-tx status
 * to `entry.success` would mislabel a successful earlier tx as
 * reverted when a later step fails.
 *
 * Each tx in entry.txHashes → confirmed effect.
 * Entry failed (`!entry.success`) + step incomplete → emit an
 * additional failure effect for the step that didn't land. The
 * effect carries `errorCode` from the OspexError code; if the
 * underlying OspexChainError attached a `txHash` (a reverted send),
 * include it with `status: 'reverted'`.
 */
function buildClaimAllEffects(result: ClaimAllResult): AgentEffect[] {
  const out: AgentEffect[] = [];
  for (const entry of result.entries) {
    // 1. Recorded txs are confirmed-successful.
    for (let i = 0; i < entry.txHashes.length; i++) {
      const txHash = entry.txHashes[i] as string;
      const isSettle = entry.bucket === 'pendingSettle' && i === 0;
      out.push({
        type: 'transaction',
        purpose: isSettle ? 'settle-speculation' : 'claim-position',
        ok: true,
        txHash: txHash as Hex,
        status: 'confirmed',
      });
    }
    // 2. If the entry failed, the failure is the step AFTER the last
    //    recorded txHash. Emit one failure effect for it.
    if (!entry.success) {
      const completedSteps = entry.txHashes.length;
      const totalSteps = entry.bucket === 'pendingSettle' ? 2 : 1;
      if (completedSteps < totalSteps) {
        const failedStepIsSettle =
          entry.bucket === 'pendingSettle' && completedSteps === 0;
        const errAsChain = entry.error as
          | { code?: string; txHash?: string }
          | undefined;
        const failureEffect: AgentEffect = {
          type: 'transaction',
          purpose: failedStepIsSettle ? 'settle-speculation' : 'claim-position',
          ok: false,
        };
        if (errAsChain?.txHash !== undefined) {
          failureEffect.txHash = errAsChain.txHash as Hex;
          failureEffect.status = 'reverted';
        }
        if (errAsChain?.code !== undefined) {
          failureEffect.errorCode = errAsChain.code;
        }
        out.push(failureEffect);
      }
    }
  }
  return out;
}

/**
 * Aggregate payout shoulder. Hermes PR-70 blocker 3: use the SDK's
 * exact `totals.totalPayoutWei6` bigint string — going through
 * `totalPayoutUSDC` (a JS `number`) loses precision past
 * `Number.MAX_SAFE_INTEGER` and even on values like 1000000000000000001
 * which round to 1e18 (dropping one wei6 unit). For a financial
 * shoulder, exact wei6 is non-negotiable.
 *
 * profit and totalReturn are both the swept total — at claim time
 * the risk was settled long ago, so payout IS profit IS return.
 */
function buildClaimAllPayout(result: ClaimAllResult): AgentPayout | null {
  if (result.entries.length === 0) return null;
  const wei6Str = result.totals.totalPayoutWei6;
  const amount: PerspectiveAmount = {
    wei6: wei6Str,
    usdc: wei6ToDecimalUSDC(BigInt(wei6Str)),
  };
  return { profit: amount, totalReturn: amount };
}
