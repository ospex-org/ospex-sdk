/**
 * `ospex commitments match <hash-or-prefix> [flags]` — high-level
 * domain-language match. Mirrors `commitments submit`'s preview /
 * confirm / approve / sign flow:
 *
 *   0. Early non-TTY guard. Refuses runs without `--yes` on
 *      non-interactive stdin BEFORE any signer-unlock work, so the
 *      user gets an actionable "--yes is required" message instead of
 *      a cryptic "hidden input requires a TTY" failure from the
 *      keystore passphrase prompt. `--json` alone is allowed past the
 *      guard so an agent's preview-only path stays consumable from a
 *      script (see step 3).
 *   1. Resolve input via `client.commitments.resolveByPrefix` so the
 *      truncated `0x…` from `commitments list` is actionable. Echoes
 *      the full resolved hash to stderr if the input was a prefix.
 *   2. Call `client.commitments.prepareMatch({ commitment, ... })` —
 *      no signing yet. Returns a structured `MatchPreview`. Note:
 *      preparing the preview reads the taker address from the signer
 *      (for `selfMatch` and the allowance preflight), so the keystore
 *      passphrase prompt may fire even on the `--json`-alone path
 *      when no session is cached. This mirrors `commitments submit`.
 *   3. `--json` alone (no `--yes`) → emit a v2 `AgentEnvelope`
 *      (`stage: 'preview'`, `payload: MatchPreview`), exit. Agent flow:
 *      inspect tuple before deciding whether to execute.
 *   4. Render the preview to stderr; prompt to confirm unless `--yes`.
 *      Decline → exit 130 (Ctrl-C convention).
 *   5. Run any required approvals (commitment-risk on PositionModule;
 *      lazy-creation-fee on TreasuryModule when the commitment matches
 *      a not-yet-created speculation). `--no-auto-approve` refuses before
 *      this step; `--approve-max` is the non-interactive shorthand for
 *      unlimited; otherwise prompt.
 *   6. Call `client.commitments.matchFromPreview(preview)` — always
 *      re-fetches and re-checks state immediately before sending.
 *
 * `--risk-usdc` is the TAKER's desired risk / max outlay (USDC
 * decimal). The matching engine computes the maker fill from this
 * value and the maker's odds — at +260, e.g., a taker risking 1.6
 * USDC fully fills a maker risking 1 USDC. The preview always shows
 * both `takerRisk` AND `fillMakerRisk` so the user can verify both
 * sides of the fill.
 */

