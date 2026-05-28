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
  emitJsonFailure,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import {
  COMPLETE_CANCEL_ALL,
  VERIFY_COMMITMENTS_EMPTY,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { polygonscanTxUrl } from '../../lib/explorer.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';

const DRY_RUN_PAGE_LIMIT = 1000;
const DRY_RUN_MAX_PAGES = 50;

const optionsSchema = z.object({
  contestId: z.string().regex(/^[0-9]+$/, 'must be a non-negative integer'),
  scorer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address'),
  line: z.string().regex(/^-?[0-9]+$/, 'must be an int32'),
  newMinNonce: z.string().regex(/^[0-9]+$/, 'must be a non-negative integer').optional(),
  dryRun: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const commitmentsCancelAllCommand = addSignerOptions(
  new Command('cancel-all')
    .description(
      'Bulk-cancel every open commitment from this maker on one speculation by raising the nonce floor.',
    )
    .requiredOption('--contest-id <id>', 'contest id (uint256)')
    .requiredOption('--scorer <addr>', 'scorer module address')
    .requiredOption('--line <ticks>', 'line ticks (int32, 10× scale)')
    .option('--new-min-nonce <n>', 'override the computed default (must exceed current floor)')
    .option('--dry-run', 'count what would be invalidated; do not send a tx')
    .option('--json', 'output as JSON'),
)
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const contestId = BigInt(opts.contestId);
    const scorer = opts.scorer.toLowerCase() as Hex;
    const lineTicks = Number(opts.line);

    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });
    const maker = (await client.signer().getAddress()).toLowerCase() as Hex;
    const chainId = client.chainId();
    const wantJson = opts.json === true;
    const dryRun = opts.dryRun === true;

    try {
    if (dryRun) {
      const rawRows: Commitment[] = [];
      let offset = 0;
      for (let page = 0; page < DRY_RUN_MAX_PAGES; page++) {
        const pageRows = await client.commitments.list({
          maker,
          contestId: contestId.toString(),
          scorer,
          status: ['open', 'partially_filled'],
          limit: DRY_RUN_PAGE_LIMIT,
          offset,
        });
        rawRows.push(...pageRows);
        if (pageRows.length < DRY_RUN_PAGE_LIMIT) break;
        offset += pageRows.length;
        if (page === DRY_RUN_MAX_PAGES - 1) {
          process.stderr.write(
            `Warning: stopped paginating at ${DRY_RUN_MAX_PAGES * DRY_RUN_PAGE_LIMIT} rows; ` +
              'preview may be incomplete. Pass an explicit --new-min-nonce and skip --dry-run.\n',
          );
        }
      }
      const rows = rawRows.filter((c) => c.lineTicks === lineTicks);
      const count = rows.length;
      if (opts.json === true) {
        writeAgentEnvelope(
          toCancelAllDryRunEnvelope({
            chainId,
            signerAddress: maker,
            contestId,
            scorer,
            lineTicks,
            invalidatedCount: count,
            commitments: rows,
          }),
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

    const explorerUrl = polygonscanTxUrl(chainId, result.txHash);
    if (opts.json === true) {
      writeAgentEnvelope(
        toCancelAllExecuteEnvelope(result, {
          chainId,
          signerAddress: maker,
          contestId,
          scorer,
          lineTicks,
          explorer: explorerUrl,
        }),
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
    } catch (err) {
      if (wantJson) {
        emitJsonFailure({
          action: 'commitments.cancel-all',
          stage: dryRun ? 'dry-run' : 'execute',
          chainId,
          wallet: maker,
          walletRole: 'signer',
          signer: maker,
          // Sends an on-chain raiseMinNonce tx (dry-run or executed —
          // both advertise the write intent so failure consumers route
          // the error correctly).
          requiresSignature: true,
          requiresTransaction: true,
          nextCommands: deriveRemediationNextCommands(err, chainId),
          error: err,
        });
        process.exit(1);
      }
      throw err;
    }
  });

// ── v1 → v2 envelope transforms ─────────────────────────────────────

export type CancelAllResult = Awaited<
  ReturnType<OspexClient['commitments']['cancelAllOnSpeculation']>
>;

export interface CancelAllDryRunPayload {
  contestId: string;
  scorer: Hex;
  lineTicks: number;
  dryRun: true;
  invalidatedCount: number;
  commitments: Array<{
    hash: string;
    status: string;
    nonce: string;
    riskAmount: string;
    remainingRiskAmount: string;
  }>;
}

export interface CancelAllExecutePayload {
  contestId: string;
  scorer: Hex;
  lineTicks: number;
  txHash: string;
  blockNumber: string;
  newMinNonce: string;
  invalidatedCount: number;
  explorer: string;
}

export interface ToCancelAllEnvelopeBaseArgs {
  chainId: ChainId;
  signerAddress: Hex;
  contestId: bigint;
  scorer: Hex;
  lineTicks: number;
}

export interface ToCancelAllDryRunArgs extends ToCancelAllEnvelopeBaseArgs {
  invalidatedCount: number;
  commitments: Commitment[];
}

export function toCancelAllDryRunEnvelope(
  args: ToCancelAllDryRunArgs,
): AgentEnvelope<CancelAllDryRunPayload> {
  return buildAgentEnvelope<CancelAllDryRunPayload>({
    ok: true,
    action: 'commitments.cancel-all',
    stage: 'dry-run',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    requiresSignature: true,
    requiresTransaction: true,
    nextCommands: [
      COMPLETE_CANCEL_ALL.build({
        contestId: args.contestId.toString(),
        scorer: args.scorer,
        lineTicks: args.lineTicks,
      }),
    ],
    payload: {
      contestId: args.contestId.toString(),
      scorer: args.scorer,
      lineTicks: args.lineTicks,
      dryRun: true,
      invalidatedCount: args.invalidatedCount,
      commitments: args.commitments.map((c) => ({
        hash: c.commitmentHash,
        status: c.status,
        nonce: c.nonce,
        riskAmount: c.riskAmount,
        remainingRiskAmount: c.remainingRiskAmount,
      })),
    },
  });
}

export interface ToCancelAllExecuteArgs extends ToCancelAllEnvelopeBaseArgs {
  explorer: string;
}

export function toCancelAllExecuteEnvelope(
  result: CancelAllResult,
  args: ToCancelAllExecuteArgs,
): AgentEnvelope<CancelAllExecutePayload> {
  const status = result.receipt.status === 'success' ? 'confirmed' : 'reverted';
  return buildAgentEnvelope<CancelAllExecutePayload>({
    ok: result.receipt.status === 'success',
    action: 'commitments.cancel-all',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    effects: [
      {
        type: 'transaction',
        purpose: 'cancel-all-onchain',
        ok: result.receipt.status === 'success',
        txHash: result.txHash as Hex,
        blockNumber: result.receipt.blockNumber.toString(),
        status,
      },
    ],
    nextCommands: [
      VERIFY_COMMITMENTS_EMPTY.build({
        maker: args.signerAddress,
        contestId: args.contestId.toString(),
      }),
    ],
    payload: {
      contestId: args.contestId.toString(),
      scorer: args.scorer,
      lineTicks: args.lineTicks,
      txHash: result.txHash,
      blockNumber: result.receipt.blockNumber.toString(),
      newMinNonce: result.newMinNonce.toString(),
      invalidatedCount: result.invalidatedCount,
      explorer: args.explorer,
    },
  });
}
