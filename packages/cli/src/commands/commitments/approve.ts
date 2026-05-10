/**
 * `ospex commitments approve <amount|max>` — approve PositionModule
 * (NOT MatchingModule) to spend USDC from the configured wallet, in
 * decimal USDC. Aliased blessed-path is `ospex approvals setup
 * --risk-usdc <n>`; this command is the one-shot CLI primitive for
 * power users who'd rather skip the planner.
 *
 * Argument is human-readable USDC ("5", "0.25", "max"). The raw-wei6
 * form lives at `ospex commitments approve-raw` for parity with the
 * `submit` / `submit-raw` precedent — the human form is the default
 * everywhere; any 6-decimal-units form is a clearly distinct command.
 *
 * A confirmation prompt + preview is shown before signing because
 * this is a money-moving op; pass `--yes` to skip. Old scripts
 * calling `ospex commitments approve 5000000` (which previously
 * meant 5 USDC and now means 5 million) will see the resolved amount
 * in the preview before signing — the prompt mitigates the silent
 * semantics flip the rename introduces.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { parseUnits } from 'viem';
import { OspexValidationError, wei6ToDecimalUSDC } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import { promptYesNo } from '../../lib/prompt.js';

const optionsSchema = z.object({
  yes: z.boolean().optional(),
  json: z.boolean().optional(),
});

const USDC_DECIMAL_RE = /^\d+(?:\.\d{1,6})?$/;

export const commitmentsApproveCommand = new Command('approve')
  .description(
    'Approve PositionModule for USDC. Argument is decimal USDC (e.g. "5", "0.25") or "max" for unlimited. ' +
      'For raw 6-decimal units, use `ospex commitments approve-raw`. The blessed multi-spender setup path is ' +
      '`ospex approvals setup --risk-usdc <n>`.',
  )
  .argument('<amount>', 'decimal USDC ("5", "0.25") or "max"')
  .option('--yes', 'skip the confirmation prompt')
  .option('--json', 'machine-readable output')
  .action(async (amountArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const skipPrompt = opts.yes === true;
    const wantJson = opts.json === true;
    const isInteractiveTTY = process.stdin.isTTY === true;

    if (!skipPrompt && !isInteractiveTTY) {
      throw new OspexValidationError(
        '--yes is required for non-interactive runs of `commitments approve`. Re-run with --yes.',
      );
    }

    const parsed = parseHumanUsdc(amountArg);

    const client = await getClient({ requiresSigner: true, requiresChain: true });

    if (!skipPrompt) {
      const summary = parsed === 'max' ? 'unlimited (uint256 max)' : `${wei6ToDecimalUSDC(parsed)} USDC`;
      process.stderr.write(
        `\nApprove PositionModule for ${summary}?\n` +
          '(PositionModule pulls this USDC at match time as your maker / taker risk.)\n',
      );
      const ok = await promptYesNo('Proceed?');
      if (!ok) {
        process.stderr.write('Cancelled.\n');
        process.exit(130);
      }
    }

    const result = await client.commitments.approve(parsed);

    if (wantJson) {
      formatOutput(
        {
          schemaVersion: 1,
          txHash: result.txHash,
          spender: result.spender,
          token: result.token,
          amountRaw: result.amount.toString(),
          amountFormatted:
            parsed === 'max' ? 'max' : wei6ToDecimalUSDC(result.amount),
          status: result.receipt.status,
          blockNumber: result.receipt.blockNumber.toString(),
        },
        { json: true },
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        amount: parsed === 'max' ? '(uint256 max)' : `${wei6ToDecimalUSDC(result.amount)} USDC`,
        spender: result.spender,
        token: result.token,
        status: result.receipt.status,
        blockNumber: result.receipt.blockNumber.toString(),
      },
      { json: false },
    );
  });

/**
 * Parse decimal USDC into wei6 bigint, or `'max'`. Strict shape — the
 * regex rejects exponents, commas, leading +, and >6 fractional
 * digits. "0" is allowed and represents a revoke (USDC.approve
 * accepts a zero amount). The caller chooses whether to pass `'max'`
 * straight through to the SDK or convert to maxUint256.
 */
function parseHumanUsdc(input: string): bigint | 'max' {
  if (input === 'max') return 'max';
  if (!USDC_DECIMAL_RE.test(input)) {
    throw new OspexValidationError(
      `Invalid USDC amount "${input}". Use a decimal number (e.g. "5" or "0.25"), or "max" for unlimited. ` +
        'For raw 6-decimal-units (e.g. an integer like 5000000 = 5 USDC), use `ospex commitments approve-raw` instead.',
    );
  }
  const wei6 = parseUnits(input, 6);
  // wei6 = 0n is allowed (USDC.approve(spender, 0) revokes).
  return wei6;
}

// Re-export for tests / cross-command reuse without exposing it on the
// public command barrel.
export { parseHumanUsdc };