import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  OspexAPIError,
  OspexValidationError,
  computeMatchYouView,
  usdcDecimalToAmountWei6,
  wei6ToDecimalUSDC,
  type AgentEffect,
  type AgentEnvelope,
  type AgentPayout,
  type AgentWarning,
  type ApprovalPurpose,
  type ApprovalRequirement,
  type ChainId,
  type CheckCommitmentFillabilityResult,
  type Commitment,
  type FillabilityReasonCode,
  type Hex,
  type MatchPreview,
  type MatchPreviewWarning,
  type PerspectiveAmount,
  type PreviewContest,
  type SpeculationMode,
} from '@ospex/sdk';
import type { MatchPreviewSpeculation } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  emitJsonFailureAndExit,
  mapPreviewApprovals,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import {
  buildMatchRefusedEnvelope,
  computeMatchRemediatedReasonCodes,
  hasRemediableShortfall,
  renderMatchPreflightRefusal,
  selectBlockingMatchReasons,
} from '../../lib/matchFillabilityPreflight.js';
import { refuseRequiredAutoApproval } from '../../lib/noAutoApprove.js';
import {
  VERIFY_COMMITMENT,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { getClient, resolvePreviewAddress } from '../../lib/client.js';
import { sanitizeUntargetedMessage } from '../../lib/redact.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import { promptValue, promptYesNo } from '../../lib/prompt.js';
import { renderMatchPreview } from '../../lib/matchPreviewRender.js';

const optionsSchema = z.object({
  riskUsdc: z.string().min(1, '--risk-usdc cannot be empty').optional(),
  yes: z.boolean().optional(),
  json: z.boolean().optional(),
  approveMax: z.boolean().optional(),
  autoApprove: z.boolean().optional(),
  raw: z.boolean().optional(),
  skipFillabilityPreflight: z.boolean().optional(),
  force: z.boolean().optional(),
});

export const commitmentsMatchCommand = addSignerOptions(
  new Command('match')
    .description(
      'Match an existing commitment as the taker. Renders a preview block before signing; ' +
        'pass --yes to skip the prompt. Accepts a full 0x-prefixed 32-byte hash OR a unique ' +
        '0x-prefixed hex prefix (≥ 8 hex chars after 0x).',
    )
    .argument('<hash-or-prefix>', 'full commitment hash, or unique 0x-prefixed hex prefix')
    .option(
      '--risk-usdc <decimal>',
      'taker desired risk / taker max outlay in decimal USDC (e.g. "1" or "0.5"). ' +
        "The matching engine computes the maker fill from this and the maker's odds — " +
        "at +260, a taker risking 1.6 USDC fully fills a maker risking 1 USDC. The preview " +
        'shows both takerRisk AND fillMakerRisk so the relationship is visible. Default: ' +
        'fully fill the maker remaining capacity.',
    )
    .option('--yes', 'skip the confirmation prompt')
    .option(
      '--approve-max',
      'with --yes (non-interactive), approve unlimited USDC instead of the exact required amount. ' +
        'Ignored in interactive mode — to grant unlimited interactively, type "max" at the amount prompt.',
    )
    .option(
      '--no-auto-approve',
      'refuse before signing or sending when a USDC approval would be required instead of ' +
        'sending an approval automatically. Use when approvals are executed and ledgered separately.',
    )
    .option(
      '--raw',
      'render the protocol-native dual maker/taker layout (maker side / taker side lines, ' +
        '[oddsTick=…], protocol line ticks, raw approval wei6 figures) instead of the default ' +
        'first-person view. Useful for debugging EIP-712 hash mismatches and protocol-level audits. ' +
        '(Note: only `commitments submit --raw` restores the `positionType=Upper/Lower` tag; ' +
        'the match render never emitted positionType in any layout.) ' +
        'Has no effect on --json output.',
    )
    .option(
      '--skip-fillability-preflight',
      'skip the advisory pre-send fillability check. By default `match` reads maker/taker ' +
        'USDC balances + the maker PositionModule allowance and REFUSES (before sending) a match ' +
        'that would revert for a non-remediable reason. This flag proceeds anyway.',
    )
    .option(
      '--force',
      'alias for --skip-fillability-preflight in the match flow — proceed despite a failed ' +
        'fillability preflight (the match may revert and spend gas).',
    )
    .addOption(
      new Option(
        '--json',
        'machine-readable output. ALONE = preview only, no signing (v2 AgentEnvelope, stage "preview", payload MatchPreview). ' +
          'WITH --yes = signs/sends and emits a v2 AgentEnvelope (stage "execute", payload { preview, result, fillability, preflightFillability?, approvalRemediation? }). ' +
          '`fillability` is the EFFECTIVE send-time verdict (post-approval re-check when the auto-approve loop confirmed); when that re-check ran, `preflightFillability` preserves the pre-approval verdict.',
      ).hideHelp(false),
    ),
)
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const wantJson = opts.json === true;
    const skipPrompt = opts.yes === true;
    const approveMax = opts.approveMax === true;
    const raw = opts.raw === true;
    const isInteractive = process.stdin.isTTY === true;
    const previewOnly = wantJson && !skipPrompt;

    // ── 0. Early non-TTY guard. ────────────────────────────────────
    // Refuses runs that would hang on a confirmation prompt (no
    // `--yes`) before we trigger any signer unlock. `--json` alone
    // (preview-only for agents) is handled separately below — it
    // resolves the taker address from --expected-address or non-
    // interactive credentials rather than calling loadSigner.
    if (!skipPrompt && !wantJson && !isInteractive) {
      throw new OspexValidationError(
        '--yes is required for non-interactive runs of `commitments match`. Re-run with --yes.',
      );
    }

    // ── 1. Lazy signer split. ──────────────────────────────────────
    // Preview-only mode (`--json` without `--yes`): compute the
    // preview WITHOUT calling `loadSigner`. A hard review rule —
    // agents should never get an interactive
    // passphrase prompt from a preview-only invocation. We resolve
    // the taker address via `resolvePreviewAddress`:
    //   1. `--expected-address` → use it directly, no I/O at all.
    //   2. Non-interactive credentials (--account + --password-file,
    //      OSPEX_PASSWORD_FILE env, etc.) → unlock silently and
    //      derive.
    //   3. Cached legacy session → use cached address.
    //   4. Else throw `non_interactive_password_required`.
    //
    // Sign mode (interactive or `--yes`): loadSigner runs as before,
    // unlocking the keystore for the sign step. The preview is
    // computed using the unlocked address.
    const client = previewOnly
      ? await getClient({ requiresChain: true })
      : await getClient({ requiresSigner: true, requiresChain: true, signerIntent });

    // Failure-envelope state — wallet known once
    // prepareMatch sets preview.taker; approveEffects accumulates
    // during the approval loop. Catch at bottom emits a v2 failure
    // envelope that preserves any confirmed approve txs. `confirmedApprovalPurposes`
    // tracks which approval `purpose` rows produced a confirmed tx — used
    // below to populate `payload.approvalRemediation.approvalPurposes` so
    // an agent can see what the auto-approve loop resolved without
    // diff'ing pre/post fillability reasons themselves.
    const chainId = client.chainId();
    let wallet: Hex | null = null;
    const approveEffects: AgentEffect[] = [];
    const confirmedApprovalPurposes: ApprovalPurpose[] = [];
    const stageForFailure: 'preview' | 'execute' = previewOnly ? 'preview' : 'execute';

    try {
    // ── 2. Resolve the taker address up-front so a failure envelope
    //    from the catch below carries wallet/signer populated even
    //    when the throw happens inside resolveByPrefix / prepareMatch
    //    (API/RPC error, unknown commitment hash, validation revert).
    if (previewOnly) {
      wallet = (await resolvePreviewAddress(signerIntent)).toLowerCase() as Hex;
    } else {
      wallet = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;
    }

    // ── 3. Resolve input via the SDK's prefix resolver. ─────────────
    // Match scope is open + partially_filled (live commitments).
    const commitment = await client.commitments.resolveByPrefix(hashArg, {
      status: ['open', 'partially_filled'],
    });
    if (commitment.commitmentHash.toLowerCase() !== hashArg.toLowerCase()) {
      // Prefix → full echo to stderr (never stdout — preserves --json).
      process.stderr.write(
        `Resolved ${hashArg} → ${commitment.commitmentHash}\n`,
      );
    }

    // ── 4. Prepare match preview. ─────────────────────────────────
    // In preview-only mode, pass `taker` as an explicit override so
    // prepareMatch skips its signer.getAddress() call entirely.
    const prepArgs: Parameters<typeof client.commitments.prepareMatch>[0] = {
      commitment,
    };
    if (opts.riskUsdc !== undefined) {
      prepArgs.takerDesiredRiskWei6 = usdcDecimalToAmountWei6(opts.riskUsdc);
    }
    if (previewOnly) {
      prepArgs.taker = wallet;
    }
    const preview = await client.commitments.prepareMatch(prepArgs);

    // ── 4. --json alone (no --yes) is preview-only — emit + exit. ──
    if (previewOnly) {
      writeAgentEnvelope(toMatchPreviewEnvelope(preview, { chainId }));
      return;
    }

    refuseRequiredAutoApproval(
      preview.approvals,
      opts.autoApprove === false,
      chainId,
      'commitments match',
    );

    // ── 4.5 Fillability preflight (execute path). ──────────────────
    // Refuse an obviously-unfillable match BEFORE rendering, approving,
    // or sending — so the operator never confirms (and never spends
    // gas on) a match that would revert. The approval loop below
    // already remediates the TAKER's allowance, so we block ONLY on the
    // non-remediable reasons (maker balance/allowance, taker balance,
    // liveness, closed-spec); `FILLABILITY_UNKNOWN` (a failed read) is
    // advisory — warn, don't block. Bypass with
    // --skip-fillability-preflight / --force. The pre-approval verdict
    // is preserved as `preflightFillability` and (when an approve loop
    // confirms) is re-checked post-approval below; both are threaded
    // into the execute envelope. A `null` `payload.fillability` means
    // the preflight was skipped.
    let preflightFillability: CheckCommitmentFillabilityResult | null = null;
    const skipFillability = opts.skipFillabilityPreflight === true || opts.force === true;
    const fillArgs: Parameters<typeof client.commitments.checkCommitmentFillability>[0] = {
      commitment,
      taker: preview.taker,
    };
    if (opts.riskUsdc !== undefined) {
      fillArgs.takerDesiredRiskWei6 = usdcDecimalToAmountWei6(opts.riskUsdc);
    }
    if (!skipFillability) {
      preflightFillability = await client.commitments.checkCommitmentFillability(fillArgs);
      const blocking = selectBlockingMatchReasons(preflightFillability.reasons);
      if (blocking.length > 0) {
        if (wantJson) {
          writeAgentEnvelope(
            buildMatchRefusedEnvelope(preflightFillability, blocking, {
              chainId,
              wallet: preview.taker,
            }),
          );
        } else {
          process.stderr.write(renderMatchPreflightRefusal(blocking));
        }
        process.exit(1);
      }
      if (preflightFillability.outcome === 'unknown') {
        process.stderr.write(
          'Fillability preflight: funding could not be confirmed (an on-chain read failed). ' +
            'Proceeding — the match may revert. Re-run, or pass --skip-fillability-preflight to silence.\n',
        );
      }
    }

    // ── 5. Render preview + confirm (unless --yes). ────────────────
    renderMatchPreview(preview, process.stderr, { raw });
    if (!skipPrompt) {
      const ok = await promptYesNo('Match?', true);
      if (!ok) {
        process.stderr.write('Match cancelled.\n');
        process.exit(130);
      }
    }

    // ── 6. Run approvals if needed. ────────────────────────────────
    // commitment-risk → PositionModule (always present); lazy-creation-fee
    // → TreasuryModule (present iff speculation.mode === 'lazy').
    //
    // Each approve tx is recorded as an
    // AgentEffect (collected in `approveEffects`, declared at the
    // top of the action so the failure-envelope catch can also
    // surface already-confirmed approves on a mid-flight throw)
    // and prepended to the execute envelope's effects[] below.
    // Agents that parse --json need the approve tx hashes/statuses
    // alongside the final match tx — those approvals are real
    // on-chain side effects the command performed.
    for (const row of preview.approvals) {
      if (!row.needsApproval || row.token !== 'USDC') continue;
      const requiredWei6 = BigInt(row.required);
      const currentWei6 = BigInt(row.current);
      let approveAmount: bigint | 'max';

      if (skipPrompt) {
        approveAmount = approveMax ? 'max' : requiredWei6;
      } else {
        const requiredHuman = wei6ToDecimalUSDC(requiredWei6);
        const currentHuman = wei6ToDecimalUSDC(currentWei6);
        const copy = approvalCopy(row.purpose);
        process.stderr.write(
          `\nUSDC approval needed (${copy.headerLabel}).\n` +
            `${'  '}Required: ${requiredHuman} USDC\n` +
            `${'  '}Approved: ${currentHuman} USDC\n` +
            `\n${copy.description}\n` +
            `${'  '}Spender: ${row.spender} (${copy.moduleName})\n`,
        );
        const allow = await promptYesNo(
          `Allow ${copy.moduleName} to spend USDC from your wallet?`,
          true,
        );
        if (!allow) {
          process.stderr.write('Approval declined; match cancelled.\n');
          process.exit(130);
        }
        const choice = await promptValue(
          'Amount in USDC (number, or "max" for unlimited)',
          requiredHuman,
        );
        if (choice.toLowerCase() === 'max') {
          approveAmount = 'max';
        } else {
          let parsed: bigint;
          try {
            parsed = usdcDecimalToAmountWei6(choice);
          } catch {
            process.stderr.write(`Could not parse "${choice}" as a USDC amount.\n`);
            process.exit(1);
          }
          if (parsed < requiredWei6) {
            process.stderr.write(
              `Amount ${choice} USDC is less than the required ${requiredHuman} USDC.\n`,
            );
            process.exit(1);
          }
          approveAmount = parsed;
        }
      }

      const display =
        approveAmount === 'max'
          ? 'unlimited'
          : `${wei6ToDecimalUSDC(approveAmount)} USDC (${approveAmount} wei6)`;
      process.stderr.write(`Approving USDC → ${row.spender} (${display})...\n`);
      const approveResult =
        row.purpose === 'lazy-creation-fee'
          ? await client.commitments.approveCreationFee(approveAmount)
          : await client.commitments.approve(approveAmount);
      process.stderr.write(
        `approve tx: ${approveResult.txHash} (status ${approveResult.receipt.status})\n`,
      );
      approveEffects.push({
        type: 'transaction',
        purpose: 'approve-usdc',
        ok: approveResult.receipt.status === 'success',
        txHash: approveResult.txHash as Hex,
        blockNumber: approveResult.receipt.blockNumber.toString(),
        status: approveResult.receipt.status === 'success' ? 'confirmed' : 'reverted',
      });
      if (approveResult.receipt.status === 'success') {
        confirmedApprovalPurposes.push(row.purpose);
      }
    }

    // ── 6.5 Post-approval fillability re-check. ────────────────────
    // When the approve loop confirmed at least one tx, the pre-approval
    // verdict is now stale (its reasons reflected the on-chain state at
    // step 4.5, before approve-usdc landed). Re-run the same check so
    // `payload.fillability` carries the EFFECTIVE send-time verdict; the
    // pre-approval verdict is preserved under `payload.preflightFillability`.
    //   - Skip when no approve confirmed (pre = post; no extra RPC hop).
    //   - Skip when the preflight was skipped (--force / --skip-fillability-
    //     preflight; we have no pre-state to fork from, fillability stays null).
    //   - On re-check throw, fall back to a synthetic `unknown` verdict so the
    //     envelope never silently keeps stale "not-fillable" reasons. The
    //     match itself still proceeds — re-check is informational, not a gate.
    let effectiveFillability: CheckCommitmentFillabilityResult | null = preflightFillability;
    if (preflightFillability !== null && confirmedApprovalPurposes.length > 0) {
      try {
        effectiveFillability = await client.commitments.checkCommitmentFillability(fillArgs);
      } catch (err) {
        process.stderr.write(
          'Post-approval fillability re-check failed; proceeding with the match. ' +
            `(${sanitizeUntargetedMessage(err instanceof Error ? err.message : String(err))})\n`,
        );
        effectiveFillability = {
          commitmentHash: preflightFillability.commitmentHash,
          fillableNow: false,
          outcome: 'unknown',
          advisory: true,
          reasons: [{ code: 'FILLABILITY_UNKNOWN' }],
        };
      }
    }

    // ── 7. Sign + send. matchFromPreview always re-fetches first. ──
    let result;
    try {
      result = await client.commitments.matchFromPreview(preview);
    } catch (err) {
      if (err instanceof OspexAPIError && err.apiCode === 'NONCE_TOO_LOW') {
        process.stderr.write(
          'Maker activity changed between preview and submit. Re-run the command to refresh.\n',
        );
      }
      throw err;
    }

    if (wantJson) {
      const reranRecheck =
        preflightFillability !== null &&
        confirmedApprovalPurposes.length > 0 &&
        effectiveFillability !== null &&
        effectiveFillability !== preflightFillability;
      const remediatedReasonCodes =
        reranRecheck && preflightFillability !== null && effectiveFillability !== null
          ? computeMatchRemediatedReasonCodes(preflightFillability, effectiveFillability)
          : [];
      const approvalRemediation =
        confirmedApprovalPurposes.length > 0
          ? {
              remediatedReasonCodes,
              approvalPurposes: confirmedApprovalPurposes,
            }
          : undefined;
      const builderArgs: ToMatchExecuteEnvelopeArgs = {
        chainId,
        approveEffects,
        fillability: effectiveFillability,
      };
      if (reranRecheck && preflightFillability !== null) {
        builderArgs.preflightFillability = preflightFillability;
      }
      if (approvalRemediation !== undefined) {
        builderArgs.approvalRemediation = approvalRemediation;
      }
      writeAgentEnvelope(
        toMatchExecuteEnvelope(
          preview,
          {
            txHash: result.txHash as Hex,
            status: result.receipt.status,
            blockNumber: result.receipt.blockNumber.toString(),
            takerRiskWei6: result.takerRisk.toString(),
            fillMakerRiskWei6: result.fillMakerRisk.toString(),
          },
          builderArgs,
        ),
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        status: result.receipt.status,
        takerRisk: wei6ToDecimalUSDC(result.takerRisk),
        fillMakerRisk: wei6ToDecimalUSDC(result.fillMakerRisk),
        blockNumber: result.receipt.blockNumber.toString(),
      },
      { json: false },
    );
    } catch (err) {
      // Failure-envelope scope: --json failures emit a v2 failure envelope
      // that preserves any approve txs already confirmed before the
      // throw. NONCE_TOO_LOW (or any other matchFromPreview revert)
      // would otherwise drop those approve tx hashes to stderr.
      if (wantJson) {
        await emitJsonFailureAndExit({
          action: 'commitments.match',
          stage: stageForFailure,
          chainId,
          wallet,
          // Spec §3.2 / §5.1: preview-only sign envelopes are
          // signer-intent envelopes (the resolved address is the
          // would-be signer). Failure envelopes mirror the
          // success-path contract — toMatchPreviewEnvelope also
          // emits walletRole:'signer', signer: wallet.
          walletRole: 'signer',
          signer: wallet,
          // match intends to sign + send (and possibly run an approve
          // tx first). Both flags reflect that intent on failure so an
          // agent sees this was a write command, not a no-op read.
          // previewOnly is also write-intent — the preview describes
          // what `--yes` WOULD have signed/sent.
          requiresSignature: true,
          requiresTransaction: true,
          effects: approveEffects,
          nextCommands: deriveRemediationNextCommands(err, chainId),
          error: err,
        });
      }
      throw err;
    }
  });

