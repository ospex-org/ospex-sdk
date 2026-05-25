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
  AgentWarning,
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
import {
  COMPLETE_CLAIM_ALL,
  VERIFY_POSITION_STATUS,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
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
        process.stdout.write(
          `${tag} ✓ ${e.description} → payout ${payout} (txs: ${txList}${winSide})${settleNote(e.steps)}\n`,
        );
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
          nextCommands: deriveRemediationNextCommands(err, chainId),
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
    steps: ClaimAllResult['entries'][number]['steps'];
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
  const warnings: AgentWarning[] = args.dryRun ? [] : buildClaimAllWarnings(result);
  const payout = buildClaimAllPayout(result);

  // Hermes PR-70 blocker 1: envelope-level ok is "command produced a
  // valid response" — not "domain-level claimed at least one thing".
  // Dry-run + live no-op are normal successful completions; only
  // live execute with failed entries flips ok to false.
  const ok = result.totals.failed === 0;

  // nextCommands: dry-run suggests completing via execute form;
  // live execute suggests verifying the new position status. Subject
  // address (result.address) is what the user cares about; signer
  // executes but the data being inspected belongs to the subject.
  const nextCommands = args.dryRun
    ? [COMPLETE_CLAIM_ALL.build({ address: subjectAddress })]
    : [VERIFY_POSITION_STATUS.build({ address: subjectAddress })];

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
    warnings,
    effects,
    nextCommands,
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
        steps: e.steps,
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
 * effects, driven by each entry's explicit `steps[]` record — one
 * effect per tx the SDK actually sent. There is no re-derivation of
 * "was this a settle or a claim?" from bucket+index: a skipped or
 * recovered settle sends no tx (it surfaces as an info warning, not an
 * effect), so the index of a `pendingSettle` entry's lone claim tx is
 * no longer load-bearing. This is what previously mislabeled a
 * skipped-settle entry's claim as a settle.
 *
 *   step 'sent'   → confirmed transaction effect (settle / claim).
 *   step 'failed' → failed effect; if it reverted on-chain with a known
 *                   hash, `status: 'reverted'` + the hash.
 *   step skipped/recovered → no effect (info warning instead).
 *
 * Fallback: if an entry failed but recorded no typed failure step
 * (e.g. an unrecognized future `txParams.method` threw before any
 * step), emit one generic failure effect so the failure isn't dropped.
 */
function buildClaimAllEffects(result: ClaimAllResult): AgentEffect[] {
  const out: AgentEffect[] = [];
  for (const entry of result.entries) {
    let sawFailureEffect = false;
    for (const step of entry.steps) {
      const purpose = step.name === 'settleSpeculation' ? 'settle-speculation' : 'claim-position';
      if (step.outcome === 'sent') {
        out.push({
          type: 'transaction',
          purpose,
          ok: true,
          txHash: step.txHash as Hex,
          status: 'confirmed',
        });
      } else if (step.outcome === 'failed') {
        sawFailureEffect = true;
        const eff: AgentEffect = { type: 'transaction', purpose, ok: false };
        if (step.txHash !== undefined) {
          eff.txHash = step.txHash as Hex;
          eff.status = 'reverted';
        }
        if (step.errorCode !== undefined) eff.errorCode = step.errorCode;
        out.push(eff);
      } else if (step.outcome === 'recoveredAlreadySettled' && step.txHash !== undefined) {
        // The entry recovered, but this wallet had already broadcast a
        // settle tx that reverted on inclusion (lost the race) — gas was
        // spent. Surface it as a reverted effect so the audit trail
        // isn't silent about it. (Pre-flight skip / pre-send recovery
        // carry no txHash and emit no effect — only the info warning.)
        out.push({ type: 'transaction', purpose, ok: false, txHash: step.txHash as Hex, status: 'reverted' });
      }
      // skippedAlreadySettled, and recovered with no tx → no effect
      // (surfaced as an info warning instead).
    }
    if (!entry.success && !sawFailureEffect) {
      const errAsChain = entry.error as { code?: string; txHash?: string } | undefined;
      const eff: AgentEffect = { type: 'transaction', purpose: 'claim-position', ok: false };
      if (errAsChain?.txHash !== undefined) {
        eff.txHash = errAsChain.txHash as Hex;
        eff.status = 'reverted';
      }
      if (errAsChain?.code !== undefined) eff.errorCode = errAsChain.code;
      out.push(eff);
    }
  }
  return out;
}

/**
 * Derive info-severity warnings for the projection-aware recoveries —
 * the structured evidence that a settle was short-circuited. These are
 * NOT failures: the entry succeeded; the warning just records that the
 * settle tx was skipped (it was already settled on a pre-flight read)
 * or recovered (a concurrent settle won the race). Agents switch on
 * `code`; `details` carries the resolved `winSide` and identifiers.
 */
function buildClaimAllWarnings(result: ClaimAllResult): AgentWarning[] {
  const out: AgentWarning[] = [];
  for (const entry of result.entries) {
    for (const step of entry.steps) {
      if (step.name !== 'settleSpeculation') continue;
      if (step.outcome === 'skippedAlreadySettled') {
        out.push({
          code: 'settle-skipped-already-settled',
          message: `Speculation ${entry.speculationId} was already settled on-chain — skipped the duplicate settle and proceeded to claim.`,
          severity: 'info',
          details: {
            speculationId: entry.speculationId,
            positionId: entry.positionId,
            winSide: step.winSide,
          },
        });
      } else if (step.outcome === 'recoveredAlreadySettled') {
        out.push({
          code: 'projection-lag-recovered',
          message: `Speculation ${entry.speculationId} was settled by a concurrent transaction — recovered from the duplicate-settle revert and proceeded to claim.`,
          severity: 'info',
          details: {
            speculationId: entry.speculationId,
            positionId: entry.positionId,
            winSide: step.winSide,
          },
        });
      }
    }
  }
  return out;
}

/** Human-readable annotation for a settle that was short-circuited
 * (idempotent recovery). Empty for a normal settle / claimable entry. */
function settleNote(steps: ClaimAllResult['entries'][number]['steps']): string {
  const settle = steps.find((s) => s.name === 'settleSpeculation');
  if (settle?.outcome === 'skippedAlreadySettled') return ' [settle skipped — already settled]';
  if (settle?.outcome === 'recoveredAlreadySettled') {
    return ' [settle recovered — already settled by a concurrent tx]';
  }
  return '';
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
