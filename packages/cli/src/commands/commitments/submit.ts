/**
 * `ospex commitments submit [flags]` — high-level domain-language
 * submit. Calls `client.commitments.prepareSubmit`, then optionally
 * the §2.5 preview block + confirmation prompt, then `submitPrepared`
 * to sign and post (when not in preview-only mode).
 *
 * Flags (proposal §3.1):
 *   --speculation <id>       pin to an existing speculation
 *   --contest <id>           pair with --market and (for spread/total)
 *                            --line to create lazily on first match
 *   --market <type>          moneyline | spread | total
 *   --line <decimal>         selected-side displayed line (resolver
 *                            inverts when home is selected for spread)
 *   --side <input>           team-name / alias / over / under
 *   --odds <value>           decimal (e.g. "2.50") OR American (e.g. "+150",
 *                            "-110"). Plain integers like "101" are
 *                            ambiguous and rejected — use "+101" / "-101"
 *                            for American or "101.0" for decimal.
 *   --risk-usdc <decimal>    e.g. "1" or "0.001"
 *   --expiry <value>         when the signed commitment stops being
 *                            matchable. Three accepted forms:
 *                              - duration:    "30m" / "4h" / "1d" / "1w"
 *                              - ISO-8601:    "2026-05-09T20:00:00Z"
 *                                             "2026-05-09T15:00:00-05:00"
 *                              - unix-seconds: "1715299200"
 *                            Default: contest's scheduled match time.
 *                            Pregame commitments expire at tip-off by
 *                            default — protects against stale pregame
 *                            odds being filled after start. To allow
 *                            post-start matching, pass --expiry
 *                            explicitly (the preview shows a warning).
 *   --nonce <bigint>         override the SDK's nonce strategy
 *   --yes                    skip the [Y/n] prompt
 *   --json                   emit machine-readable JSON. Behavior pairs
 *                            with --yes:
 *                              --json alone     → v2 AgentEnvelope, stage
 *                                                 'preview' (payload: SubmitPreview;
 *                                                 NO signing)
 *                              --yes --json     → v2 AgentEnvelope, stage
 *                                                 'execute' (payload: { preview,
 *                                                 result, fundability })
 *   --approve-max            non-interactive (`--yes`) shorthand for
 *                            "approve unlimited" when an approval is
 *                            needed. In interactive mode the user
 *                            chooses the amount at the per-approval
 *                            prompt and this flag is unused.
 *
 * Contract corollaries:
 *   - `--json` is output format only. It does NOT imply `--yes`.
 *   - Non-TTY + sign-required (i.e. without `--yes`) errors out
 *     rather than hanging on a prompt nobody can answer.
 *   - Decline at the prompt → exit code 130 (Ctrl-C convention).
 */