// ── v1 → v2 envelope transforms ────────────────────────────────────

/**
 * `payload` shape for `commitments match --json` (preview-only).
 * Strips MatchPreview's inner `schemaVersion: 1` — the outer v2
 * envelope is the only schemaVersion marker (review contract,
 * enforced by buildAgentEnvelope's payload guard).
 */
export type MatchPreviewPayload = Omit<MatchPreview, 'schemaVersion'>;

export interface MatchExecuteResult {
  txHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: string;
  takerRiskWei6: string;
  fillMakerRiskWei6: string;
}

/** `payload` shape for `commitments match --yes --json` (executed). */
export interface MatchExecutePayload {
  preview: MatchPreviewPayload;
  result: MatchExecuteResult;
  /**
   * The **effective** send-time fillability verdict.
   *
   * - When the auto-approve loop confirmed at least one tx, this is the
   *   post-approval re-check (a fresh `checkCommitmentFillability` ran
   *   between the approve loop and the match send). The original
   *   pre-approval verdict is preserved under `preflightFillability`.
   * - When no approve was needed (or none confirmed), this is the same
   *   verdict the preflight produced — `preflightFillability` is omitted.
   * - `null` when the preflight was skipped (--skip-fillability-preflight
   *   / --force).
   * - `outcome: 'unknown'` (with `reasons: [{ code: 'FILLABILITY_UNKNOWN' }]`)
   *   when the post-approval re-check itself failed — the match still proceeded,
   *   but the envelope refuses to fabricate a clean verdict from stale data.
   */
  fillability: CheckCommitmentFillabilityResult | null;
  /**
   * The original pre-approval verdict, preserved for auditability. Present
   * **only** when the auto-approve loop confirmed at least one tx AND the
   * preflight was run — i.e. exactly when `fillability` carries the
   * post-approval re-check rather than the original verdict.
   */
  preflightFillability?: CheckCommitmentFillabilityResult;
  /**
   * Summary of what the auto-approve loop resolved. Present **only** when at
   * least one approve tx confirmed during this command.
   *
   * - `remediatedReasonCodes`: codes that were in `preflightFillability.reasons`
   *   but are absent in `fillability.reasons`, intersected with the
   *   taker-allowance reasons the approve loop is designed to remediate
   *   (`TAKER_POSITION_ALLOWANCE_INSUFFICIENT`,
   *   `TAKER_TREASURY_ALLOWANCE_INSUFFICIENT`). Empty when the re-check itself
   *   returned `unknown` or the pre-verdict had no remediable shortfall.
   * - `approvalPurposes`: which `ApprovalPurpose` rows the loop confirmed
   *   (subset of `'commitment-risk' | 'lazy-creation-fee'`).
   */
  approvalRemediation?: {
    remediatedReasonCodes: FillabilityReasonCode[];
    approvalPurposes: ApprovalPurpose[];
  };
}

