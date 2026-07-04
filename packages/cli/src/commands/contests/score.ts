/**
 * `ospex contests score <contestId>` — submit a scoring request to
 * CreOracleReceiver.requestScore (R5/CRE). Permissionless and free (no
 * USDC fee, no LINK) — the contest must already be Verified and the call
 * reverts until its on-chain start time has passed.
 *
 * Without `--wait` it returns immediately after on-chain inclusion; the
 * CRE oracle report (with the actual score) lands ~30-90 s later, and the
 * caller can poll `ospex contests wait-scored <id>` / `score-status <id>`.
 *
 * With `--wait` it polls on-chain until the contest reaches Scored (or
 * Voided). Because the CRE score report rides a best-effort log trigger
 * that can silently drop, `--wait` re-requests scoring ONCE (idempotent +
 * free) after the first poll window elapses without a report, then waits
 * one more window before surfacing a timeout. An unscored contest
 * auto-voids and refunds after the void cooldown, so funds never lock.
 */
import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  type AgentEffect,
  type AgentEnvelope,
  type AgentWarning,
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
  COMPLETE_CONTESTS_WAIT_SCORED,
  VERIFY_CONTEST,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import { contestVoidedWarning, renderScoredLine, resolveTeamsBestEffort } from './scoreDisplay.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
  wait: z.boolean().optional(),
  waitTimeoutSeconds: z.coerce.number().int().positive().max(3600).optional(),
  pollIntervalSeconds: z.coerce.number().int().positive().max(3600).optional(),
});

/** Poll-window default surfaced in the human "Waiting…" line. */
const DEFAULT_WAIT_WINDOW_SECONDS = 120;

type WaitForScoredOutcome = Awaited<ReturnType<OspexClient['contests']['waitForScored']>>;

export const contestScoreCommand = addSignerOptions(
  new Command('score')
    .description('Submit CreOracleReceiver.requestScore for an existing contest (R5/CRE; free).')
    .argument('<contestId>', 'contest id (uint256)')
    .addOption(new Option('--json').hideHelp(false)),
)
  .option(
    '--wait',
    'after sending requestScore, poll on-chain until the contest is Scored ' +
      '(auto re-requests once on a dropped CRE callback)',
  )
  .option('--wait-timeout-seconds <n>', 'per-poll-window timeout for --wait (default 120)')
  .option('--poll-interval-seconds <n>', 'poll interval for --wait (default 4)')
  .action(async (contestIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });
    const chainId = client.chainId();
    const wantJson = opts.json === true;
    const wantWait = opts.wait === true;
    const contestId = BigInt(contestIdArg);
    let signerAddress: Hex | null = null;

    try {
    // Resolve the signer address up-front so a failure envelope from
    // the catch below still carries `wallet` / `signer` populated —
    // a CHAIN_ERROR during score otherwise lands with both fields
    // `null` even though the keystore was already unlocked.
    signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;

    const result = await client.contests.score({ contestId });

    if (!wantJson) {
      process.stdout.write(`Scoring request sent (tx ${result.txHash}).\n`);
    }

    // --wait: poll on-chain for the Scored transition, re-requesting once
    // on a dropped CRE callback (requestScore is idempotent + free).
    let scoring: WaitForScoredOutcome | null = null;
    let scoringError: unknown = null;
    // The auto re-request (a SECOND requestScore tx sent when the first CRE
    // callback drops) — captured so its tx lands in the envelope's effects[]
    // ledger too, not just the first score tx. An execute envelope must record
    // EVERY on-chain write the command performed.
    let reRequestResult: ContestScoreResult | null = null;
    if (wantWait) {
      const waitOpts: Parameters<typeof client.contests.waitForScored>[1] = {};
      if (opts.waitTimeoutSeconds !== undefined) waitOpts.timeoutMs = opts.waitTimeoutSeconds * 1000;
      if (opts.pollIntervalSeconds !== undefined) {
        waitOpts.pollIntervalMs = opts.pollIntervalSeconds * 1000;
      }
      const windowSeconds = opts.waitTimeoutSeconds ?? DEFAULT_WAIT_WINDOW_SECONDS;

      if (!wantJson) {
        process.stdout.write(`Waiting for CRE score report (≤${windowSeconds}s)...\n`);
      }
      try {
        scoring = await client.contests.waitForScored(contestId, waitOpts);
      } catch {
        // First window elapsed with no Scored/Voided — the CRE callback
        // may have dropped. Re-request scoring once (idempotent + free),
        // then wait one more window.
        if (!wantJson) {
          process.stdout.write(
            'No CRE score report yet — re-requesting scoring (idempotent) and waiting again...\n',
          );
        }
        try {
          reRequestResult = await client.contests.score({ contestId });
        } catch {
          // The re-request can revert if the contest JUST scored/voided
          // (or on the start-time guard) — harmless; the poll below reads
          // the authoritative on-chain state either way. A revert leaves
          // reRequestResult null (no tx landed → nothing to add to effects[]).
        }
        try {
          scoring = await client.contests.waitForScored(contestId, waitOpts);
        } catch (secondErr) {
          scoringError = secondErr;
        }
      }

      if (!wantJson) {
        if (scoring !== null && scoring.status === 'voided') {
          process.stdout.write('Contest voided; it will not be scored.\n');
        } else if (scoring !== null) {
          const teams = await resolveTeamsBestEffort(client, contestId);
          process.stdout.write(
            renderScoredLine(teams, scoring.awayScore, scoring.homeScore) + '\n',
          );
        } else if (scoringError !== null) {
          process.stdout.write(
            `Score report did not land in time. Run \`ospex contests wait-scored ${contestId}\` ` +
              'to keep watching (an unscored contest auto-voids and refunds after the cooldown).\n',
          );
        }
      }
    }

    if (wantJson) {
      // signerAddress was resolved at the top of the try; the non-null
      // assertion documents the invariant since the success path needs
      // the Hex (not Hex | null).
      const signerForEnvelope = signerAddress as Hex;
      // Single-envelope discipline (the create double-envelope bug is the
      // cautionary tale): when the wait leg fails AFTER the score tx
      // landed, emit exactly ONE failure envelope that PRESERVES the
      // score-contest tx effect(s) — including the auto re-request tx when it
      // landed — and points at the standalone poll helper.
      if (scoringError !== null) {
        emitJsonFailure({
          action: 'contests.score',
          stage: 'execute',
          chainId,
          wallet: signerForEnvelope,
          walletRole: 'signer',
          signer: signerForEnvelope,
          requiresSignature: true,
          requiresTransaction: true,
          effects: reRequestResult
            ? [buildScoreContestEffect(result), buildScoreContestEffect(reRequestResult)]
            : [buildScoreContestEffect(result)],
          nextCommands: [
            COMPLETE_CONTESTS_WAIT_SCORED.build({ contestId: contestId.toString() }),
          ],
          error: scoringError,
        });
        process.exit(1);
      }
      writeAgentEnvelope(
        toContestScoreAgentEnvelope(result, {
          chainId,
          signerAddress: signerForEnvelope,
          scoring,
          reRequestResult,
        }),
      );
      return;
    }

    // Human mode: surface a wait failure as a non-zero exit (mirrors
    // create). The score tx info + hint were already printed above.
    if (scoringError !== null) throw scoringError;
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

export interface ContestScoringBlock {
  status: 'scored' | 'voided';
  awayScore: number | null;
  homeScore: number | null;
}

export interface ContestScorePayload {
  contestId: string;
  txHash: string;
  status: 'success' | 'reverted';
  /**
   * Populated only under `--wait` once the poll resolves; `null` for the
   * plain fire-and-return call (back-compat: agents that read the score
   * payload today keep seeing the same shape plus a `null` scoring field).
   */
  scoring: ContestScoringBlock | null;
}

export interface ToContestScoreEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex;
  /** The resolved `--wait` outcome (scored / voided), or null/omitted. */
  scoring?: WaitForScoredOutcome | null;
  /**
   * The auto re-request result (`score --wait` sent a second `requestScore`
   * after the first CRE callback dropped), or null/omitted when none landed.
   * When present, its tx is added to `effects[]` as a second `score-contest`
   * effect so the ledger records every on-chain write.
   */
  reRequestResult?: ContestScoreResult | null;
}