import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  OspexAPIError,
  OspexValidationError,
  computeSubmitYouView,
  usdcDecimalToWei6,
  wei6ToDecimalUSDC,
  type AgentEffect,
  type AgentEnvelope,
  type AgentPayout,
  type AgentWarning,
  type ApprovalPurpose,
  type ApprovalRequirement,
  type ChainId,
  type CheckSubmitFundabilityResult,
  type Commitment,
  type Hex,
  type HighLevelSubmitArgs,
  type PerspectiveAmount,
  type SubmitParent,
  type SubmitPreview,
} from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  emitJsonFailure,
  mapPreviewApprovals,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import {
  buildSubmitRefusedEnvelope,
  renderSubmitFundabilityNotice,
  renderSubmitPreflightRefusal,
  selectBlockingSubmitReasons,
} from '../../lib/submitFundabilityPreflight.js';
import {
  VERIFY_COMMITMENT,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { getClient, resolvePreviewAddress } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import { promptValue, promptYesNo } from '../../lib/prompt.js';
import { renderPreview } from '../../lib/previewRender.js';

const marketSchema = z.enum(['moneyline', 'spread', 'total']);

const optionsSchema = z.object({
  speculation: z.string().regex(/^[0-9]+$/).optional(),
  contest: z.string().regex(/^[0-9]+$/).optional(),
  market: marketSchema.optional(),
  line: z.string().optional(),
  side: z.string().min(1, 'side is required'),
  odds: z.string().min(1, 'odds is required'),
  riskUsdc: z.string().min(1, 'risk-usdc is required'),
  expiry: z.string().optional(),
  nonce: z.string().regex(/^[0-9]+$/).optional(),
  yes: z.boolean().optional(),
  json: z.boolean().optional(),
  approveMax: z.boolean().optional(),
  raw: z.boolean().optional(),
  skipFundabilityPreflight: z.boolean().optional(),
  force: z.boolean().optional(),
});

export const commitmentsSubmitCommand = addSignerOptions(
  new Command('submit')
    .description(
      'Sign + post an EIP-712 commitment using domain-language inputs. Renders a ' +
        'win/lose/push preview before signing; pass --yes to skip the prompt.',
    )
    .option('--speculation <id>', 'speculation id (uint256)')
    .option('--contest <id>', 'contest id (uint256) — pair with --market')
    .option('--market <type>', 'market type: moneyline | spread | total')
    .option('--line <decimal>', 'selected-side displayed line (e.g. -3.5)')
    .option('--side <input>', 'team name / alias, or "over"/"under" for totals')
    .option(
      '--odds <value>',
      'decimal (e.g. "2.50", "1.91") or American with explicit sign (e.g. "+150", "-110"). Plain integers without a sign or decimal point are ambiguous and rejected.',
    )
    .option('--risk-usdc <decimal>', 'decimal USDC risk (e.g. 1 or 0.001)')
    .option(
      '--expiry <value>',
      'duration ("30m", "4h", "1d", "1w"), ISO-8601 ("2026-05-09T20:00:00Z"), or unix-seconds. Default: contest match time.',
    )
    .option('--nonce <bigint>', 'override the SDK nonce strategy')
    .option('--yes', 'skip the confirmation prompt')
    .option(
      '--approve-max',
      'with --yes (non-interactive), approve unlimited USDC instead of the exact required amount. Ignored in interactive mode — to grant unlimited interactively, type "max" at the amount prompt.',
    )
    .option(
      '--raw',
      'render the protocol-native side tags (positionType=Upper/Lower) inside the side: line. ' +
        'Useful for debugging EIP-712 hash mismatches; has no effect on --json output.',
    )
    .option(
      '--skip-fundability-preflight',
      'skip the advisory pre-sign maker-funding check. By default `submit` reads the maker\'s USDC ' +
        'balance + PositionModule/TreasuryModule allowance and the open-commitment book, and REFUSES ' +
        '(before signing) a submit the wallet can\'t back. This flag proceeds anyway.',
    )
    .option(
      '--force',
      'alias for --skip-fundability-preflight — proceed despite (or without) the funding check ' +
        '(the commitment may be unfillable).',
    )
    .addOption(
      new Option(
        '--json',
        'machine-readable output. ALONE = preview only, no signing (v2 AgentEnvelope, stage "preview", payload SubmitPreview). ' +
          'WITH --yes = signs/posts and emits a v2 AgentEnvelope (stage "execute", payload { preview, result, fundability }).',
      ).hideHelp(false),
    ),
)
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const parent = parseParent(opts);
    const args: HighLevelSubmitArgs = {
      parent,
      side: opts.side,
      odds: opts.odds,
      riskUsdc: opts.riskUsdc,
      ...(opts.expiry !== undefined ? { expiry: opts.expiry } : {}),
      ...(opts.nonce !== undefined ? { nonce: BigInt(opts.nonce) } : {}),
    };

    const wantJson = opts.json === true;
    const skipPrompt = opts.yes === true;
    const approveMax = opts.approveMax === true;
    const isInteractive = process.stdin.isTTY === true;
    const previewOnly = wantJson && !skipPrompt;

    // Lazy signer split (spec §17.2): preview-only mode (`--json`
    // without `--yes`) MUST NOT trigger an interactive passphrase
    // prompt or a keystore decrypt unless a non-interactive source
    // is configured. `resolvePreviewAddress` returns an address
    // from --expected-address, non-interactive credentials, or
    // cached session (never from a prompt). prepareSubmit gets the
    // `maker` override so it skips its own signer.getAddress() call.
    const client = previewOnly
      ? await getClient({ requiresChain: true })
      : await getClient({ requiresSigner: true, requiresChain: true, signerIntent });

    // Failure-envelope state: derived progressively as the command
    // runs. The catch at the bottom reads these (via closure) to
    // build the failure envelope. `approveEffects` is also surfaced
    // on success envelopes when --yes --json was set.
    const chainId = client.chainId();
    let wallet: Hex | null = null;
    const approveEffects: AgentEffect[] = [];
    const stageForFailure: 'preview' | 'execute' = previewOnly ? 'preview' : 'execute';

    try {
    // 1. Prepare. Decimal parsing, side resolution, contest/spec
    //    fetches, allowance + nonce reads. No signing yet.
    const prepArgs: HighLevelSubmitArgs = { ...args };
    if (previewOnly) {
      prepArgs.maker = await resolvePreviewAddress(signerIntent);
    }
    const preview = await client.commitments.prepareSubmit(prepArgs);
    wallet = preview.raw.maker.toLowerCase() as Hex;

    // 2. `--json` alone (no --yes) is the preview-only mode — emit
    //    the v2 agent envelope and exit without prompting or signing.
    //    The fundability preflight is an EXECUTE-path guard (mirrors `match`),
    //    so it does NOT run here — an inspect-only preview stays cheap and
    //    signer-free; agents that want the verdict pre-sign call
    //    `client.commitments.checkSubmitFundability` or read it from the
    //    executed envelope's `payload.fundability`.
    if (previewOnly) {
      const chainId = client.chainId();
      writeAgentEnvelope(toSubmitPreviewEnvelope(preview, { chainId }));
      return;
    }

    // 3. From here on we will sign + post. Refuse non-interactive
    //    runs that don't pass --yes — we'd hang on a prompt nobody
    //    can answer.
    if (!skipPrompt && !isInteractive) {
      throw new OspexValidationError(
        '--yes is required for non-interactive write commands. Re-run with --yes.',
      );
    }

    // 3.5 Fundability preflight (execute path only — mirrors `match`). Read the
    //     maker's USDC balance + PositionModule/TreasuryModule allowance and
    //     their open-commitment book, and check whether the WHOLE book (existing
    //     + this commitment + lazy fees) is backed — the approve-loop below only
    //     ever covers THIS commitment's allowance and reads no balance, so this
    //     is what catches whole-book over-commitment. REFUSE-before-sign on a
    //     non-remediable USDC balance shortfall; allowance shortfalls + the
    //     lazy-fee uncertainty are advisory (the approve-loop / a manual approve
    //     remediates allowances) — surfaced below + in `payload.fundability`,
    //     never blocking. Bypass with --skip-fundability-preflight / --force
    //     (→ fundability stays null). Threaded into the execute envelope below
    //     ("JSON always includes it"; null = skipped) — NOT into warnings[]
    //     (read `payload.fundability.reasons`), matching `match`.
    let fundability: CheckSubmitFundabilityResult | null = null;
    const skipFundability = opts.skipFundabilityPreflight === true || opts.force === true;
    if (!skipFundability) {
      fundability = await client.commitments.checkSubmitFundability({ preview });
      const blocking = selectBlockingSubmitReasons(fundability.reasons);
      if (blocking.length > 0) {
        if (wantJson) {
          writeAgentEnvelope(buildSubmitRefusedEnvelope(fundability, blocking, { chainId, wallet }));
        } else {
          process.stderr.write(renderSubmitPreflightRefusal(blocking));
        }
        process.exit(1);
      }
    }

    // 4. Render the preview to stderr so stdout JSON (under --yes
    //    --json) stays parseable.
    renderPreview(preview, process.stderr, { raw: opts.raw === true });
    // 4.5 Advisory funding notice (non-blocking reasons) for the human path —
    //     under --json the same signal rides the execute envelope's
    //     `payload.fundability` (the full verdict, incl `reasons[]`), not warnings[].
    if (!wantJson && fundability !== null) {
      const notice = renderSubmitFundabilityNotice(fundability);
      if (notice) process.stderr.write(notice);
    }

    // 5. Confirm (unless --yes). 'n' or empty exits with 130 (matches
    //    the Ctrl-C convention so scripts can distinguish "user
    //    declined" from "tx failed").
    if (!skipPrompt) {
      const ok = await promptYesNo('Submit?', true);
      if (!ok) {
        process.stderr.write('Submit cancelled.\n');
        process.exit(130);
      }
    }

    // 6. Run approvals if needed. The preview's `approvals[]` may
    //    carry up to TWO short-allowance rows for a lazy commit:
    //
    //      - 'commitment-risk'    (USDC → PositionModule)  — always
    //                             present in approvals[]; needsApproval
    //                             true when allowance < riskAmount.
    //      - 'lazy-creation-fee'  (USDC → TreasuryModule)  — present
    //                             only for `speculation.mode === 'lazy'`;
    //                             needsApproval true when TreasuryModule
    //                             allowance < the maker's half of the
    //                             speculation creation fee
    //                             (250000 wei6 on Polygon mainnet).
    //
    //    For each short row we run the contests-create-style prompts
    //    (Allow Y/N, then Amount with "max" fallback) and dispatch to
    //    the matching SDK approve method by `purpose`. Multiple
    //    approvals run sequentially — order is the order in
    //    approvals[] (commitment-risk first, lazy-creation-fee second
    //    for lazy commits).
    //
    //    Non-interactive (--yes) skips the prompts entirely:
    //    --approve-max → unlimited; otherwise → the exact required
    //    amount on each row.
    //
    //    Hermes PR-69 fix: each approve tx is recorded as an
    //    AgentEffect (collected in `approveEffects`, declared at the
    //    top of the action so the failure-envelope catch can also
    //    surface already-confirmed approves on a mid-flight throw)
    //    and prepended to the execute envelope's effects[] below.
    //    Agents that parse --json need the approve tx hashes/
    //    statuses, not just the final submit effect — those
    //    approvals are real on-chain side effects the command
    //    performed.
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
            `  Required: ${requiredHuman} USDC\n` +
            `  Approved: ${currentHuman} USDC\n` +
            `\n${copy.description}\n` +
            `  Spender: ${row.spender} (${copy.moduleName})\n`,
        );
        const allow = await promptYesNo(
          `Allow ${copy.moduleName} to spend USDC from your wallet?`,
          true,
        );
        if (!allow) {
          process.stderr.write(`Approval declined; submit cancelled.\n`);
          process.exit(130);
        }
        const choice = await promptValue(
          `Amount in USDC (number, or "max" for unlimited)`,
          requiredHuman,
        );
        if (choice.toLowerCase() === 'max') {
          approveAmount = 'max';
        } else {
          let parsed: bigint;
          try {
            parsed = usdcDecimalToWei6(choice);
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
      // Dispatch on `purpose`. Two paths for now (commitment-risk →
      // PositionModule; lazy-creation-fee → TreasuryModule); a future
      // ApprovalPurpose value would need a corresponding case here.
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
    }

    // 8. Sign + post the EIP-712 commitment.
    let result;
    try {
      result = await client.commitments.submitPrepared(preview);
    } catch (err) {
      if (err instanceof OspexAPIError && err.apiCode === 'NONCE_TOO_LOW') {
        process.stderr.write(
          'Nonce floor moved between prepare and submit (concurrent maker activity). ' +
            'Re-run the command; the SDK will pick a fresh nonce on the next prepareSubmit.\n',
        );
      }
      throw err;
    }

    // 9. Output. With --yes --json, emit the v2 execute envelope
    //    (preview + result under payload, effects logged).
    //    Otherwise pretty text.
    if (wantJson) {
      writeAgentEnvelope(
        toSubmitExecuteEnvelope(
          preview,
          { hash: result.hash, commitment: result.commitment },
          { chainId, approveEffects, fundability },
        ),
      );
      return;
    }
    formatOutput(
      {
        hash: result.hash,
        status: result.commitment.status,
        riskAmount: result.commitment.riskAmount,
        nonce: result.commitment.nonce,
        expiry: result.commitment.expiry,
      },
      { json: false },
    );
    } catch (err) {
      // Hermes PR-6 scope: --json failures emit a v2 failure envelope
      // that preserves any approve txs that already landed before the
      // throw. Without this, a NONCE_TOO_LOW after a successful USDC
      // approve would lose the approve tx hash to stderr (legacy path).
      if (wantJson) {
        emitJsonFailure({
          action: 'commitments.submit',
          stage: stageForFailure,
          chainId,
          wallet,
          walletRole: 'signer',
          signer: wallet,
          effects: approveEffects,
          nextCommands: deriveRemediationNextCommands(err, chainId),
          error: err,
        });
        process.exit(1);
      }
      throw err;
    }
  });

