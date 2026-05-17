/**
 * `ospex contests score <contestId>` — submit a scoring request.
 * Returns immediately after on-chain inclusion; the Chainlink callback
 * (with the actual score) lands ~30-90 s later. Caller can poll
 * `ospex contests show <contestId>` for `status === 'scored'`.
 */
import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  OspexAllowanceError,
  type AgentEffect,
  type AgentEnvelope,
  type ChainId,
  type Hex,
  type OspexClient,
} from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import { promptYesNo, promptValue } from '../../lib/prompt.js';

const optionsSchema = z.object({
  subscriptionId: z.string().regex(/^[0-9]+$/).optional(),
  gasLimit: z.coerce.number().int().positive().max(300_000).optional(),
  json: z.boolean().optional(),
});

export const contestScoreCommand = addSignerOptions(
  new Command('score')
    .description('Submit OracleModule.scoreContestFromOracle for an existing contest.')
    .argument('<contestId>', 'contest id (uint256)')
    .option('--subscription-id <n>', 'Chainlink Functions subscription id')
    .option('--gas-limit <n>', 'Chainlink Functions callback gas limit (default 300000, Polygon router max)')
    .addOption(new Option('--json').hideHelp(false)),
)
  .action(async (contestIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });

    const args: Parameters<typeof client.contests.score>[0] = {
      contestId: BigInt(contestIdArg),
    };
    if (opts.subscriptionId !== undefined) args.subscriptionId = BigInt(opts.subscriptionId);
    if (opts.gasLimit !== undefined) args.gasLimit = opts.gasLimit;

    // Mirrors PR-69 fix on submit/match + contests create: collect
    // any approve txs that ran before the final score tx into a list
    // that gets prepended to the envelope's effects[].
    const approveEffects: AgentEffect[] = [];

    const tryScore = async () => client.contests.score(args);

    let result;
    try {
      result = await tryScore();
    } catch (err) {
      if (!(err instanceof OspexAllowanceError)) throw err;
      const handled = await handleLinkAllowance(client, err, opts.json === true, approveEffects);
      if (!handled) throw err;
      result = await tryScore();
    }

    if (opts.json === true) {
      const signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;
      writeAgentEnvelope(
        toContestScoreAgentEnvelope(result, {
          chainId: client.chainId(),
          signerAddress,
          approveEffects,
        }),
      );
    } else {
      process.stdout.write(
        `Scoring request sent (tx ${result.txHash}).\n` +
          (result.requestId !== null ? `Chainlink requestId: ${result.requestId}\n` : '') +
          `Chainlink callback typically lands within 30-90s. ` +
          `Run \`ospex contests show ${result.contestId}\` to check status.\n`,
      );
    }
  });

async function handleLinkAllowance(
  client: OspexClient,
  err: OspexAllowanceError,
  jsonMode: boolean,
  approveEffects: AgentEffect[],
): Promise<boolean> {
  // JSON mode is non-interactive — surface the error rather than
  // prompting. Agents pre-approve via `approvals setup` or
  // `commitments approve` before scoring.
  if (jsonMode) return false;

  process.stdout.write(
    `\nInsufficient LINK allowance.\n` +
      `  Required: ${err.required.toString()}\n` +
      `  Current:  ${err.current.toString()}\n` +
      `  Spender:  ${err.spender} (OracleModule)\n` +
      `  Token:    ${err.token}\n`,
  );
  const ok = await promptYesNo('Approve OracleModule for LINK?', true);
  if (!ok) return false;
  const choice = await promptValue('Amount? (max | <wei units>)', 'max');
  const approveAmount = choice === 'max' ? 'max' : BigInt(choice);
  const tx = await client.contests.approveLink(approveAmount);
  process.stdout.write(`approve tx: ${tx.txHash} (status ${tx.receipt.status})\n`);
  approveEffects.push({
    type: 'transaction',
    purpose: 'approve-link',
    ok: tx.receipt.status === 'success',
    txHash: tx.txHash as Hex,
    blockNumber: tx.receipt.blockNumber.toString(),
    status: tx.receipt.status === 'success' ? 'confirmed' : 'reverted',
  });
  return true;
}

// ── v1 → v2 envelope transform ──────────────────────────────────────

export type ContestScoreResult = Awaited<
  ReturnType<OspexClient['contests']['score']>
>;

export interface ContestScorePayload {
  contestId: string;
  txHash: string;
  requestId: string | null;
  status: 'success' | 'reverted';
}

export interface ToContestScoreEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex;
  approveEffects?: AgentEffect[];
}

export function toContestScoreAgentEnvelope(
  result: ContestScoreResult,
  args: ToContestScoreEnvelopeArgs,
): AgentEnvelope<ContestScorePayload> {
  const status = result.receipt.status === 'success' ? 'confirmed' : 'reverted';
  const approveEffects = args.approveEffects ?? [];
  const scoreEffect: AgentEffect = {
    type: 'transaction',
    purpose: 'score-contest',
    ok: result.receipt.status === 'success',
    txHash: result.txHash as Hex,
    blockNumber: result.receipt.blockNumber.toString(),
    status,
  };
  const effects: AgentEffect[] = [...approveEffects, scoreEffect];
  return buildAgentEnvelope<ContestScorePayload>({
    ok: effects.every((e) => e.ok),
    action: 'contests.score',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    effects,
    payload: {
      contestId: result.contestId.toString(),
      txHash: result.txHash,
      requestId: result.requestId,
      status: result.receipt.status,
    },
  });
}
