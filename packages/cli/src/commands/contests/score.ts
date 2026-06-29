/**
 * `ospex contests score <contestId>` — submit a scoring request to
 * CreOracleReceiver.requestScore (R5/CRE). Permissionless and free (no
 * USDC fee, no LINK) — the contest must already be Verified and the call
 * reverts until its on-chain start time has passed. Returns immediately
 * after on-chain inclusion; the CRE oracle report (with the actual score)
 * lands ~30-90 s later. Caller can poll `ospex contests show <contestId>`
 * for `status === 'scored'`.
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
  VERIFY_CONTEST,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const contestScoreCommand = addSignerOptions(
  new Command('score')
    .description('Submit CreOracleReceiver.requestScore for an existing contest (R5/CRE; free).')
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
    // a CHAIN_ERROR during score otherwise lands with both fields
    // `null` even though the keystore was already unlocked.
    signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;

    const result = await client.contests.score({ contestId: BigInt(contestIdArg) });

    if (wantJson) {
      writeAgentEnvelope(
        toContestScoreAgentEnvelope(result, {
          chainId,
          // Non-null assertion documents the invariant — signerAddress
          // was just assigned at the top of the try, so the success
          // path always has a Hex (not Hex | null).
          signerAddress: signerAddress as Hex,
        }),
      );
    } else {
      process.stdout.write(
        `Scoring request sent (tx ${result.txHash}).\n` +
          `The CRE oracle report typically lands within 30-90s. ` +
          `Run \`ospex contests show ${result.contestId}\` to check status.\n`,
      );
    }
    } catch (err) {
      if (wantJson) {
        emitJsonFailure({
          action: 'contests.score',
          stage: 'execute',
          chainId,
          // signerAddress is populated at the top of the try and
          // therefore set even when the catch fires before any side
          // effect.
          wallet: signerAddress,
          walletRole: 'signer',
          signer: signerAddress,
          // `contests score` is a write command — advertise sig + tx
          // intent so failure-envelope readers don't see the
          // misleading `requiresSignature: false / requiresTransaction:
          // false` defaults.
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

export type ContestScoreResult = Awaited<
  ReturnType<OspexClient['contests']['score']>
>;

export interface ContestScorePayload {
  contestId: string;
  txHash: string;
  status: 'success' | 'reverted';
}

export interface ToContestScoreEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex;
}

export function toContestScoreAgentEnvelope(
  result: ContestScoreResult,
  args: ToContestScoreEnvelopeArgs,
): AgentEnvelope<ContestScorePayload> {
  const status = result.receipt.status === 'success' ? 'confirmed' : 'reverted';
  const scoreEffect: AgentEffect = {
    type: 'transaction',
    purpose: 'score-contest',
    ok: result.receipt.status === 'success',
    txHash: result.txHash as Hex,
    blockNumber: result.receipt.blockNumber.toString(),
    status,
  };
  const contestIdStr = result.contestId.toString();
  return buildAgentEnvelope<ContestScorePayload>({
    ok: scoreEffect.ok,
    action: 'contests.score',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    effects: [scoreEffect],
    nextCommands: [VERIFY_CONTEST.build({ contestId: contestIdStr })],
    payload: {
      contestId: contestIdStr,
      txHash: result.txHash,
      status: result.receipt.status,
    },
  });
}
