/**
 * `ospex settle <speculationId>` — idempotently settle a speculation.
 *
 * Routes through `client.positions.ensureSpeculationSettled` ("make this
 * settled"), NOT the strict `settleSpeculation` primitive. If the
 * speculation is already settled — common right after another wallet
 * settled it — this reports success instead of a scary `AlreadySettled`
 * revert. Three outcomes:
 *   - `settled`        — this call sent the settle tx.
 *   - `alreadySettled` — a pre-flight read found it closed; no tx sent.
 *   - `recovered`      — a concurrent settle won a race mid-flight (may
 *                        carry `revertedTxHash` if this wallet's settle
 *                        actually broadcast and reverted).
 *
 * Permissionless; useful for settling a position you hold (so you can
 * later claim) or helping another holder finalize a speculation they own
 * a winning position on. Prints the resolved on-chain winSide.
 *
 * The strict `client.positions.settleSpeculation` primitive (always
 * sends a tx; throws `AlreadySettled`) stays available for programmatic
 * callers that need the receipt of a settle they specifically sent.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type {
  AgentEffect,
  AgentEnvelope,
  AgentWarning,
  ChainId,
  Hex,
  OspexClient,
} from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  emitJsonFailure,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import {
  VERIFY_POSITION_STATUS,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const positionsSettleCommand = addSignerOptions(
  new Command('settle')
    .description('Settle a speculation on-chain (permissionless, idempotent). Required before any of its positions can be claimed.')
    .argument('<speculationId>', 'speculation id (uint256)')
    .option('--json', 'output as JSON'),
)
  .action(async (speculationIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const speculationId = BigInt(speculationIdArg);

    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });
    const chainId = client.chainId();
    const wantJson = opts.json === true;
    let signerAddress: Hex | null = null;

    try {
      const result = await client.positions.ensureSpeculationSettled({ speculationId });

      if (wantJson) {
        signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;
        writeAgentEnvelope(
          toSettleAgentEnvelope(result, {
            chainId,
            signerAddress,
            speculationId,
          }),
        );
        return;
      }

      // Human output, per outcome. `formatOutput` renders a single object
      // as aligned key/value lines (and skips empty fields).
      if (result.outcome === 'settled') {
        formatOutput(
          {
            outcome: result.outcome,
            winSide: result.winSide,
            txHash: result.txHash,
            blockNumber: result.blockNumber?.toString(),
          },
          { json: false },
        );
      } else if (result.outcome === 'alreadySettled') {
        formatOutput(
          {
            outcome: result.outcome,
            winSide: result.winSide,
            note: 'Already settled on-chain — no transaction sent.',
          },
          { json: false },
        );
      } else {
        formatOutput(
          {
            outcome: result.outcome,
            winSide: result.winSide,
            note: 'Settled by a concurrent transaction — recovered, no settle needed.',
            ...(result.revertedTxHash !== undefined ? { revertedTx: result.revertedTxHash } : {}),
          },
          { json: false },
        );
      }
    } catch (err) {
      if (wantJson) {
        emitJsonFailure({
          action: 'settle',
          stage: 'execute',
          chainId,
          wallet: signerAddress,
          walletRole: 'signer',
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

export type EnsureSettledResult = Awaited<
  ReturnType<OspexClient['positions']['ensureSpeculationSettled']>
>;

export interface SettlePayload {
  outcome: EnsureSettledResult['outcome'];
  /** The confirmed settle tx — present only when `outcome === 'settled'`. */
  txHash: string | null;
  blockNumber: string | null;
  /** A settle tx this wallet broadcast that then reverted (inclusion-time
   * race loss) — present only on `recovered` when one was broadcast. */
  revertedTxHash: string | null;
  winSide: EnsureSettledResult['winSide'];
  speculationId: string;
}

export interface ToSettleEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex;
  speculationId: bigint;
}

/**
 * Wrap an `ensureSpeculationSettled` result in the v2 envelope. Only
 * reached on a successful outcome (a genuine settle failure throws and is
 * handled by the command's catch → failure envelope), so `ok` is always
 * true here.
 *
 *   settled        → one confirmed settle-speculation effect.
 *   alreadySettled → no effect; a `settle-skipped-already-settled` info warning.
 *   recovered      → a `projection-lag-recovered` info warning, plus a
 *                    reverted settle-speculation effect IFF this wallet had
 *                    broadcast a settle that reverted (gas spent).
 */
export function toSettleAgentEnvelope(
  result: EnsureSettledResult,
  args: ToSettleEnvelopeArgs,
): AgentEnvelope<SettlePayload> {
  const effects: AgentEffect[] = [];
  const warnings: AgentWarning[] = [];

  if (result.outcome === 'settled') {
    const settledEffect: AgentEffect = {
      type: 'transaction',
      purpose: 'settle-speculation',
      ok: true,
      txHash: result.txHash as Hex,
      status: 'confirmed',
    };
    // exactOptionalPropertyTypes: omit blockNumber rather than set undefined.
    if (result.blockNumber !== undefined) settledEffect.blockNumber = result.blockNumber.toString();
    effects.push(settledEffect);
  } else if (result.outcome === 'alreadySettled') {
    warnings.push({
      code: 'settle-skipped-already-settled',
      message: `Speculation ${args.speculationId} was already settled on-chain — no transaction sent.`,
      severity: 'info',
      details: { speculationId: args.speculationId.toString(), winSide: result.winSide },
    });
  } else {
    if (result.revertedTxHash !== undefined) {
      effects.push({
        type: 'transaction',
        purpose: 'settle-speculation',
        ok: false,
        txHash: result.revertedTxHash as Hex,
        status: 'reverted',
      });
    }
    warnings.push({
      code: 'projection-lag-recovered',
      message: `Speculation ${args.speculationId} was settled by a concurrent transaction — recovered, no settle needed.`,
      severity: 'info',
      details: { speculationId: args.speculationId.toString(), winSide: result.winSide },
    });
  }

  return buildAgentEnvelope<SettlePayload>({
    ok: true,
    action: 'settle',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    warnings,
    effects,
    nextCommands: [VERIFY_POSITION_STATUS.build({ address: args.signerAddress })],
    payload: {
      outcome: result.outcome,
      txHash: result.outcome === 'settled' ? result.txHash ?? null : null,
      blockNumber: result.outcome === 'settled' ? result.blockNumber?.toString() ?? null : null,
      revertedTxHash: result.revertedTxHash ?? null,
      winSide: result.winSide,
      speculationId: args.speculationId.toString(),
    },
  });
}
