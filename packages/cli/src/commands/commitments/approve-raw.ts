/**
 * `ospex commitments approve-raw <wei6|max>` — protocol-level
 * shortcut for USDC.approve(PositionModule, amount) where the amount
 * is already in raw 6-decimal units. Parallels the
 * `submit` / `submit-raw` precedent: the high-level form accepts
 * decimal USDC, the raw form accepts canonical protocol values for
 * power users / scripts that already work in wei6.
 *
 * Most users should not run this — `ospex commitments approve <n>`
 * (decimal USDC) or `ospex approvals setup --risk-usdc <n> --fee-usdc
 * <n>` (the blessed multi-spender path; each flag targets only its own
 * spender) are clearer for the common case.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { Hex } from '@ospex/sdk';
import { OspexValidationError, wei6ToDecimalUSDC } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  emitJsonFailure,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import {
  VERIFY_ALLOWANCES,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import { promptYesNo } from '../../lib/prompt.js';

const optionsSchema = z.object({
  yes: z.boolean().optional(),
  json: z.boolean().optional(),
});

const WEI6_INTEGER_RE = /^\d+$/;

export const commitmentsApproveRawCommand = addSignerOptions(
  new Command('approve-raw')
    .description(
      'Approve PositionModule for USDC using a raw 6-decimal-units integer (e.g. "5000000" = 5 USDC). ' +
        'For decimal USDC use `ospex commitments approve <n>` instead.',
    )
    .argument('<wei6>', 'USDC units (6 decimals; integer) or "max"')
    .option('--yes', 'skip the confirmation prompt')
    .option('--json', 'machine-readable output'),
)
  .action(async (wei6Arg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const skipPrompt = opts.yes === true;
    const wantJson = opts.json === true;
    const isInteractiveTTY = process.stdin.isTTY === true;

    if (!skipPrompt && !isInteractiveTTY) {
      throw new OspexValidationError(
        '--yes is required for non-interactive runs of `commitments approve-raw`. Re-run with --yes.',
      );
    }

    const parsed = parseRawWei6(wei6Arg);

    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });
    const chainId = client.chainId();
    let signerAddress: Hex | null = null;

    try {
    // Resolve the signer up-front so a failure envelope from the
    // catch below carries wallet/signer populated.
    signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;

    if (!skipPrompt) {
      const summary =
        parsed === 'max'
          ? 'unlimited (uint256 max)'
          : `${wei6ToDecimalUSDC(parsed)} USDC (= ${parsed.toString()} wei6)`;
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
      const blockNumber = result.receipt.blockNumber.toString();
      writeAgentEnvelope(
        buildAgentEnvelope({
          ok: result.receipt.status === 'success',
          action: 'commitments.approve-raw',
          stage: 'execute',
          network: networkForChainId(chainId),
          chainId,
          wallet: signerAddress,
          walletRole: 'signer',
          signer: signerAddress,
          effects: [
            {
              type: 'transaction',
              purpose: 'approve-usdc',
              ok: result.receipt.status === 'success',
              txHash: result.txHash,
              blockNumber,
              status: result.receipt.status === 'success' ? 'confirmed' : 'reverted',
            },
          ],
          nextCommands: [VERIFY_ALLOWANCES.build({ address: signerAddress })],
          payload: {
            txHash: result.txHash,
            spender: result.spender,
            token: result.token,
            amountRaw: result.amount.toString(),
            amountFormatted:
              parsed === 'max' ? 'max' : wei6ToDecimalUSDC(result.amount),
            status: result.receipt.status,
            blockNumber,
          },
        }),
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        amount:
          parsed === 'max'
            ? '(uint256 max)'
            : `${wei6ToDecimalUSDC(result.amount)} USDC (${result.amount.toString()} wei6)`,
        spender: result.spender,
        token: result.token,
        status: result.receipt.status,
        blockNumber: result.receipt.blockNumber.toString(),
      },
      { json: false },
    );
    } catch (err) {
      if (wantJson) {
        emitJsonFailure({
          action: 'commitments.approve-raw',
          stage: 'execute',
          chainId,
          wallet: signerAddress,
          walletRole: 'signer',
          signer: signerAddress,
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

/**
 * Parse a raw wei6 integer string (or 'max'). Decimal points and
 * non-integer characters are rejected — for decimal USDC use
 * `commitments approve` (which routes through this command's sibling
 * parseHumanUsdc).
 */
function parseRawWei6(input: string): bigint | 'max' {
  if (input === 'max') return 'max';
  if (!WEI6_INTEGER_RE.test(input)) {
    throw new OspexValidationError(
      `Invalid wei6 amount "${input}". Use an integer (e.g. "5000000" = 5 USDC), or "max". ` +
        'For decimal USDC, use `ospex commitments approve` instead.',
    );
  }
  return BigInt(input);
}

export { parseRawWei6 };
