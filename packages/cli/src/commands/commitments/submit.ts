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
 *                              --json alone     → SubmitPreviewEnvelope
 *                                                 (preview only, NO signing)
 *                              --yes --json     → SubmitJsonResult
 *                                                 (preview + submit result)
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
  usdcDecimalToWei6,
  wei6ToDecimalUSDC,
  type ApprovalPurpose,
  type HighLevelSubmitArgs,
  type SubmitParent,
} from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
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
    .addOption(
      new Option(
        '--json',
        'machine-readable output. ALONE = preview only, no signing (SubmitPreviewEnvelope). ' +
          'WITH --yes = signs/posts and emits SubmitJsonResult.',
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

    // 1. Prepare. Decimal parsing, side resolution, contest/spec
    //    fetches, allowance + nonce reads. No signing yet.
    const prepArgs: HighLevelSubmitArgs = { ...args };
    if (previewOnly) {
      prepArgs.maker = await resolvePreviewAddress(signerIntent);
    }
    const preview = await client.commitments.prepareSubmit(prepArgs);

    // 2. `--json` alone (no --yes) is the preview-only mode — emit
    //    the SubmitPreviewEnvelope and exit without prompting or
    //    signing.
    if (previewOnly) {
      formatOutput({ schemaVersion: 1, preview }, { json: true });
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

    // 4. Render the preview to stderr so stdout JSON (under --yes
    //    --json) stays parseable.
    renderPreview(preview, process.stderr, { raw: opts.raw === true });

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

    // 9. Output. With --yes --json, emit the full SubmitJsonResult
    //    envelope (preview + result). Otherwise pretty text.
    if (wantJson) {
      formatOutput(
        { schemaVersion: 1, preview, result: { hash: result.hash, commitment: result.commitment } },
        { json: true },
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
  });

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
