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
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import {
  VERIFY_COMMITMENT,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { polygonscanTxUrl } from '../../lib/explorer.js';
import { getClient } from '../../lib/client.js';
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
        signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;
        writeAgentEnvelope(
          toCancelOffchainAgentEnvelope(offChainResult, commitment, {
            chainId,
            signerAddress,
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
    let onChainError: { code: string; message: string } | null = null;
    try {
      onChainResult = await client.commitments.cancelOnchain(hash);
    } catch (err) {
      if (err instanceof OspexChainError) {
        process.stderr.write(
          'On-chain cancel reverted: ' +
            (err.reason === 'NotCommitmentMaker'
              ? 'signer is not the commitment maker. '
              : '') +
            'Off-chain DELETE already applied; the row is hidden from the relay but the taker is not blocked.\n',
        );
        onChainError = { code: err.code, message: err.message };
      } else {
        throw err;
      }
    }

    if (wantJson) {
      signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;
      const explorerUrl = onChainResult !== null
        ? polygonscanTxUrl(chainId, onChainResult.txHash)
        : null;
      writeAgentEnvelope(
        toCancelDualAgentEnvelope(
          { offChainResult, onChainResult, onChainError, explorer: explorerUrl },
          commitment,
          {
            chainId,
            signerAddress,
            hash,
          },
        ),
      );
      // Surface non-zero exit on partial failure so shell pipelines
      // catch it without parsing the envelope.
      if (onChainError !== null) process.exit(1);
      return;
    }

    if (onChainResult === null) {
      // Human mode: re-throw the original chain error so the user
      // sees the standard error surface.
      throw new OspexChainError(onChainError?.message ?? 'on-chain cancel failed');
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
  /** Present iff the on-chain leg landed (success or revert). */
  txHash: string | null;
  blockNumber: string | null;
  explorer: string | null;
  /** Present iff the on-chain leg failed before sending a tx (rare). */
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
  onChainError: { code: string; message: string } | null;
  explorer: string | null;
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
        ? {
            type: 'transaction',
            purpose: 'onchain-cancel',
            ok: false,
            errorCode: inputs.onChainError.code,
          }
        : null;
  const effects: AgentEffect[] = [offSig, offWrite];
  if (onChainEffect !== null) effects.push(onChainEffect);
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
    errors:
      inputs.onChainError !== null
        ? [inputs.onChainError]
        : [],
    effects,
    nextCommands: [VERIFY_COMMITMENT.build({ hash: args.hash })],
    payload: {
      hash: args.hash,
      offChainOk: offOk,
      txHash: inputs.onChainResult?.txHash ?? null,
      blockNumber:
        inputs.onChainResult?.receipt.blockNumber.toString() ?? null,
      explorer: inputs.explorer,
      onChainError: inputs.onChainError,
    },
  });
}