export interface ToMatchEnvelopeArgs {
  chainId: ChainId;
}

export interface ToMatchExecuteEnvelopeArgs extends ToMatchEnvelopeArgs {
  /**
   * Effects from any approve txs that ran before the final match
   * tx. Prepended to the envelope's `effects[]` so agents see the
   * full chronological log of on-chain actions — `commitment-risk`
   * approve, `lazy-creation-fee` approve, then the match tx.
   *
   * Empty (or omitted) when no approvals were needed.
   */
  approveEffects?: AgentEffect[];
  /**
   * The **effective** send-time fillability verdict (post-approval re-check
   * when an approve confirmed; otherwise the original preflight verdict).
   * `null` when the preflight was skipped. Threaded into `payload.fillability`.
   */
  fillability?: CheckCommitmentFillabilityResult | null;
  /**
   * The original pre-approval verdict, present only when the caller ran a
   * post-approval re-check. Threaded into `payload.preflightFillability`.
   */
  preflightFillability?: CheckCommitmentFillabilityResult;
  /**
   * Approval-remediation summary, present only when at least one approve tx
   * confirmed. Threaded into `payload.approvalRemediation`.
   */
  approvalRemediation?: {
    remediatedReasonCodes: FillabilityReasonCode[];
    approvalPurposes: ApprovalPurpose[];
  };
}

