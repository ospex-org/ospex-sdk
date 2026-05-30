/**
 * `ospex commitments cancel-all --contest-id <id> --scorer <addr> --line <ticks>
 *                              --new-min-nonce <n> [--dry-run]`
 *
 * Bulk-invalidate every one of the maker's open commitments on a single
 * speculation by raising the on-chain nonce floor. Friendly wrapper over
 * `MatchingModule.raiseMinNonce`.
 *
 * `--new-min-nonce` is REQUIRED — the SDK no longer auto-computes a
 * floor because the public commitments list filters `book_visible=true`
 * upstream, so cross-process book-hidden commitments at higher nonces
 * are invisible to anonymous reads and any "convenience default" would
 * silently leave them matchable on chain. Compute the floor yourself:
 * read the current on-chain floor via `ospex commitments nonce-floor
 * --maker <addr> --contest-id <id> --scorer <addr> --line <ticks>`,
 * add any headroom you need for cross-process signatures, and pass the
 * result here. M5/PR3b ships `client.ownState.snapshot({address})` which
 * can enumerate the maker's full book (visible + hidden) for an
 * externally-derived hidden-safe floor; an SDK-side auto-default that
 * consumes it is a future enhancement.
 *
 * `--dry-run` previews `invalidatedCount` for the given `--new-min-nonce`
 * without sending a tx — useful for sanity-checking before the gas
 * spend. The preview is VISIBLE-rows-only.
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
  PublicVisibleCommitment,
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
  // `--new-min-nonce` is required by the SDK now; commander's
  // `.requiredOption()` already enforces presence at parse time, but
  // keep the runtime regex check so an empty / non-numeric value still
  // surfaces as an `OspexValidationError`-class CLI message.
  newMinNonce: z.string().regex(/^[1-9][0-9]*$/, 'must be a positive integer'),
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
    .requiredOption(
      '--new-min-nonce <n>',
      'required on-chain floor to raise to. The SDK does not auto-compute (anonymous reads cannot enumerate the maker’s hidden book). Read the current floor with `ospex commitments nonce-floor ...` and add the headroom you need.',
    )
    .option('--dry-run', 'preview invalidatedCount for --new-min-nonce; do not send a tx')
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

    const newMinNonce = BigInt(opts.newMinNonce);
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
              'preview may be incomplete.\n',
          );
        }
      }
      // Hidden bodies redact `nonce` + `lineTicks` + `riskAmount` — they can't
      // contribute to the lineTicks filter or the nonce-floor filter either.
      // Surface them as a warning so the operator knows the preview excludes
      // them; on chain `raiseMinNonce` still invalidates hidden commitments
      // whose nonce < newMinNonce, but the preview can't account for those.
      const visibleRows = rawRows.filter(
        (c): c is PublicVisibleCommitment => c.redacted !== true,
      );
      const hiddenCount = rawRows.length - visibleRows.length;
      if (hiddenCount > 0) {
        process.stderr.write(
          `Warning: ${hiddenCount} hidden (book_visible=false) commitment(s) excluded from this ` +
            'preview (their nonces are redacted from anonymous reads). On-chain raiseMinNonce will ' +
            'still invalidate them if their nonce is below the floor; this preview just cannot show them.\n',
        );
      }
      // Restrict the preview to commitments at the specified lineTicks that
      // would actually flip — nonce strictly below newMinNonce.
      const rows = visibleRows
        .filter((c) => c.lineTicks === lineTicks)
        .filter((c) => BigInt(c.nonce) < newMinNonce);
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
            newMinNonce,
          }),
        );
        return;
      }
      formatOutput(
        {
          dryRun: true,
          newMinNonce: newMinNonce.toString(),
          invalidatedCount: count,
        },
        { json: false },
      );
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
        newMinNonce,
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
  /** Floor previewed against. Decimal string mirroring the JSON convention for bigints. */
  newMinNonce: string;
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
  /** Always visible — the dry-run upstream filters hidden rows out before reaching here. */
  commitments: PublicVisibleCommitment[];
  /** Floor the dry-run was previewed against; round-tripped into the `complete-cancel-all` nextCommand. */
  newMinNonce: bigint;
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
        newMinNonce: args.newMinNonce.toString(),
      }),
    ],
    payload: {
      contestId: args.contestId.toString(),
      scorer: args.scorer,
      lineTicks: args.lineTicks,
      dryRun: true,
      newMinNonce: args.newMinNonce.toString(),
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
