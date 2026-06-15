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
 * is authoritative — strongly recommended any time the maker truly
 * wants to revoke an unmatched commitment.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexChainError } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  emitJsonFailure,
  emitJsonSuccess,
  errorToAgentError,
  networkForChainId,
} from '../../lib/agentEnvelope.js';
import {
  VERIFY_COMMITMENT,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { polygonscanTxUrl } from '../../lib/explorer.js';
import { getClient } from '../../lib/client.js';
import { sanitizeUntargetedMessage } from '../../lib/redact.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import type {
  AgentEffect,
  AgentEnvelope,
  ChainId,
  Commitment,
  Hex,
  OspexClient,
} from '@ospex/sdk';

const optionsSchema = z.object({
  alsoOnchain: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const commitmentsCancelCommand = addSignerOptions(
  new Command('cancel')
    .description(
      'Off-chain cancel via signed DELETE. Add --also-onchain for an authoritative cancel. ' +
        'Accepts a full hash or a unique 0x-prefixed hex prefix (≥ 8 hex chars).',
    )
    .argument('<hash-or-prefix>', 'full commitment hash, or unique 0x-prefixed hex prefix')
    .option(
      '--also-onchain',
      'after the DELETE, also call MatchingModule.cancelCommitment on chain (recommended)',
    )
    .option('--json', 'output as JSON'),
)
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const wantsOnchain = opts.alsoOnchain === true;
    const wantJson = opts.json === true;

    const client = await getClient({
      requiresSigner: true,
      requiresChain: wantsOnchain,
      signerIntent,
    });
    const chainId = client.chainId();
    let signerAddress: Hex | null = null;

    try {
    // Resolve the signer up-front so a failure envelope from the
    // catch below carries wallet/signer populated.
    signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;

    const commitment = await client.commitments.resolveByPrefix(hashArg, {
      status: ['open', 'partially_filled'],
    });
    const hash = commitment.commitmentHash as Hex;
    if (commitment.commitmentHash.toLowerCase() !== hashArg.toLowerCase()) {
      process.stderr.write(`Resolved ${hashArg} → ${commitment.commitmentHash}\n`);
    }

    const offChainResult = await client.commitments.cancel(hash);

    if (!wantsOnchain) {
      if (wantJson) {
        // emitJsonSuccess writes the envelope and sets the §6 exit code
        // (nonzero iff ok:false) — see lib/agentEnvelope.ts.
        emitJsonSuccess(
          toCancelOffchainAgentEnvelope(offChainResult, commitment, {
            chainId,
            // Non-null assertion: signerAddress was assigned at the
            // top of the try, before the work began.
            signerAddress: signerAddress as Hex,
            hash,
          }),
        );
        return;
      }
      formatOutput({ ok: offChainResult.ok, hash }, { json: false });
      return;
    }

    // --also-onchain: run the on-chain leg. Per spec §6 (partial-
    // success contract): if the off-chain leg succeeded but the
    // on-chain leg reverts, the v2 envelope MUST surface both phases
    // in effects[] and `ok: false`. We catch OspexChainError so we
    // can emit the envelope; other errors still re-throw.
    let onChainResult: Awaited<ReturnType<OspexClient['commitments']['cancelOnchain']>> | null = null;
    let onChainError: OspexChainError | null = null;
    try {
      onChainResult = await client.commitments.cancelOnchain({ hash });
    } catch (err) {
      if (err instanceof OspexChainError) {
        // "did not confirm" covers all three failure shapes — a pre-send
        // revert (e.g. NotCommitmentMaker, caught at estimateGas, no tx), an
        // inclusion revert (tx broadcast, reverted), and a receipt-wait
        // timeout (tx broadcast, may still land) — without over-claiming
        // "reverted" on a tx that might still confirm.
        process.stderr.write(
          'On-chain cancel did not confirm: ' +
            (err.reason === 'NotCommitmentMaker'
              ? 'signer is not the commitment maker. '
              : '') +
            'Off-chain DELETE already applied; the row is hidden from the relay but the taker is not blocked.\n',
        );
        // Capture the FULL typed error. `toCancelDualAgentEnvelope` routes it
        // through the shared `errorToAgentError` path (sanitizes the message,
        // walks the cause chain, and surfaces txHash / receiptStatus), and
        // derives the on-chain transaction effect from its txHash / receipt —
        // so an inclusion-revert no longer loses its hash, receipt status, or
        // cause chain (M7).
        onChainError = err;
      } else {
        throw err;
      }
    }

    // The on-chain leg may have landed a tx even when it failed (an inclusion
    // revert, or a broadcast whose receipt wait timed out). Prefer the success
    // result's hash, fall back to the error's, so the explorer link + payload
    // point at the real tx in those cases.
    const onChainTxHash = onChainResult?.txHash ?? onChainError?.txHash ?? null;

    if (wantJson) {
      const explorerUrl = onChainTxHash !== null
        ? polygonscanTxUrl(chainId, onChainTxHash)
        : null;
      // emitJsonSuccess writes the dual envelope AND sets the §6 exit code:
      // the dual envelope's `ok` is `effects.every(e => e.ok)`, so a
      // reverted/failed on-chain leg (onChainError !== null) makes ok:false →
      // exit 1, surfacing the partial failure to shell pipelines without
      // parsing the envelope (same outcome as the prior explicit exit, but
      // routed through the shared §6 helper).
      emitJsonSuccess(
        toCancelDualAgentEnvelope(
          { offChainResult, onChainResult, onChainError, explorer: explorerUrl },
          commitment,
          {
            chainId,
            signerAddress: signerAddress as Hex,
            hash,
          },
        ),
      );
      return;
    }

    if (onChainResult === null) {
      // Human mode: re-throw the original typed chain error so the user
      // sees the standard error surface (preserves txHash / receipt /
      // reason / cause rather than flattening to a bare message).
      throw onChainError ?? new OspexChainError('on-chain cancel failed');
    }
    const explorerUrl = polygonscanTxUrl(chainId, onChainResult.txHash);
    const summary = {
      hash,
      offChainOk: offChainResult.ok,
      txHash: onChainResult.txHash,
      blockNumber: onChainResult.receipt.blockNumber.toString(),
      explorer: explorerUrl,
    };
    formatOutput(summary, { json: false });
    } catch (err) {
      // Hermes PR-6 scope: catches the OFF-CHAIN failure case (when
      // client.commitments.cancel itself throws). The on-chain
      // partial-success path is handled inline above via
      // toCancelDualAgentEnvelope which preserves the off-chain
      // effects in its effects[] regardless of the on-chain outcome.
      if (wantJson) {
        emitJsonFailure({
          action: 'commitments.cancel',
          stage: 'execute',
          chainId,
          wallet: signerAddress,
          walletRole: 'signer',
          signer: signerAddress,
          // EIP-712 cancel-auth sig always required; on-chain tx only
          // when --also-onchain. The intent flags reflect the path
          // the failed run was attempting.
          requiresSignature: true,
          requiresTransaction: wantsOnchain,
          nextCommands: deriveRemediationNextCommands(err, chainId),
          error: err,
        });
        process.exit(1);
      }
      throw err;
    }
  });