// ── v1 → v2 envelope transforms ────────────────────────────────────

/** `payload` shape for `commitments submit --json` (preview-only). */
export type SubmitPreviewPayload = SubmitPreview;

/** `payload` shape for `commitments submit --yes --json` (executed). */
export interface SubmitExecutePayload {
  preview: SubmitPreview;
  result: { hash: Hex; commitment: Commitment };
  /** The advisory submit-fundability verdict (B1b) — `null` when the preflight was skipped (--skip-fundability-preflight / --force). Always present, mirroring `match`'s `payload.fillability`. */
  fundability: CheckSubmitFundabilityResult | null;
}

export interface ToSubmitEnvelopeArgs {
  chainId: ChainId;
}

export interface ToSubmitExecuteEnvelopeArgs extends ToSubmitEnvelopeArgs {
  /**
   * Effects from any approve txs that ran before the final
   * submit/POST. Prepended to the envelope's `effects[]` so agents
   * see the full chronological log of what the command actually
   * did on chain — `commitment-risk` approve, `lazy-creation-fee`
   * approve, then the EIP-712 signature + offchain write.
   *
   * Empty (or omitted) when no approvals were needed.
   */
  approveEffects?: AgentEffect[];
  /** The fundability verdict for `payload.fundability` — `null` when the preflight was skipped (mirrors `match`). */
  fundability: CheckSubmitFundabilityResult | null;
}

