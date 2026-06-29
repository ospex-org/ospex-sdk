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
 *  - On OspexAllowanceError: prompt to approve USDC → TreasuryModule
 *    (the contest creation fee) and retry. R5/CRE creation is
 *    permissionless and carries no LINK payment, so the only approval
 *    that can be missing is the USDC creation fee.
 *  - Without `--no-wait`, blocks until the CRE oracle report flips the
 *    contest to Verified (or timeout, in which case the contestId is
 *    surfaced and the user can re-poll with `ospex contests wait-verified`).
 */
import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import { formatUnits, parseUnits } from 'viem';
import {
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
import {
  COMPLETE_CONTESTS_WAIT_VERIFIED,
  VERIFY_CONTEST,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import { promptYesNo, promptValue } from '../../lib/prompt.js';

const optionsSchema = z.object({
  gameId: z.string().min(1).optional(),
  game: z.string().min(1).optional(),
  wait: z.boolean().optional(),
  json: z.boolean().optional(),
  yes: z.boolean().optional(),
});

export const contestCreateCommand = addSignerOptions(
  new Command('create')
    .description(
      'Create a contest by submitting CreOracleReceiver.createContestAndRequestVerify (R5/CRE). ' +
        'Permissionless; the caller pays the USDC contest-creation fee (allowance to TreasuryModule).',
    )
    .option('--game-id <id>', 'gameId from `ospex games list` (canonical UUID)')
    .option(
      '--game <slug-or-id>',
      'resolver-friendly alias: pass either the slug from `ospex games list` or a UUID',
    )
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
    // Resolve the signer address up-front so a failure envelope from
    // the catch below still carries `wallet` / `signer` populated —
    // otherwise a CHAIN_ERROR / API_ERROR during create lands with
    // both fields `null` even though the keystore was already
    // unlocked. The signer is guaranteed by `requiresSigner: true`
    // above, so this can't fail with a missing-signer condition.
    signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;

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
      process.stdout.write(`Contest ${result.contestId} created (tx ${result.txHash}).\n`);
    }

    const shouldWait = opts.wait !== false;
    let verification: { contestId: string; status: string } | null = null;
    let verificationError: unknown = null;

    if (shouldWait) {
      if (opts.json !== true) {
        process.stdout.write('Waiting for CRE verification (≤120s)...\n');
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
      // signerAddress was resolved at the top of the try; the
      // non-null assertion documents the invariant for type-narrowing
      // since the success path needs the Hex (not `Hex | null`) form.
      const signerForEnvelope = signerAddress as Hex;
      // review blocker: when waitForVerified throws AFTER the
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
          wallet: signerForEnvelope,
          walletRole: 'signer',
          signer: signerForEnvelope,
          // `contests create` is a write command — advertise the
          // intent in the failure envelope so agents recovering from
          // verification-poll failure see `requiresTransaction: true`
          // (the tx already landed; the verify poll timed out).
          requiresSignature: true,
          requiresTransaction: true,
          effects: [...approveEffects, buildCreateContestEffect(result)],
          // Verification poll didn't land — suggest the standalone
          // wait-verified helper so the agent can keep polling.
          nextCommands: [
            COMPLETE_CONTESTS_WAIT_VERIFIED.build({
              contestId: result.contestId.toString(),
            }),
          ],
          error: verificationError,
        });
        process.exit(1);
      }
      writeAgentEnvelope(
        toContestCreateAgentEnvelope(result, {
          chainId,
          signerAddress: signerForEnvelope,
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
      // The failure-envelope scope: preserve any approve txs that succeeded
      // before the create call threw. Without this, a wallet that
      // approves the USDC creation fee successfully and then hits a
      // create-time revert would lose the approve tx hash to stderr.
      if (wantJson) {
        emitJsonFailure({
          action: 'contests.create',
          stage: 'execute',
          chainId,
          // signerAddress is populated at the top of the try and
          // therefore set even when the catch fires before any side
          // effect (the historical null was the bug fixed here).
          wallet: signerAddress,
          walletRole: 'signer',
          signer: signerAddress,
          // `contests create` is a write command — advertise the
          // intent in the failure envelope so agents see this is a
          // sig+tx command, not a no-op preview.
          requiresSignature: true,
          requiresTransaction: true,
          effects: approveEffects,
          nextCommands: deriveRemediationNextCommands(err, chainId),
          error: err,
        });
        process.exit(1);
      }
      throw err;
    }
  });

interface AllowanceCopy {
  symbol: 'USDC';
  decimals: number;
  moduleName: string;
  purpose: string;
}

// R5/CRE creation charges only the USDC contest-creation fee (allowance
// to TreasuryModule); there is no LINK payment, so the only allowance
// error a create call can raise is USDC → TreasuryModule.
function describeAllowance(): AllowanceCopy {
  return {
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
  const copy = describeAllowance();
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

  const tx = await client.contests.approveFee(approveAmount);
  process.stdout.write(`approve tx: ${tx.txHash} (status ${tx.receipt.status})\n`);
  approveEffects.push({
    type: 'transaction',
    purpose: 'approve-usdc',
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
  // nextCommands: always verify the contest detail. When the verify
  // poll didn't run / didn't land, also suggest the standalone
  // wait-verified helper. Cap is 3; we ship 1–2 here.
  const contestIdStr = result.contestId.toString();
  const nextCommands = [
    VERIFY_CONTEST.build({ contestId: contestIdStr }),
    ...(args.verification === null
      ? [COMPLETE_CONTESTS_WAIT_VERIFIED.build({ contestId: contestIdStr })]
      : []),
  ];
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
    nextCommands,
    payload: {
      contestId: contestIdStr,
      txHash: result.txHash,
      status: result.receipt.status,
      verification: args.verification,
    },
  });
}

/**
 * Build the create-contest AgentEffect from the SDK result. Extracted
 * so the failure-envelope path (review blocker: when
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