export function toContestScoreAgentEnvelope(
  result: ContestScoreResult,
  args: ToContestScoreEnvelopeArgs,
): AgentEnvelope<ContestScorePayload> {
  const scoreEffect = buildScoreContestEffect(result);
  // The auto re-request (score --wait on a dropped callback) is a SECOND on-chain
  // score tx — record it in the effects ledger too, when it landed.
  const effects = args.reRequestResult
    ? [scoreEffect, buildScoreContestEffect(args.reRequestResult)]
    : [scoreEffect];
  const contestIdStr = result.contestId.toString();
  const scoringBlock: ContestScoringBlock | null = args.scoring
    ? {
        status: args.scoring.status,
        awayScore: args.scoring.awayScore,
        homeScore: args.scoring.homeScore,
      }
    : null;
  // A voided resolution is a legitimate terminal outcome (the score tx
  // still succeeded), surfaced as an info warning — NOT an envelope
  // failure.
  const warnings: AgentWarning[] =
    scoringBlock?.status === 'voided' ? [contestVoidedWarning(result.contestId)] : [];
  return buildAgentEnvelope<ContestScorePayload>({
    ok: scoreEffect.ok,
    action: 'contests.score',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    effects,
    warnings,
    nextCommands: [VERIFY_CONTEST.build({ contestId: contestIdStr })],
    payload: {
      contestId: contestIdStr,
      txHash: result.txHash,
      status: result.receipt.status,
      scoring: scoringBlock,
    },
  });
}

/**
 * Build the score-contest AgentEffect from the SDK result. Extracted so
 * the failure-envelope path (when `--wait` throws AFTER the score tx
 * landed) can preserve the score tx in effects[], mirroring
 * `buildCreateContestEffect`.
 */
export function buildScoreContestEffect(result: ContestScoreResult): AgentEffect {
  const status = result.receipt.status === 'success' ? 'confirmed' : 'reverted';
  return {
    type: 'transaction',
    purpose: 'score-contest',
    ok: result.receipt.status === 'success',
    txHash: result.txHash as Hex,
    blockNumber: result.receipt.blockNumber.toString(),
    status,
  };
}