/**
 * Preview-only envelope. requiresTransaction is true because matching
 * dispatches an on-chain tx at execute time (vs submit which only
 * POSTs to the API). The maker's commitment being filled is exposed
 * via the shoulder `commitment` field so generic agents render it
 * without inspecting payload.
 */
export function toMatchPreviewEnvelope(
  preview: MatchPreview,
  args: ToMatchEnvelopeArgs,
): AgentEnvelope<MatchPreviewPayload> {
  const { schemaVersion: _legacy, ...payload } = preview;
  const wallet = preview.taker.toLowerCase() as Hex;
  const shoulder = derivePreviewMatchShoulder(preview, args.chainId);
  return buildAgentEnvelope<MatchPreviewPayload>({
    ok: true,
    action: 'commitments.match',
    stage: 'preview',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet,
    walletRole: 'signer',
    signer: wallet,
    requiresSignature: true,
    requiresTransaction: true,
    approvalRequirements: shoulder.approvalRequirements,
    risk: shoulder.risk,
    payout: shoulder.payout,
    contest: shoulder.contest,
    speculation: shoulder.speculation,
    commitment: preview.commitment,
    sideSummary: shoulder.sideSummary,
    warnings: shoulder.warnings,
    payload,
  });
}

/**
 * Executed envelope. effects records the on-chain match tx; the
 * shoulder fields carry through from the preview so an agent reading
 * only the execute envelope still gets full context.
 */
