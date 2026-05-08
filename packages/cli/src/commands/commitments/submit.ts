/**
 * `ospex commitments submit [flags]` — high-level domain-language
 * submit. Calls `client.commitments.prepareSubmit`, renders the §2.5
 * preview block, prompts for confirmation (unless `--yes`), runs any
 * needed approval, then `submitPrepared` to sign and post.
 *
 * Flags (proposal §3.1):
 *   --speculation <id>       pin to an existing speculation
 *   --contest <id>           pair with --market and (for spread/total)
 *                            --line to create lazily on first match
 *   --market <type>          moneyline | spread | total
 *   --line <decimal>         selected-side displayed line (resolver
 *                            inverts when home is selected for spread)
 *   --side <input>           team-name / alias / over / under
 *   --odds <decimal>         e.g. "2.50"
 *   --risk-usdc <decimal>    e.g. "1" or "0.001"
 *   --expiry <iso-or-unix>   default 24h from now
 *   --nonce <bigint>         override the SDK's nonce strategy
 *   --yes                    skip the [y/N] prompt
 *   --json                   emit SubmitPreviewEnvelope (preview-only)
 *                            or SubmitJsonResult (with --yes)
 *
 * `--json` and `--yes` are orthogonal (PROPOSAL §2.4). Non-TTY +
 * `--json` + no `--yes` errors out instead of hanging on a prompt.
 */

import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexAPIError, OspexValidationError, type HighLevelSubmitArgs, type SubmitParent } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import { promptYesNo } from '../../lib/prompt.js';
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
  .option('--odds <decimal>', 'decimal odds (e.g. 2.50)')
  .option('--risk-usdc <decimal>', 'decimal USDC risk (e.g. 1 or 0.001)')
  .option('--expiry <iso-or-unix>', 'expiry timestamp; default 24h from now')
  .option('--nonce <bigint>', 'override the SDK nonce strategy')
  .option('--yes', 'skip the confirmation prompt')
  .addOption(new Option('--json').hideHelp(false))
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

    // Per §2.4: write command + --json + non-TTY + no --yes is a
    // contract violation — we'd hang on a prompt that nobody can
    // answer. Surface it explicitly.
    const wantJson = opts.json === true;
    const skipPrompt = opts.yes === true;
    const isInteractive = process.stdin.isTTY === true;
    if (wantJson && !skipPrompt && !isInteractive) {
      throw new OspexValidationError(
        '--yes is required for non-interactive write commands. ' +
          'Re-run with --yes --json after reviewing inputs.',
      );
    }

    const client = await getClient({ requiresSigner: true, requiresChain: true });

    // 1. Prepare. Decimal parsing, side resolution, contest/spec
    //    fetches, allowance + nonce reads. No signing yet.
    const preview = await client.commitments.prepareSubmit(args);

    // 2. Render the preview block to stderr so --json keeps stdout clean.
    renderPreview(preview);

    // 3. Confirm (unless --yes). 'n' or empty exits with 130 (matches
    //    the Ctrl-C convention so scripts can distinguish "user
    //    declined" from "tx failed").
    if (!skipPrompt) {
      const ok = await promptYesNo('Submit?', false);
      if (!ok) {
        process.stderr.write('Submit cancelled.\n');
        process.exit(130);
      }
    }

    // 4. Single-passphrase / pre-flight approvals. The signer was
    //    already unlocked during prepareSubmit (to derive maker), so
    //    further signs reuse the cached key — one passphrase prompt
    //    covers approve + commit submit.
    const needsApproval = preview.approvals.find((a) => a.needsApproval);
    if (needsApproval && needsApproval.token === 'USDC') {
      process.stderr.write(
        `Approving ${needsApproval.token} → ${needsApproval.spender}...\n`,
      );
      const approveResult = await client.commitments.approve('max');
      process.stderr.write(
        `approve tx: ${approveResult.txHash} (status ${approveResult.receipt.status})\n`,
      );
    }

    // 5. Sign + post the EIP-712 commitment.
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

    // 6. Output.
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