/**
 * Build the v2 envelope for the preview-only (`--json`, no `--yes`)
 * branch. Spec §3.1 + per-command matrix:
 *   stage: 'preview'
 *   requiresSignature: true  (signing is the next step the user would take)
 *   requiresTransaction: false (submit POSTs the EIP-712 commitment
 *     off-chain; the match later is what hits chain)
 *   approvalRequirements: derived from preview.approvals[]
 *   risk / payout / contest / speculation / sideSummary: hoisted from preview.you
 *   commitment: null (no signed commitment exists yet)
 *   warnings: derived from preview.expiry.afterMatchTime + any allowance-short row
 */
export function toSubmitPreviewEnvelope(
  preview: SubmitPreview,
  args: ToSubmitEnvelopeArgs,
): AgentEnvelope<SubmitPreviewPayload> {
  const wallet = lowerHex(preview.raw.maker);
  const shoulder = deriveSubmitShoulder(preview, args.chainId);
  return buildAgentEnvelope<SubmitPreviewPayload>({
    ok: true,
    action: 'commitments.submit',
    stage: 'preview',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet,
    walletRole: 'signer',
    signer: wallet,
    requiresSignature: true,
    requiresTransaction: false,
    approvalRequirements: shoulder.approvalRequirements,
    risk: shoulder.risk,
    payout: shoulder.payout,
    contest: preview.contest,
    speculation: preview.market.speculation,
    sideSummary: shoulder.sideSummary,
    warnings: shoulder.warnings,
    payload: preview,
  });
}