export function toMatchExecuteEnvelope(
  preview: MatchPreview,
  result: MatchExecuteResult,
  args: ToMatchExecuteEnvelopeArgs,
): AgentEnvelope<MatchExecutePayload> {
  const { schemaVersion: _legacy, ...previewPayload } = preview;
  const wallet = preview.taker.toLowerCase() as Hex;
  const fillability = args.fillability ?? null;
  const shoulder = deriveExecuteMatchShoulder(preview, args.chainId, fillability);
  const approveEffects = args.approveEffects ?? [];
  const matchEffect: AgentEffect = {
    type: 'transaction',
    purpose: 'match-commitment',
    ok: result.status === 'success',
    txHash: result.txHash,
    blockNumber: result.blockNumber,
    status: result.status === 'success' ? 'confirmed' : 'reverted',
  };
  // Chronological order: approve txs land first, then the match tx.
  const effects: AgentEffect[] = [...approveEffects, matchEffect];
  const payload: MatchExecutePayload = {
    preview: previewPayload,
    result,
    fillability,
  };
  if (args.preflightFillability !== undefined) {
    payload.preflightFillability = args.preflightFillability;
  }
  if (args.approvalRemediation !== undefined) {
    payload.approvalRemediation = args.approvalRemediation;
  }
  return buildAgentEnvelope<MatchExecutePayload>({
    ok: effects.every((e) => e.ok),
    action: 'commitments.match',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet,
    walletRole: 'signer',
    signer: wallet,
    risk: shoulder.risk,
    payout: shoulder.payout,
    contest: shoulder.contest,
    speculation: shoulder.speculation,
    commitment: preview.commitment,
    sideSummary: shoulder.sideSummary,
    warnings: shoulder.warnings,
    effects,
    nextCommands: [
      VERIFY_COMMITMENT.build({ hash: preview.commitment.commitmentHash }),
    ],
    payload,
  });
}

