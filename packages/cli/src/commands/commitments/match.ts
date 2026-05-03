/**
 * `ospex commitments match <hash> [--risk <amount>]`
 *
 * Looks up the maker commitment by hash, computes the taker outlay,
 * checks the taker's USDC allowance for PositionModule, and submits
 * `MatchingModule.matchCommitment(...)` as the configured wallet.
 * Same allowance-prompt UX as `submit`.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexAllowanceError } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import { promptYesNo, promptValue } from '../../lib/prompt.js';
import type { Hex } from '@ospex/sdk';

const optionsSchema = z.object({
  risk: z.string().regex(/^[0-9]+$/, 'risk must be a USDC-units integer').optional(),
  json: z.boolean().optional(),
});

export const commitmentsMatchCommand = new Command('match')
  .description('Match an existing commitment as the taker.')
  .argument('<hash>', '0x-prefixed 32-byte commitment hash')
  .option('--risk <amount>', 'taker desired risk (USDC, 6 decimals); default = full remaining')
  .option('--json', 'output as JSON')
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const hash = hashArg as Hex;
    const matchArgs = opts.risk !== undefined ? { takerDesiredRisk: BigInt(opts.risk) } : {};

    const client = await getClient({ requiresSigner: true, requiresChain: true });

    const tryMatch = async () => client.commitments.match(hash, matchArgs);

    let result;
    try {
      result = await tryMatch();
    } catch (err) {
      if (!(err instanceof OspexAllowanceError)) throw err;
      const handled = await handleAllowance(client, err);
      if (!handled) throw err;
      result = await tryMatch();
    }

    if (opts.json === true) {
      formatOutput(
        {
          txHash: result.txHash,
          takerRisk: result.takerRisk.toString(),
          fillMakerRisk: result.fillMakerRisk.toString(),
          status: result.receipt.status,
        },
        { json: true },
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        status: result.receipt.status,
        takerRisk: result.takerRisk.toString(),
        fillMakerRisk: result.fillMakerRisk.toString(),
        blockNumber: result.receipt.blockNumber.toString(),
      },
      { json: false },
    );
  });

async function handleAllowance(
  client: Awaited<ReturnType<typeof getClient>>,
  err: OspexAllowanceError,
): Promise<boolean> {
  process.stdout.write(
    `\nInsufficient USDC allowance.\n` +
      `  Required: ${err.required.toString()}\n` +
      `  Current:  ${err.current.toString()}\n` +
      `  Spender:  ${err.spender} (PositionModule)\n` +
      `  Token:    ${err.token} (USDC)\n`,
  );
  const ok = await promptYesNo('Approve PositionModule for USDC?', true);
  if (!ok) return false;
  const choice = await promptValue('Amount? (max | <usdc-units>)', 'max');
  const approveAmount = choice === 'max' ? 'max' : BigInt(choice);
  const tx = await client.commitments.approve(approveAmount);
  process.stdout.write(`approve tx: ${tx.txHash} (status ${tx.receipt.status})\n`);
  return true;
}