// ── v1 → v2 envelope transforms ─────────────────────────────────────

export type CancelOffchainResult = Awaited<
  ReturnType<OspexClient['commitments']['cancel']>
>;
export type CancelOnchainResult = Awaited<
  ReturnType<OspexClient['commitments']['cancelOnchain']>
>;

export interface CancelOffchainPayload {
  hash: Hex;
  ok: boolean;
}

export interface CancelDualPayload {
  hash: Hex;
  offChainOk: boolean;
  /** Present whenever the on-chain leg broadcast a tx — confirmed, reverted, or broadcast-then-receipt-timeout. Null only on a pre-send failure. */
  txHash: string | null;
  /** Block number when a receipt was observed (confirmed / reverted); null otherwise. */
  blockNumber: string | null;
  explorer: string | null;
  /** Present iff the on-chain leg failed. The full structured detail (txHash / receiptStatus / causeChain) lives in the envelope's `errors[]`. */
  onChainError: { code: string; message: string } | null;
}

export interface ToCancelEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex;
  hash: Hex;
}

/**
 * Off-chain-only cancel. Records the EIP-712 signature + off-chain
 * write as effects so agents see both phases (even though they
 * happen in one SDK call).
 */
export function toCancelOffchainAgentEnvelope(
  result: CancelOffchainResult,
  commitment: Commitment,
  args: ToCancelEnvelopeArgs,
): AgentEnvelope<CancelOffchainPayload> {
  return buildAgentEnvelope<CancelOffchainPayload>({
    ok: result.ok,
    action: 'commitments.cancel',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    commitment,
    effects: [
      {
        type: 'eip712-signature',
        purpose: 'offchain-cancel',
        ok: result.ok,
      },
      {
        type: 'offchain-write',
        purpose: 'offchain-cancel',
        ok: result.ok,
      },
    ],
    nextCommands: [VERIFY_COMMITMENT.build({ hash: args.hash })],
    payload: { hash: args.hash, ok: result.ok },
  });
}

/**
 * Dual-phase cancel (off-chain DELETE + on-chain cancel tx). The
 * spec §6 example: a partial-success envelope where off-chain
 * succeeded but on-chain reverted MUST show both phases via
 * `effects[]` with per-effect `ok`. Top-level `envelope.ok` is the
 * AND of all phases.
 */
