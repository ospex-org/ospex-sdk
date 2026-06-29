/**
 * `ospex contests update-markets <contestId>` — submit a market-line
 * refresh request to CreOracleReceiver.requestMarketUpdate (R5/CRE).
 * Permissionless and free (no USDC fee, no LINK) — the contest must already
 * be Verified (the call reverts otherwise). Returns immediately after on-chain
 * inclusion; the CRE oracle report (with the refreshed odds) lands ~30-90 s
 * later. Caller can poll `ospex odds show <contestId>` for the fresh lines.
 */
import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  type AgentEffect,
  type AgentEnvelope,
  type ChainId,
  type Hex,
  type OspexClient,
} from '@ospex/sdk';
import {
  buildAgentEnvelope,
  emitJsonFailure,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import {
  VERIFY_CONTEST_ODDS,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const contestUpdateMarketsCommand = addSignerOptions(
  new Command('update-markets')
    .description(
      'Submit CreOracleReceiver.requestMarketUpdate for a Verified contest (R5/CRE; free).',
    )
    .argument('<contestId>', 'contest id (uint256)')
    .addOption(new Option('--json').hideHelp(false)),
)
  .action(async (contestIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });
    const chainId = client.chainId();
    const wantJson = opts.json === true;
    let signerAddress: Hex | null = null;

    try {
    // Resolve the signer address up-front so a failure envelope from
    // the catch below still carries `wallet` / `signer` populated —
    // a CHAIN_ERROR during the request otherwise lands with both fields
    // `null` even though the keystore was already unlocked.
    signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;

    const result = await client.contests.requestMarketUpdate({ contestId: BigInt(contestIdArg) });

    if (wantJson) {
      writeAgentEnvelope(
        toContestUpdateMarketsAgentEnvelope(result, {
          chainId,
          // Non-null assertion documents the invariant — signerAddress
          // was just assigned at the top of the try, so the success
          // path always has a Hex (not Hex | null).
          signerAddress: signerAddress as Hex,
        }),
      );
    } else {
      process.stdout.write(
        `Market-update request sent (tx ${result.txHash}, nonce ${result.requestNonce}).\n` +
          `The CRE oracle refreshes the contest's market lines within 30-90s. ` +
          `Run \`ospex odds show ${result.contestId}\` to check the refreshed odds.\n`,
      );
    }
    } catch (err) {
      if (wantJson) {
        emitJsonFailure({
          action: 'contests.update-markets',
          stage: 'execute',
          chainId,
          // signerAddress is populated at the top of the try and
          // therefore set even when the catch fires before any side
          // effect.
          wallet: signerAddress,
          walletRole: 'signer',
          signer: signerAddress,
          // `contests update-markets` is a write command — advertise sig +
          // tx intent so failure-envelope readers don't see the misleading
          // `requiresSignature: false / requiresTransaction: false` defaults.
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

// ── v1 → v2 envelope transform ──────────────────────────────────────

export type ContestUpdateMarketsResult = Awaited<
  ReturnType<OspexClient['contests']['requestMarketUpdate']>
>;

export interface ContestUpdateMarketsPayload {
  contestId: string;
  requestNonce: string;
  txHash: string;
  status: 'success' | 'reverted';
}

export interface ToContestUpdateMarketsEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex;
}

export function toContestUpdateMarketsAgentEnvelope(
  result: ContestUpdateMarketsResult,
  args: ToContestUpdateMarketsEnvelopeArgs,
): AgentEnvelope<ContestUpdateMarketsPayload> {
  const status = result.receipt.status === 'success' ? 'confirmed' : 'reverted';
  const marketUpdateEffect: AgentEffect = {
    type: 'transaction',
    purpose: 'market-update-contest',
    ok: result.receipt.status === 'success',
    txHash: result.txHash as Hex,
    blockNumber: result.receipt.blockNumber.toString(),
    status,
  };
  const contestIdStr = result.contestId.toString();
  return buildAgentEnvelope<ContestUpdateMarketsPayload>({
    ok: marketUpdateEffect.ok,
    action: 'contests.update-markets',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    effects: [marketUpdateEffect],
    nextCommands: [VERIFY_CONTEST_ODDS.build({ contestId: contestIdStr })],
    payload: {
      contestId: contestIdStr,
      requestNonce: result.requestNonce.toString(),
      txHash: result.txHash,
      status: result.receipt.status,
    },
  });
}