/**
 * Build the v2 envelope for the executed (`--yes --json`) branch.
 *   stage: 'execute'
 *   requiresSignature / requiresTransaction: false (already done)
 *   approvalRequirements: empty (consumed during execution)
 *   commitment: the signed commitment from result
 *   effects: eip712-signature + offchain-write (no on-chain tx for submit)
 *
 * `risk` / `payout` / `contest` / `speculation` / `sideSummary` remain
 * populated from `preview` so agents reading the execute envelope see
 * the same context they would on the preview.
 */
export function toSubmitExecuteEnvelope(
  preview: SubmitPreview,
  result: { hash: Hex; commitment: Commitment },
  args: ToSubmitExecuteEnvelopeArgs,
): AgentEnvelope<SubmitExecutePayload> {
  const wallet = lowerHex(preview.raw.maker);
  const shoulder = deriveSubmitShoulder(preview, args.chainId);
  const approveEffects = args.approveEffects ?? [];
  // Order is chronological: approve txs ran first, then the
  // EIP-712 signature + off-chain POST. Agents reading effects[]
  // in order see exactly what landed in what sequence.
  const finalEffects: AgentEffect[] = [
    {
      type: 'eip712-signature',
      purpose: 'submit-commitment',
      ok: true,
    },
    {
      type: 'offchain-write',
      purpose: 'submit-commitment',
      ok: true,
    },
  ];
  return buildAgentEnvelope<SubmitExecutePayload>({
    ok: approveEffects.every((e) => e.ok) && finalEffects.every((e) => e.ok),
    action: 'commitments.submit',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet,
    walletRole: 'signer',
    signer: wallet,
    risk: shoulder.risk,
    payout: shoulder.payout,
    contest: preview.contest,
    speculation: preview.market.speculation,
    commitment: result.commitment,
    sideSummary: shoulder.sideSummary,
    warnings: shoulder.warnings,
    effects: [...approveEffects, ...finalEffects],
    nextCommands: [VERIFY_COMMITMENT.build({ hash: result.hash })],
    payload: { preview, result, fundability: args.fundability ?? null },
  });
}

interface SubmitShoulder {
  approvalRequirements: ApprovalRequirement[];
  risk: PerspectiveAmount | null;
  payout: AgentPayout | null;
  sideSummary: string | null;
  warnings: AgentWarning[];
}