export interface CancelDualInputs {
  offChainResult: CancelOffchainResult;
  onChainResult: CancelOnchainResult | null;
  /**
   * The full typed error from the on-chain leg, when it failed. Carries
   * `txHash` / `receipt` / `cause` so the transaction effect and the
   * `errors[]` entry can reflect what actually happened on-chain (M7) —
   * an inclusion revert keeps its hash + `status:'reverted'`, a
   * receipt-wait timeout surfaces as `status:'submitted'`, a pre-send
   * failure carries neither.
   */
  onChainError: OspexChainError | null;
  explorer: string | null;
}

/**
 * Build the on-chain transaction effect from the on-chain leg's error.
 * Honest about what landed:
 *   - a mined receipt → `status` from `receipt.status` (`reverted` /
 *     `confirmed`) + txHash + blockNumber;
 *   - a txHash but no receipt (broadcast, receipt-wait timed out) →
 *     `status:'submitted'` + txHash (the tx MAY still confirm);
 *   - neither a receipt nor a txHash (a local preflight / `estimateGas`-local
 *     failure, OR a `sendRawTransaction` broadcast round-trip that errored) →
 *     no status, no txHash. An absent hash is NOT proof no tx was sent — a
 *     failed broadcast round-trip may still have reached a node; agents apply
 *     AGENT_CONTRACT §7's safe-retry rule rather than assuming nothing landed.
 */
function onChainErrorEffect(err: OspexChainError): AgentEffect {
  const effect: AgentEffect = {
    type: 'transaction',
    purpose: 'onchain-cancel',
    ok: false,
    errorCode: err.code,
  };
  if (typeof err.txHash === 'string') effect.txHash = err.txHash as Hex;
  if (err.receipt) {
    effect.blockNumber = err.receipt.blockNumber.toString();
    effect.status = err.receipt.status === 'success' ? 'confirmed' : 'reverted';
  } else if (typeof err.txHash === 'string') {
    effect.status = 'submitted';
  }
  return effect;
}

export function toCancelDualAgentEnvelope(
  inputs: CancelDualInputs,
  commitment: Commitment,
  args: ToCancelEnvelopeArgs,
): AgentEnvelope<CancelDualPayload> {
  const offOk = inputs.offChainResult.ok;
  const onTxOk =
    inputs.onChainResult !== null
      ? inputs.onChainResult.receipt.status === 'success'
      : false;
  const offSig: AgentEffect = {
    type: 'eip712-signature',
    purpose: 'offchain-cancel',
    ok: offOk,
  };
  const offWrite: AgentEffect = {
    type: 'offchain-write',
    purpose: 'offchain-cancel',
    ok: offOk,
  };
  const onChainEffect: AgentEffect | null =
    inputs.onChainResult !== null
      ? {
          type: 'transaction',
          purpose: 'onchain-cancel',
          ok: onTxOk,
          txHash: inputs.onChainResult.txHash as Hex,
          blockNumber: inputs.onChainResult.receipt.blockNumber.toString(),
          status: onTxOk ? 'confirmed' : 'reverted',
        }
      : inputs.onChainError !== null
        ? onChainErrorEffect(inputs.onChainError)
        : null;
  const effects: AgentEffect[] = [offSig, offWrite];
  if (onChainEffect !== null) effects.push(onChainEffect);
  // Surface the on-chain tx the error left behind (inclusion revert /
  // broadcast-then-timeout), falling back to null for a pre-send failure.
  const errorTxHash =
    typeof inputs.onChainError?.txHash === 'string' ? inputs.onChainError.txHash : null;
  const errorBlockNumber =
    inputs.onChainError?.receipt !== undefined
      ? inputs.onChainError.receipt.blockNumber.toString()
      : null;
  return buildAgentEnvelope<CancelDualPayload>({
    ok: effects.every((e) => e.ok),
    action: 'commitments.cancel',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    commitment,
    // Route through the shared mapper so the on-chain failure carries
    // details.txHash / receiptStatus / causeChain — not a flattened
    // {code,message} that drops the hash, receipt status, and cause (M7).
    errors:
      inputs.onChainError !== null
        ? [errorToAgentError(inputs.onChainError)]
        : [],
    effects,
    nextCommands: [VERIFY_COMMITMENT.build({ hash: args.hash })],
    payload: {
      hash: args.hash,
      offChainOk: offOk,
      txHash: inputs.onChainResult?.txHash ?? errorTxHash,
      blockNumber:
        inputs.onChainResult?.receipt.blockNumber.toString() ?? errorBlockNumber,
      explorer: inputs.explorer,
      onChainError:
        inputs.onChainError !== null
          ? {
              code: inputs.onChainError.code,
              message: sanitizeUntargetedMessage(inputs.onChainError.message),
            }
          : null,
    },
  });
}
