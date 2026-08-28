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
  emitJsonFailureAndExit,
  emitJsonSuccess,
  errorToAgentError,
  networkForChainId,
} from '../../lib/agentEnvelope.js';
import {
  REMEDIATE_CANCEL_ONCHAIN,
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
    // on-chain leg fails, the v2 envelope MUST surface both phases
    // in effects[] and `ok: false`.
    let onChainResult: Awaited<ReturnType<OspexClient['commitments']['cancelOnchain']>> | null = null;
    // Capture ANY error from the on-chain leg — not just OspexChainError — so a
    // non-chain failure never DROPS the already-completed off-chain DELETE from
    // the envelope (M6). The off-chain DELETE above set book_visible=false, and
    // `cancelOnchain({ commitment })` (below) narrows + reconstructs the struct
    // locally, so a row whose payload can't be reconstructed surfaces as an
    // OspexValidationError, not an OspexChainError. The dual envelope handles
    // both: a chain error keeps its txHash / receipt / reason (M7); any other
    // error degrades gracefully while still preserving the off-chain leg.
    let onChainError: unknown = null;
    try {
      // Pass the row we already resolved (while it was VISIBLE) — NOT { hash }.
      // The off-chain DELETE above set book_visible=false, so a re-fetch by hash
      // would return a redacted body and refuse; reconstructing from the in-hand
      // commitment cancels the on-chain leg without a self-defeating re-fetch.
      onChainResult = await client.commitments.cancelOnchain({ commitment });
    } catch (err) {
      onChainError = err;
      // "did not confirm" covers every failure shape — a pre-send revert
      // (e.g. NotCommitmentMaker, caught at estimateGas, no tx), an inclusion
      // revert (tx broadcast, reverted), a receipt-wait timeout (tx broadcast,
      // may still land), and a non-chain failure — without over-claiming
      // "reverted" on a tx that might still confirm. The off-chain DELETE
      // already landed, so point the operator at the standalone on-chain
      // cancel (which recovers the now-hidden row via owner-auth own-state).
      const notMaker = err instanceof OspexChainError && err.reason === 'NotCommitmentMaker';
      process.stderr.write(
        'On-chain cancel did not confirm: ' +
          (notMaker ? 'signer is not the commitment maker. ' : '') +
          'Off-chain DELETE already applied; the row is hidden from the relay but the ' +
          `taker is not blocked. Recover with: ospex commitments cancel-onchain ${hash}\n`,
      );
    }

    // The on-chain leg may have landed a tx even when it failed (an inclusion
    // revert, or a broadcast whose receipt wait timed out). Prefer the success
    // result's hash, fall back to the error's, so the explorer link + payload
    // point at the real tx in those cases. Only an OspexChainError carries a
    // txHash — a non-chain failure (validation / API) leaves it null.
    const onChainErrTxHash =
      onChainError instanceof OspexChainError && typeof onChainError.txHash === 'string'
        ? onChainError.txHash
        : null;
    const onChainTxHash = onChainResult?.txHash ?? onChainErrTxHash;

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
      // Human mode: re-throw the original error so the user sees the standard
      // error surface (an OspexChainError preserves txHash / receipt / reason /
      // cause; a validation/API error keeps its message + field). The off-chain
      // DELETE already landed; the stderr note above pointed the user at the
      // standalone `cancel-onchain` recovery.
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
      // The failure-envelope scope: catches the OFF-CHAIN failure case (when
      // client.commitments.cancel itself throws). The on-chain
      // partial-success path is handled inline above via
      // toCancelDualAgentEnvelope which preserves the off-chain
      // effects in its effects[] regardless of the on-chain outcome.
      if (wantJson) {
        await emitJsonFailureAndExit({
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
   * The error from the on-chain leg, when it failed — ANY thrown value, not
   * just an OspexChainError (M6). An OspexChainError carries `txHash` /
   * `receipt` / `cause` so the transaction effect + the `errors[]` entry
   * reflect what actually happened on-chain (M7): an inclusion revert keeps
   * its hash + `status:'reverted'`, a receipt-wait timeout surfaces as
   * `status:'submitted'`, a pre-send failure carries neither. A non-chain
   * error (validation, an API hiccup) carries none of those; it still maps
   * cleanly through `errorToAgentError` and — critically — the off-chain leg
   * stays in `effects[]` regardless of the on-chain failure's type.
   */
  onChainError: unknown;
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
function onChainErrorEffect(err: unknown): AgentEffect {
  const effect: AgentEffect = {
    type: 'transaction',
    purpose: 'onchain-cancel',
    ok: false,
    // errorToAgentError maps OspexError → its code, and any other thrown
    // value → UNKNOWN_ERROR — so a non-chain failure still gets a typed
    // errorCode on the effect.
    errorCode: errorToAgentError(err).code,
  };
  // tx-level discriminators only exist on an OspexChainError; a non-chain
  // failure (validation, API) leaves the effect with no txHash / status —
  // honest: no on-chain tx is known to have landed.
  if (err instanceof OspexChainError) {
    if (typeof err.txHash === 'string') effect.txHash = err.txHash as Hex;
    if (err.receipt) {
      effect.blockNumber = err.receipt.blockNumber.toString();
      effect.status = err.receipt.status === 'success' ? 'confirmed' : 'reverted';
    } else if (typeof err.txHash === 'string') {
      effect.status = 'submitted';
    }
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
  // Map the on-chain failure ONCE (when present). `errorToAgentError` accepts
  // ANY thrown value — an OspexChainError keeps its code + txHash / receipt /
  // causeChain in `details` (M7); any other error → UNKNOWN_ERROR. Reused for
  // errors[], the effect's errorCode, and the payload summary so they never
  // disagree. The narrowed `onChainErr` is the only source of the tx-level
  // discriminators (txHash / receipt), which a non-chain error doesn't carry.
  const onChainAgentError =
    inputs.onChainError !== null && inputs.onChainError !== undefined
      ? errorToAgentError(inputs.onChainError)
      : null;
  const onChainErr =
    inputs.onChainError instanceof OspexChainError ? inputs.onChainError : null;
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
      : onChainAgentError !== null
        ? onChainErrorEffect(inputs.onChainError)
        : null;
  const effects: AgentEffect[] = [offSig, offWrite];
  if (onChainEffect !== null) effects.push(onChainEffect);
  // Surface the on-chain tx the error left behind (inclusion revert /
  // broadcast-then-timeout), falling back to null for a pre-send / non-chain
  // failure (which carries no tx handle).
  const errorTxHash = typeof onChainErr?.txHash === 'string' ? onChainErr.txHash : null;
  const errorBlockNumber =
    onChainErr?.receipt !== undefined ? onChainErr.receipt.blockNumber.toString() : null;
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
    errors: onChainAgentError !== null ? [onChainAgentError] : [],
    effects,
    // When the on-chain leg failed, the off-chain DELETE still landed (the row
    // is hidden but a payload-holding taker is NOT blocked) — lead with the
    // standalone on-chain cancel as the recovery, then the verify.
    nextCommands:
      onChainAgentError !== null
        ? [
            REMEDIATE_CANCEL_ONCHAIN.build({ hash: args.hash }),
            VERIFY_COMMITMENT.build({ hash: args.hash }),
          ]
        : [VERIFY_COMMITMENT.build({ hash: args.hash })],
    payload: {
      hash: args.hash,
      offChainOk: offOk,
      txHash: inputs.onChainResult?.txHash ?? errorTxHash,
      blockNumber:
        inputs.onChainResult?.receipt.blockNumber.toString() ?? errorBlockNumber,
      explorer: inputs.explorer,
      onChainError:
        onChainAgentError !== null
          ? { code: onChainAgentError.code, message: onChainAgentError.message }
          : null,
    },
  });
}