/**
 * Pull the cross-stage shoulder fields out of a SubmitPreview so the
 * preview and execute envelope builders share one derivation. Goes
 * through the SDK's `computeSubmitYouView` shim so mixed-version
 * previews (where `preview.you` might be undefined on older builds)
 * still resolve.
 */
function deriveSubmitShoulder(preview: SubmitPreview, chainId: ChainId): SubmitShoulder {
  const { you } = computeSubmitYouView(preview);
  const approvalRequirements = mapPreviewApprovals(preview.approvals, chainId);
  const warnings: AgentWarning[] = [];
  if (preview.expiry.afterMatchTime) {
    warnings.push({
      code: 'expiry-after-match-time',
      message:
        'Expiry is after the contest match time — this commitment can remain matchable after start.',
      severity: 'warning',
    });
  }
  if (approvalRequirements.some((r) => r.needsApproval)) {
    warnings.push({
      code: 'allowance-short',
      message: 'At least one approval is short. Executing this commitment will require approve txs first.',
      severity: 'blocking',
      blockingFor: ['submit'],
    });
  }
  return {
    approvalRequirements,
    risk: you.risk,
    payout: { profit: you.profit, totalReturn: you.totalReturn },
    sideSummary: you.backing,
    warnings,
  };
}

function lowerHex(addr: string): Hex {
  return addr.toLowerCase() as Hex;
}

function parseParent(opts: z.infer<typeof optionsSchema>): SubmitParent {
  const hasSpec = opts.speculation !== undefined;
  const hasContest = opts.contest !== undefined;

  if (hasSpec && hasContest) {
    throw new OspexValidationError(
      '--speculation and --contest are mutually exclusive. Pass exactly one.',
    );
  }
  if (!hasSpec && !hasContest) {
    throw new OspexValidationError(
      'Either --speculation <id> or --contest <id> --market <type> is required.',
    );
  }

  if (hasSpec) {
    if (opts.market !== undefined) {
      throw new OspexValidationError(
        '--market is not valid with --speculation; the speculation already pins the market.',
      );
    }
    if (opts.line !== undefined) {
      throw new OspexValidationError(
        '--line is not valid with --speculation; the speculation already pins the line.',
      );
    }
    return { kind: 'speculation', speculationId: opts.speculation as string };
  }

  if (opts.market === undefined) {
    throw new OspexValidationError(
      '--market is required when using --contest. Pass moneyline | spread | total.',
    );
  }
  return {
    kind: 'contest',
    contestId: opts.contest as string,
    market: opts.market,
    ...(opts.line !== undefined ? { line: opts.line } : {}),
  };
}

interface ApprovalCopy {
  /** Short label rendered in parens after "USDC approval needed" */
  headerLabel: string;
  /** Module name used in the spender label and the Allow-Y/N prompt */
  moduleName: string;
  /** Plain-language paragraph explaining when this allowance is consumed */
  description: string;
}

/**
 * Per-purpose copy for the approval-required block. Keep both arms in
 * sync with `ApprovalPurpose`; adding a new purpose value in the SDK
 * requires extending this switch (the call site falls back to the
 * generic commitment-risk copy on unknown values, so an unhandled
 * future purpose still renders something — but that's a regression
 * smell to catch in code review, not the intended path).
 */
function approvalCopy(purpose: ApprovalPurpose): ApprovalCopy {
  if (purpose === 'lazy-creation-fee') {
    return {
      headerLabel: 'lazy speculation creation fee',
      moduleName: 'TreasuryModule',
      description:
        `The TreasuryModule contract pulls this USDC from your wallet ONLY if your\n` +
        `commitment is the first to match this speculation (i.e. the match that triggers\n` +
        `lazy creation). If a prior match already created the speculation by the time\n` +
        `your commitment is filled, no fee is charged. Approve more than the minimum\n` +
        `if you want a buffer for future lazy commits — the same allowance covers\n` +
        `contest-creation fees too, so any leftover from \`ospex contests create\` already\n` +
        `counts toward this requirement.`,
    };
  }
  // 'commitment-risk' — the canonical PositionModule allowance for
  // the maker's risk amount.
  return {
    headerLabel: 'commitment risk',
    moduleName: 'PositionModule',
    description:
      `The PositionModule contract pulls this USDC from your wallet when this\n` +
      `commitment matches on-chain. This is a standard ERC-20 \`approve\` — your tokens\n` +
      `stay in your wallet until a counterparty matches. Approve more than the minimum\n` +
      `if you want to skip this prompt on future submits.`,
  };
}
