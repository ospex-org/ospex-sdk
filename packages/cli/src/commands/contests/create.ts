/**
 * `ospex contests create --game-id <id>` (or `--game <slug-or-id>`)
 *  - `gameId` is the stable identifier from `ospex games list` (the
 *    row's `jsonodds_id`). The SDK fetches `/v1/games/:gameId`,
 *    extracts the three external IDs the contract requires, and builds
 *    the on-chain tx. Users never deal with the three IDs directly.
 *  - `--game <slug-or-id>` is the resolver-friendly alias. UUID inputs
 *    are passed through; slug inputs are resolved against `games.slug`
 *    for the configured network. Multiple matches or no match fail
 *    closed. `--game-id` remains canonical forever.
 *  - On OspexAllowanceError: prompt to approve the right (token, spender)
 *    pair and retry. Both LINK→OracleModule and USDC→TreasuryModule may
 *    be missing on a fresh wallet, so the call site loops up to two
 *    approvals before giving up — fixing one at a time would surface the
 *    second as a hard error after a successful approve tx.
 *  - Without `--no-wait`, blocks until the Chainlink callback flips the
 *    contest to Verified (or timeout, in which case the contestId is
 *    surfaced and the user can re-poll with `ospex contests wait-verified`).
 */
import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import { formatUnits, parseUnits } from 'viem';
import {
  getAddresses,
  OspexAllowanceError,
  OspexValidationError,
  type AgentEffect,
  type AgentEnvelope,
  type ChainId,
  type Hex,
  type OspexClient,
} from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  emitJsonFailure,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import { promptYesNo, promptValue } from '../../lib/prompt.js';

const optionsSchema = z.object({
  gameId: z.string().min(1).optional(),
  game: z.string().min(1).optional(),
  subscriptionId: z.string().regex(/^[0-9]+$/).optional(),
  gasLimit: z.coerce.number().int().positive().max(300_000).optional(),
  wait: z.boolean().optional(),
  json: z.boolean().optional(),
  yes: z.boolean().optional(),
});

