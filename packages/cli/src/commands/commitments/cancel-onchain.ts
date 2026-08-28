/**
 * `ospex commitments cancel-onchain <hash-or-prefix>` — call
 * `MatchingModule.cancelCommitment(commitment)` on chain. Authoritative
 * cancel: blocks future matchCommitment attempts even from takers who
 * already hold the signed payload.
 *
 * Prints the txHash + Polygonscan link on success. The contract has no
 * `AlreadyCancelled` revert path, so calling this on an already-cancelled
 * commitment succeeds without changing state — be aware of that when
 * scripting against this command.
 *
 * Accepts a full 32-byte hash OR a unique 0x-prefixed hex prefix (≥ 8
 * hex chars). Reconstructing the commitment struct needs the full ABI
 * fields:
 *   - a VISIBLE row is fetched from the public commitments API;
 *   - a BOOK-HIDDEN row (book_visible=false — the maker already
 *     off-chain-cancelled it) is redacted on the public API, so the struct
 *     is recovered from the OWNER-AUTH own-state surface instead. This makes
 *     the command the recovery path after a dual `cancel --also-onchain`
 *     whose on-chain leg didn't confirm. A hidden row only resolves by its
 *     FULL hash (the public list omits hidden rows), and only the maker can
 *     recover it (the own-state snapshot is scoped to the signer).
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexChainError } from '@ospex/sdk';
import type {
  AgentEnvelope,
  ChainId,
  Commitment,
  Hex,
  OspexClient,
} from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  emitJsonFailureAndExit,
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

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const commitmentsCancelOnchainCommand = addSignerOptions(
  new Command('cancel-onchain')
    .description(
      'On-chain cancel: call MatchingModule.cancelCommitment(commitment). ' +
        'Accepts a full hash or a unique 0x-prefixed hex prefix (≥ 8 hex chars). ' +
        'Reconstructs the struct from the public commitments API for a visible ' +
        'row, or from owner-auth own-state for a book-hidden row (full hash, ' +
        'maker only) — the recovery path for an already off-chain-cancelled order.',
    )
    .argument('<hash-or-prefix>', 'full commitment hash, or unique 0x-prefixed hex prefix')
    .option('--json', 'output as JSON'),
)
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);

    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });
    const chainId = client.chainId();
    let signerAddress: Hex | null = null;
    const wantJson = opts.json === true;

    try {
    // Resolve the signer up-front so a failure envelope from the
    // catch below carries wallet/signer populated.
    signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;

    // Include `cancelled` in the resolve scope: a maker who already off-chain-
    // cancelled (book_visible=false → effective status `cancelled`) — e.g. after
    // a dual `cancel --also-onchain` whose on-chain leg didn't confirm — must
    // still be able to run the authoritative on-chain cancel. The row reads
    // `cancelled` but is STILL matchable on chain. (Resolution is by FULL hash
    // for a hidden row: the public list filters book_visible=false rows out, so
    // a prefix won't resolve one — pass the full hash to recover a hidden row.)
    const commitment = await client.commitments.resolveByPrefix(hashArg, {
      status: ['open', 'partially_filled', 'cancelled'],
    });
    const hash = commitment.commitmentHash as Hex;
    if (commitment.commitmentHash.toLowerCase() !== hashArg.toLowerCase()) {
      process.stderr.write(`Resolved ${hashArg} → ${commitment.commitmentHash}\n`);
    }

    let result;
    try {
      // `recoverHidden: true`: if the resolved row is book-hidden (redacted),
      // recover the maker's signed payload via owner-auth own-state and cancel
      // authoritatively — the standalone recovery for a commitment taken off
      // the public book. Passing the already-resolved `commitment` (not just
      // the hash) also skips a redundant re-fetch for the visible case.
      result = await client.commitments.cancelOnchain({ commitment, recoverHidden: true });
    } catch (err) {
      if (err instanceof OspexChainError && err.reason === 'NotCommitmentMaker') {
        process.stderr.write(
          'Cancel reverted: signer is not the commitment maker. Only the original maker can cancel on chain.\n',
        );
      }
      throw err;
    }

    const explorerUrl = polygonscanTxUrl(chainId, result.txHash);
    if (wantJson) {
      writeAgentEnvelope(
        toCancelOnchainAgentEnvelope(result, commitment, {
          chainId,
          signerAddress: signerAddress as Hex,
          explorer: explorerUrl,
        }),
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        commitmentHash: result.commitmentHash,
        blockNumber: result.receipt.blockNumber.toString(),
        explorer: explorerUrl,
      },
      { json: false },
    );
    } catch (err) {
      if (wantJson) {
        await emitJsonFailureAndExit({
          action: 'commitments.cancel-onchain',
          stage: 'execute',
          chainId,
          wallet: signerAddress,
          walletRole: 'signer',
          signer: signerAddress,
          requiresSignature: true,
          requiresTransaction: true,
          nextCommands: deriveRemediationNextCommands(err, chainId),
          error: err,
        });
      }
      throw err;
    }
  });

// ── v1 → v2 envelope transform ──────────────────────────────────────

export type CancelOnchainResult = Awaited<
  ReturnType<OspexClient['commitments']['cancelOnchain']>
>;

export interface CancelOnchainPayload {
  txHash: string;
  commitmentHash: string;
  blockNumber: string;
  explorer: string;
}

export interface ToCancelOnchainEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex;
  explorer: string;
}

export function toCancelOnchainAgentEnvelope(
  result: CancelOnchainResult,
  commitment: Commitment,
  args: ToCancelOnchainEnvelopeArgs,
): AgentEnvelope<CancelOnchainPayload> {
  const status = result.receipt.status === 'success' ? 'confirmed' : 'reverted';
  return buildAgentEnvelope<CancelOnchainPayload>({
    ok: result.receipt.status === 'success',
    action: 'commitments.cancel-onchain',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    commitment,
    effects: [
      {
        type: 'transaction',
        purpose: 'onchain-cancel',
        ok: result.receipt.status === 'success',
        txHash: result.txHash as Hex,
        blockNumber: result.receipt.blockNumber.toString(),
        status,
      },
    ],
    nextCommands: [
      VERIFY_COMMITMENT.build({ hash: result.commitmentHash }),
    ],
    payload: {
      txHash: result.txHash,
      commitmentHash: result.commitmentHash,
      blockNumber: result.receipt.blockNumber.toString(),
      explorer: args.explorer,
    },
  });
}
