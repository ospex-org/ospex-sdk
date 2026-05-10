/**
 * `ospex approvals setup [flags]` — orchestrates 1–3 sequential ERC-20
 * approvals against the Ospex spenders so a user can configure their
 * worst-case risk exposure in a single command.
 *
 * Flag mode (any of `--risk-usdc`, `--fee-usdc`, `--link` provided):
 *   only act on the dimensions specified. When `--risk-usdc` is set
 *   alone, a small `--fee-usdc` default is auto-included so the next
 *   commitment match doesn't trigger a mid-bet approval prompt; pass
 *   `--fee-usdc 0` to opt out.
 *
 * Interactive mode (no flags + TTY + not --json):
 *   prompts for each dimension with sensible defaults. Press enter to
 *   accept the default; type "skip" or empty to leave that dimension
 *   unchanged.
 *
 * Output:
 *   - human (default) — preview block + Y/n prompt + per-tx progress.
 *   - --json without --yes — emits SetupPreviewEnvelope
 *     ({ schemaVersion, plan }), no signing.
 *   - --yes --json — signs/sends and emits SetupResultEnvelope
 *     ({ schemaVersion, plan, results }).
 *
 * Approvals are sent sequentially. Already-sufficient allowances are
 * skipped so this is idempotent — re-running with the same flags is a
 * no-op.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexValidationError, type ApprovalsSnapshot } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import { promptValue, promptYesNo } from '../../lib/prompt.js';
import {
  buildSetupPlan,
  parseLinkInput,
  parseUsdcInput,
  type ApprovalSpenderKey,
  type PlanItem,
  type SetupInput,
} from '../../lib/approvalsPlan.js';
import {
  buildSetupPreviewEnvelope,
  buildSetupResultEnvelope,
  renderSetupPlan,
  type JsonSetupResult,
} from '../../lib/approvalsRender.js';

const optionsSchema = z.object({
  riskUsdc: z.string().optional(),
  feeUsdc: z.string().optional(),
  link: z.string().optional(),
  yes: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const approvalsSetupCommand = new Command('setup')
  .description(
    'Set up USDC + LINK approvals for Ospex modules in one command. ' +
      'Without flags, runs interactively. With at least one flag, only acts on the dimensions specified.',
  )
  .option(
    '--risk-usdc <amount>',
    'USDC approval for PositionModule (your bet risk pool). Decimal USDC like "50" or "0.25", or "max".',
  )
  .option(
    '--fee-usdc <amount>',
    'USDC approval for TreasuryModule (protocol fees: contest creation + lazy spec creation). ' +
      'If --risk-usdc is set and --fee-usdc is omitted, a small default is auto-included to ' +
      'prevent a mid-bet approval prompt; pass --fee-usdc 0 to opt out.',
  )
  .option(
    '--link <amount>',
    'LINK approval for OracleModule (Chainlink Functions, only for contest creation/scoring). ' +
      'Most users skip this. Decimal LINK like "2", or "max".',
  )
  .option('--yes', 'skip the confirmation prompt')
  .option('--json', 'machine-readable output')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const wantJson = opts.json === true;
    const skipPrompt = opts.yes === true;
    const isInteractiveTTY = process.stdin.isTTY === true;

    const flagsProvided =
      opts.riskUsdc !== undefined || opts.feeUsdc !== undefined || opts.link !== undefined;
    const wantInteractive = !flagsProvided && !wantJson;

    if (!flagsProvided && wantJson) {
      throw new OspexValidationError(
        'Pass at least one of --risk-usdc, --fee-usdc, --link with --json. Interactive ' +
          'prompts and --json are mutually exclusive.',
      );
    }
    if (wantInteractive && !isInteractiveTTY) {
      throw new OspexValidationError(
        'Interactive setup requires a TTY. Re-run with at least one of --risk-usdc, --fee-usdc, --link.',
      );
    }
    if (!skipPrompt && !wantJson && !isInteractiveTTY) {
      throw new OspexValidationError(
        '--yes is required for non-interactive runs of `approvals setup`. Re-run with --yes.',
      );
    }

    // Pre-parse flag amounts BEFORE any signer/chain interaction, so a
    // typo'd `--risk-usdc not-a-number` errors out without first
    // prompting for the keystore passphrase. The result is discarded —
    // buildSetupPlan re-parses internally — and parseLinkInput /
    // parseUsdcInput throw on bad shape.
    if (opts.riskUsdc !== undefined) parseUsdcInput(opts.riskUsdc);
    if (opts.feeUsdc !== undefined) parseUsdcInput(opts.feeUsdc);
    if (opts.link !== undefined) parseLinkInput(opts.link);

    const client = await getClient({ requiresSigner: true, requiresChain: true });

    // Ensure the signer is unlocked once up-front so the subsequent
    // approve txs don't each prompt for the passphrase. The first call
    // to `client.signer().getAddress()` triggers the unlock; subsequent
    // signing operations reuse the in-memory signer.
    const owner = ((await client.signer().getAddress()) as string).toLowerCase() as `0x${string}`;
    const current = await client.approvals.read({ owner });

    const input: SetupInput = wantInteractive
      ? await runInteractivePrompts(current)
      : { riskUsdc: opts.riskUsdc, feeUsdc: opts.feeUsdc, link: opts.link };

    const plan = buildSetupPlan(input, current);

    // --json without --yes → preview-only envelope, no signing.
    if (wantJson && !skipPrompt) {
      formatOutput(buildSetupPreviewEnvelope(plan), { json: true });
      return;
    }
    if (!wantJson) {
      renderSetupPlan(plan, process.stderr);
    }

    // Idempotent re-run: no txs to send. Emit empty-results envelope
    // for JSON consumers; nothing further for human mode (the plan
    // renderer already printed "Nothing to do").
    if (plan.willSendCount === 0) {
      if (wantJson) {
        formatOutput(buildSetupResultEnvelope(plan, []), { json: true });
      }
      return;
    }

    if (!skipPrompt && !wantJson) {
      const ok = await promptYesNo('\nProceed?');
      if (!ok) {
        process.stderr.write('Cancelled.\n');
        process.exit(130);
      }
    }

    const results: JsonSetupResult[] = [];
    for (const item of plan.items) {
      if (item.action.kind !== 'send') continue;
      if (!wantJson) {
        process.stderr.write(`\nApproving ${moduleDisplayName(item.spenderModule)} ...\n`);
      }
      const result = await executeItem(client, item);
      results.push(result);
      if (!wantJson) {
        process.stderr.write(
          `  ✓ ${result.txHash}  (block ${result.blockNumber})\n`,
        );
      }
    }

    if (wantJson) {
      formatOutput(buildSetupResultEnvelope(plan, results), { json: true });
      return;
    }
    process.stderr.write(
      `\nDone. Run \`ospex approvals show\` to verify the new state.\n`,
    );
  });

async function runInteractivePrompts(current: ApprovalsSnapshot): Promise<SetupInput> {
  process.stderr.write(`\nSetting up Ospex approvals for ${current.owner}\n`);
  process.stderr.write(`(Press enter to accept the default; type "skip" to leave a dimension unchanged.)\n\n`);
  const riskUsdc = await promptValue(
    'USDC for bets (matching/submitting bets — decimal USDC, "max", or "skip")',
    '50',
  );
  const feeUsdc = await promptValue(
    'USDC for fees (small budget for protocol fees on lazy spec creation)',
    '1',
  );
  const link = await promptValue(
    'LINK for contest creation (most users skip this)',
    'skip',
  );
  return { riskUsdc, feeUsdc, link };
}

async function executeItem(
  client: Awaited<ReturnType<typeof getClient>>,
  item: PlanItem,
): Promise<JsonSetupResult> {
  if (item.action.kind !== 'send') {
    throw new Error('executeItem called on a non-send plan item');
  }
  const target = item.action.targetIsMax ? 'max' : item.action.targetRaw;
  let receipt;
  if (item.spenderModule === 'positionModule') {
    receipt = await client.commitments.approve(target);
  } else if (item.spenderModule === 'treasuryModule') {
    receipt = await client.commitments.approveCreationFee(target);
  } else {
    receipt = await client.contests.approveLink(target);
  }
  return {
    spenderModule: item.spenderModule,
    txHash: receipt.txHash,
    blockNumber: receipt.receipt.blockNumber.toString(),
    status: receipt.receipt.status as 'success' | 'reverted',
  };
}

function moduleDisplayName(spender: ApprovalSpenderKey): string {
  if (spender === 'positionModule') return 'PositionModule';
  if (spender === 'treasuryModule') return 'TreasuryModule';
  return 'OracleModule';
}