export const contestCreateCommand = addSignerOptions(
  new Command('create')
    .description('Create a contest by submitting OracleModule.createContestFromOracle.')
    .option('--game-id <id>', 'gameId from `ospex games list` (canonical UUID)')
    .option(
      '--game <slug-or-id>',
      'resolver-friendly alias: pass either the slug from `ospex games list` or a UUID',
    )
    .option(
      '--subscription-id <n>',
      'Chainlink Functions subscription id (defaults to OSPEX_SHARED_SUBSCRIPTION_ID per chain)',
    )
    .option('--gas-limit <n>', 'Chainlink Functions callback gas limit (default 300000, Polygon router max)')
    .option('--no-wait', 'skip polling for verification; print txHash and return')
    .option('--yes', 'skip the slug-resolved confirmation prompt (no effect for --game-id / UUID input)')
    .addOption(new Option('--json').hideHelp(false)),
)
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);

    const hasGame = opts.game !== undefined;
    const hasGameId = opts.gameId !== undefined;
    if (hasGame && hasGameId) {
      throw new OspexValidationError(
        '--game and --game-id are mutually exclusive. Pass exactly one.',
      );
    }
    if (!hasGame && !hasGameId) {
      throw new OspexValidationError('Either --game-id <id> or --game <slug-or-id> is required.');
    }

    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });
    const chainId = client.chainId();
    const wantJson = opts.json === true;
    let signerAddress: Hex | null = null;
    // Failure-envelope state: approveEffects accumulates during the
    // retry loop's allowance handler (lifted out of the try block so
    // the catch can preserve confirmed approves on a mid-flight throw).
    const approveEffects: AgentEffect[] = [];

    try {
    let gameId: string;
    if (hasGameId) {
      gameId = opts.gameId as string;
    } else {
      const resolved = await client.games.resolveGameId(opts.game as string);
      gameId = resolved.gameId;
      if (resolved.source === 'slug' && resolved.game !== null) {
        const g = resolved.game;
        const lines = [
          '',
          'Resolved game:',
          `  input:   ${opts.game}`,
          `  gameId:  ${g.gameId}`,
          `  matchup: ${g.awayTeam.name} @ ${g.homeTeam.name} — ${g.sport.toUpperCase()}`,
          `  time:    ${g.matchTime}`,
          `  status:  ${g.status}${g.canCreateContest ? '' : '  (NOT creatable — create will fail downstream)'}`,
          '',
        ];
        process.stderr.write(lines.join('\n'));

        const skipPrompt = opts.yes === true;
        const isInteractive = process.stdin.isTTY === true;
        if (!skipPrompt && !isInteractive) {
          throw new OspexValidationError(
            '--yes is required for non-interactive --game <slug> create. ' +
              'Re-run with --yes after reviewing the resolved game.',
          );
        }
        if (!skipPrompt) {
          const ok = await promptYesNo('Create contest for this game?', true);
          if (!ok) {
            process.stderr.write('Cancelled.\n');
            process.exit(130);
          }
        }
      }
    }

    const args: Parameters<typeof client.contests.create>[0] = {
      gameId,
    };
    if (opts.subscriptionId !== undefined) args.subscriptionId = BigInt(opts.subscriptionId);
    if (opts.gasLimit !== undefined) args.gasLimit = opts.gasLimit;

    // Approve-effect collection: each on-chain approval that runs in
    // the retry loop is captured here (declaration lifted to the
    // action top so the failure-envelope catch can also surface
    // already-confirmed approves on a mid-flight throw).
    const MAX_APPROVAL_RETRIES = 2;
    let result: Awaited<ReturnType<typeof client.contests.create>> | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_APPROVAL_RETRIES; attempt++) {
      try {
        result = await client.contests.create(args);
        break;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof OspexAllowanceError)) throw err;
        if (attempt === MAX_APPROVAL_RETRIES) throw err;
        const handled = await handleContestAllowance(
          client,
          err,
          opts.json === true,
          approveEffects,
        );
        if (!handled) throw err;
      }
    }
    if (result === undefined) {
      throw lastErr ?? new Error('Contest creation did not return a result.');
    }

    if (opts.json !== true) {
      process.stdout.write(
        `Contest ${result.contestId} created (tx ${result.txHash}).\n` +
          (result.requestId !== null ? `Chainlink requestId: ${result.requestId}\n` : ''),
      );
    }

    const shouldWait = opts.wait !== false;
    let verification: { contestId: string; status: string } | null = null;
    let verificationError: unknown = null;

    if (shouldWait) {
      if (opts.json !== true) {
        process.stdout.write('Waiting for Chainlink verification (≤120s)...\n');
      }
      try {
        const verified = await client.contests.waitForVerified(result.contestId);
        verification = {
          contestId: verified.contestId.toString(),
          status: verified.status,
        };
        if (opts.json !== true) {
          process.stdout.write(`Verified. Status: ${verified.status}.\n`);
        }
      } catch (err) {
        verificationError = err;
        if (opts.json !== true) {
          process.stdout.write(
            `Verification did not complete in time. Run \`ospex contests wait-verified ${result.contestId}\` to keep watching.\n`,
          );
        }
      }
    }

    if (wantJson) {
      signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;
      // Hermes PR-71 blocker: when waitForVerified throws AFTER the
      // create tx landed, we previously wrote the success envelope
      // and THEN threw — producing TWO JSON envelopes on stdout AND
      // a failure envelope that omitted the create tx (only had
      // approveEffects). Fix: emit exactly ONE envelope. If
      // verification failed, it's a failure envelope that includes
      // BOTH the approve effects AND the create-contest tx in
      // effects[]. Otherwise it's the regular success envelope.
      if (verificationError !== null) {
        emitJsonFailure({
          action: 'contests.create',
          stage: 'execute',
          chainId,
          wallet: signerAddress,
          walletRole: 'signer',
          signer: signerAddress,
          effects: [...approveEffects, buildCreateContestEffect(result)],
          error: verificationError,
        });
        process.exit(1);
      }
      writeAgentEnvelope(
        toContestCreateAgentEnvelope(result, {
          chainId,
          signerAddress,
          verification,
          approveEffects,
        }),
      );
      return;
    }

    // Human mode: keep the existing throw so the user sees the
    // verification error on stderr. (JSON mode emitted above; this
    // throw is unreachable from the JSON path.)
    if (verificationError !== null) throw verificationError;
    } catch (err) {
      // Hermes PR-6 scope: preserve any approve txs that succeeded
      // before the create call threw. Without this, a wallet that
      // approves LINK successfully and then hits a Chainlink Functions
      // revert would lose the approve tx hash to stderr.
      if (wantJson) {
        emitJsonFailure({
          action: 'contests.create',
          stage: 'execute',
          chainId,
          wallet: signerAddress,
          walletRole: 'signer',
          signer: signerAddress,
          effects: approveEffects,
          error: err,
        });
        process.exit(1);
      }
      throw err;
    }
  });

interface AllowanceCopy {
  symbol: 'LINK' | 'USDC';
  decimals: number;
  moduleName: string;
  purpose: string;
}

function describeAllowance(client: OspexClient, err: OspexAllowanceError): AllowanceCopy {
  const oracleModule = getAddresses(client.chainId()).oracleModule.toLowerCase();
  const isLink = err.spender.toLowerCase() === oracleModule;
  return isLink
    ? {
        symbol: 'LINK',
        decimals: 18,
        moduleName: 'OracleModule',
        purpose: 'Chainlink Functions request payment',
      }
    : {
        symbol: 'USDC',
        decimals: 6,
        moduleName: 'TreasuryModule',
        purpose: 'protocol contest creation fee',
      };
}