interface MatchShoulder {
  approvalRequirements: ApprovalRequirement[];
  risk: PerspectiveAmount | null;
  payout: AgentPayout | null;
  contest: PreviewContest;
  speculation: SpeculationMode;
  sideSummary: string | null;
  warnings: AgentWarning[];
}

/**
 * Shared body of preview + execute shoulder derivation. Lifts the
 * `MatchPreviewWarning` enum into structured `AgentWarning[]` entries with
 * stable codes (the enum values themselves are the codes).
 *
 * `contest` is the v1 MatchPreviewContest, which differs from the v2
 * `PreviewContest` shoulder shape (extra fields). We pass it through as-is —
 * agents depending on the canonical `PreviewContest` shape will get the same
 * data plus a couple of extras; mapping to the strict v2 shape is queued for
 * PR-6.
 *
 * `speculation` is reshaped to fit the v2 `SpeculationMode` shoulder (which
 * mirrors what `commitments submit` emits) so both write commands present the
 * same shape under `envelope.speculation`.
 *
 * The `allowance-short` warning is layered on top by the caller (preview vs
 * execute) — preview sources it from `preview.approvals[]`, execute sources
 * it from the post-approval fillability verdict so the success envelope
 * doesn't carry a stale "blocking" warning for an allowance the approve loop
 * already remediated.
 */
function deriveMatchShoulderBase(preview: MatchPreview, chainId: ChainId): MatchShoulder {
  const { you } = computeMatchYouView(preview);
  const approvalRequirements = mapPreviewApprovals(preview.approvals, chainId);
  const warnings: AgentWarning[] = preview.warnings.map(matchWarningToAgentWarning);
  return {
    approvalRequirements,
    risk: you.risk,
    payout: { profit: you.profit, totalReturn: you.totalReturn },
    contest: preview.contest,
    speculation: matchSpeculationToShoulder(preview.speculation),
    sideSummary: you.backing,
    warnings,
  };
}

/**
 * Preview-envelope shoulder: derives `allowance-short` from the preview's
 * approvals[] (the snapshot the user is about to commit to). Unchanged
 * behavior from the original `deriveMatchShoulder`.
 */
function derivePreviewMatchShoulder(preview: MatchPreview, chainId: ChainId): MatchShoulder {
  const base = deriveMatchShoulderBase(preview, chainId);
  if (base.approvalRequirements.some((r) => r.needsApproval)) {
    base.warnings.push({
      code: 'allowance-short',
      message: 'At least one approval is short. Executing this match will require approve txs first.',
      severity: 'blocking',
      blockingFor: ['match'],
    });
  }
  return base;
}

