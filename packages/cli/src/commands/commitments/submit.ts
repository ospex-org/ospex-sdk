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
  type HighLevelSubmitArgs,
  type SubmitParent,
} from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
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
});

export const commitmentsSubmitCommand = new Command('submit')
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
  .addOption(
    new Option(
      '--json',
      'machine-readable output. ALONE = preview only, no signing (SubmitPreviewEnvelope). ' +
        'WITH --yes = signs/posts and emits SubmitJsonResult.',
    ).hideHelp(false),
  )
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
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

    const client = await getClient({ requiresSigner: true, requiresChain: true });

    // 1. Prepare. Decimal parsing, side resolution, contest/spec
    //    fetches, allowance + nonce reads. No signing yet.
    const preview = await client.commitments.prepareSubmit(args);

    // 2. `--json` alone (no --yes) is the preview-only mode per
    //    PROPOSAL §6.2 — emit the SubmitPreviewEnvelope and exit
    //    without prompting or signing. Use case: an agent inspects
    //    the resolved tuple before deciding whether to run the
    //    actual submit (`--yes --json`).
    if (wantJson && !skipPrompt) {
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
    renderPreview(preview);

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

    // 6. Run approval if needed. The flow mirrors the contests-create
    //    handler: an approval-required block (required vs current,
    //    spender + token addresses, plain-language description) +
    //    two prompts — Allow Y/N, then Amount-with-"max"-fallback.
    //
    //    Non-interactive (--yes): no prompts — uses --approve-max for
    //    unlimited or the exact required amount otherwise. Both flags
    //    stay supported for scripted flows; the interactive path no
    //    longer mentions --approve-max in any inline-suggestion line
    //    (the flag exists, but suggesting it nudges users toward
    //    unlimited approval as a default, which we don't want).
    const needsApproval = preview.approvals.find((a) => a.needsApproval);
    if (needsApproval !== undefined && needsApproval.token === 'USDC') {
      const requiredWei6 = BigInt(needsApproval.required);
      const currentWei6 = BigInt(needsApproval.current);
      let approveAmount: bigint | 'max';

      if (skipPrompt) {
        approveAmount = approveMax ? 'max' : requiredWei6;
      } else {
        const requiredHuman = wei6ToDecimalUSDC(requiredWei6);
        const currentHuman = wei6ToDecimalUSDC(currentWei6);
        process.stderr.write(
          `\nUSDC approval needed (commitment risk).\n` +
            `  Required: ${requiredHuman} USDC\n` +
            `  Approved: ${currentHuman} USDC\n` +
            `\nThe PositionModule contract pulls this USDC from your wallet when this\n` +
            `commitment matches on-chain. This is a standard ERC-20 \`approve\` — your tokens\n` +
            `stay in your wallet until a counterparty matches. Approve more than the minimum\n` +
            `if you want to skip this prompt on future submits.\n` +
            `  Spender: ${needsApproval.spender} (PositionModule)\n`,
        );
        const allow = await promptYesNo(
          `Allow PositionModule to spend USDC from your wallet?`,
          true,
        );
        if (!allow) {
          process.stderr.write('Approval declined; submit cancelled.\n');
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
      process.stderr.write(`Approving USDC → ${needsApproval.spender} (${display})...\n`);
      const approveResult = await client.commitments.approve(approveAmount);
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