async function handleContestAllowance(
  client: OspexClient,
  err: OspexAllowanceError,
  jsonMode: boolean,
  approveEffects: AgentEffect[],
): Promise<boolean> {
  const copy = describeAllowance(client, err);
  const requiredHuman = formatUnits(err.required, copy.decimals);
  const currentHuman = formatUnits(err.current, copy.decimals);

  // JSON mode is non-interactive — surface the error without prompting.
  // Agents are expected to pre-approve via `approvals setup` or
  // `commitments approve` before invoking `contests create --json`.
  if (jsonMode) return false;

  process.stderr.write(
    `\n${copy.symbol} approval needed (${copy.purpose}).\n` +
      `  Required: ${requiredHuman} ${copy.symbol}\n` +
      `  Approved: ${currentHuman} ${copy.symbol}\n` +
      `\nThe ${copy.moduleName} contract pulls this ${copy.symbol} from your wallet during the\n` +
      `create transaction. This is a standard ERC-20 \`approve\` — your tokens stay in\n` +
      `your wallet until the create call runs. Approve more than the minimum if you\n` +
      `want to skip this prompt on future create calls.\n` +
      `  Spender: ${err.spender} (${copy.moduleName})\n` +
      `  Token:   ${err.token} (${copy.symbol})\n`,
  );

  const ok = await promptYesNo(
    `Allow ${copy.moduleName} to spend ${copy.symbol} from your wallet?`,
    true,
  );
  if (!ok) return false;

  const choice = await promptValue(
    `Amount in ${copy.symbol} (number, or "max" for unlimited)`,
    requiredHuman,
  );
  let approveAmount: bigint | 'max';
  if (choice.toLowerCase() === 'max') {
    approveAmount = 'max';
  } else {
    try {
      approveAmount = parseUnits(choice, copy.decimals);
    } catch {
      process.stderr.write(`Could not parse "${choice}" as a ${copy.symbol} amount.\n`);
      return false;
    }
    if (approveAmount < err.required) {
      process.stderr.write(
        `Amount ${choice} ${copy.symbol} is less than the required ${requiredHuman} ${copy.symbol}.\n`,
      );
      return false;
    }
  }

  const tx =
    copy.symbol === 'LINK'
      ? await client.contests.approveLink(approveAmount)
      : await client.contests.approveFee(approveAmount);
  process.stdout.write(`approve tx: ${tx.txHash} (status ${tx.receipt.status})\n`);
  approveEffects.push({
    type: 'transaction',
    purpose: copy.symbol === 'LINK' ? 'approve-link' : 'approve-usdc',
    ok: tx.receipt.status === 'success',
    txHash: tx.txHash as Hex,
    blockNumber: tx.receipt.blockNumber.toString(),
    status: tx.receipt.status === 'success' ? 'confirmed' : 'reverted',
  });
  return true;
}

// ── v1 → v2 envelope transform ──────────────────────────────────────

export type ContestCreateResult = Awaited<
  ReturnType<OspexClient['contests']['create']>
>;

export interface ContestCreatePayload {
  contestId: string;
  txHash: string;
  requestId: string | null;
  status: 'success' | 'reverted';
  verification: { contestId: string; status: string } | null;
}

export interface ToContestCreateEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex;
  verification: { contestId: string; status: string } | null;
  approveEffects?: AgentEffect[];
}

export function toContestCreateAgentEnvelope(
  result: ContestCreateResult,
  args: ToContestCreateEnvelopeArgs,
): AgentEnvelope<ContestCreatePayload> {
  const approveEffects = args.approveEffects ?? [];
  const createEffect = buildCreateContestEffect(result);
  const effects: AgentEffect[] = [...approveEffects, createEffect];
  return buildAgentEnvelope<ContestCreatePayload>({
    ok: effects.every((e) => e.ok),
    action: 'contests.create',
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
      verification: args.verification,
    },
  });
}

/**
 * Build the create-contest AgentEffect from the SDK result. Extracted
 * so the failure-envelope path (Hermes PR-71 blocker: when
 * waitForVerified throws AFTER the create tx landed, the failure
 * envelope must preserve the create tx) can reuse the same shape.
 */
export function buildCreateContestEffect(result: ContestCreateResult): AgentEffect {
  const status = result.receipt.status === 'success' ? 'confirmed' : 'reverted';
  return {
    type: 'transaction',
    purpose: 'create-contest',
    ok: result.receipt.status === 'success',
    txHash: result.txHash as Hex,
    blockNumber: result.receipt.blockNumber.toString(),
    status,
  };
}