/**
 * Execute-envelope shoulder: derives `allowance-short` from the EFFECTIVE
 * (post-approval, when an approve confirmed) fillability verdict — not from
 * `preview.approvals[]`, which was the snapshot BEFORE the auto-approve loop
 * remediated taker allowance and would otherwise leave a stale blocking
 * warning on a successful match envelope. Rules:
 *
 *   - `effectiveFillability` has a remediable taker-allowance reason → keep
 *     `allowance-short` (the approve loop didn't resolve it, e.g. it
 *     reverted).
 *   - `effectiveFillability` is clean / has only non-remediable reasons →
 *     omit `allowance-short`.
 *   - `effectiveFillability` is `null` (preflight skipped) or `unknown` (the
 *     re-check itself failed) → no fresh signal; omit `allowance-short`
 *     rather than fabricate one from the stale preview.
 */
function deriveExecuteMatchShoulder(
  preview: MatchPreview,
  chainId: ChainId,
  effectiveFillability: CheckCommitmentFillabilityResult | null,
): MatchShoulder {
  const base = deriveMatchShoulderBase(preview, chainId);
  if (effectiveFillability !== null && effectiveFillability.outcome !== 'unknown') {
    if (hasRemediableShortfall(effectiveFillability)) {
      base.warnings.push({
        code: 'allowance-short',
        message: 'At least one approval is still short after the auto-approve loop ran.',
        severity: 'blocking',
        blockingFor: ['match'],
      });
    }
  }
  return base;
}

/**
 * Map the match-side `MatchPreviewSpeculation` into the v2 envelope's
 * `SpeculationMode` shoulder shape (same shape submit uses, so the
 * two commands present a uniform `envelope.speculation`).
 *
 * The match preview omits the deprecated `makerCreationFeeUSDC`
 * field; we backfill from `creationFee.makerShareUSDC` since the
 * shoulder type pins it on the lazy variant.
 */
function matchSpeculationToShoulder(s: MatchPreviewSpeculation): SpeculationMode {
  if (s.mode === 'existing') {
    return {
      mode: 'existing',
      speculationId: s.speculationId as string,
      creationFee: s.creationFee,
    };
  }
  return {
    mode: 'lazy',
    speculationId: null,
    speculationKey: s.speculationKey,
    makerCreationFeeUSDC: s.creationFee.makerShareUSDC,
    creationFee: s.creationFee,
  };
}

/**
 * Map a MatchPreviewWarning enum value to its AgentWarning shape.
 * The enum value IS the stable code; severity + blockingFor encode
 * what the warning means operationally.
 */
function matchWarningToAgentWarning(code: MatchPreviewWarning): AgentWarning {
  switch (code) {
    case 'self-match':
      return {
        code,
        message: 'Maker equals taker — you are matching your own commitment.',
        severity: 'warning',
      };
    case 'expires-soon':
      return {
        code,
        message: 'Commitment expires soon (within the 5-minute window).',
        severity: 'warning',
      };
    case 'expired':
      return {
        code,
        message: 'Commitment is past its expiry; the match would revert on chain.',
        severity: 'blocking',
        blockingFor: ['match'],
      };
    case 'partial-fill':
      return {
        code,
        message: 'Taker risk is less than the maker remaining capacity — this will be a partial fill.',
        severity: 'info',
      };
    case 'nonce-invalidated':
      return {
        code,
        message: 'Commitment was invalidated by a raised nonce floor; the match would revert.',
        severity: 'blocking',
        blockingFor: ['match'],
      };
    case 'maker-treasury-allowance-insufficient':
      return {
        code,
        message: "Maker's TreasuryModule USDC allowance is short of their lazy-creation-fee share — the lazy match would revert.",
        severity: 'blocking',
        blockingFor: ['match'],
      };
  }
}

interface ApprovalCopy {
  headerLabel: string;
  moduleName: string;
  description: string;
}

function approvalCopy(purpose: ApprovalPurpose): ApprovalCopy {
  if (purpose === 'lazy-creation-fee') {
    return {
      headerLabel: 'lazy speculation creation fee',
      moduleName: 'TreasuryModule',
      description:
        'The TreasuryModule contract pulls this USDC from your wallet ONLY if this match\n' +
        'is the first one on this speculation tuple — i.e. the match that triggers lazy\n' +
        'creation. If a prior match already created the speculation by the time this\n' +
        'tx lands, no fee is charged.',
    };
  }
  // 'commitment-risk' — the canonical PositionModule allowance for the
  // taker's risk amount.
  return {
    headerLabel: 'taker risk',
    moduleName: 'PositionModule',
    description:
      'The PositionModule contract pulls the taker risk in USDC from your wallet\n' +
      "as part of the match. This is a standard ERC-20 `approve` — your tokens stay\n" +
      'in your wallet until the match transaction lands.',
  };
}
