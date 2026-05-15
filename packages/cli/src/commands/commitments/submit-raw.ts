/**
 * `ospex commitments submit-raw <contestId> <scorer> <lineTicks> <position> <oddsTick> <riskAmount>`
 *
 * Protocol-level escape hatch — direct positional surface mirroring the
 * on-chain OspexCommitment struct (no speculationId — the contract
 * derives that from contestId+scorer+lineTicks). Most users should
 * reach for the high-level `ospex commitments submit` (lands in the
 * follow-up PR) which accepts domain-language inputs and renders an
 * explicit win/lose/push preview before signing.
 *
 * On `OspexAllowanceError` we offer to approve PositionModule and
 * retry once. Prints the EIP-712 commitment hash on success.
 */

import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexAllowanceError } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import { promptYesNo, promptValue } from '../../lib/prompt.js';
import type { Hex } from '@ospex/sdk';

const positionSchema = z.enum(['upper', 'lower', '0', '1']);

const optionsSchema = z.object({
  expiry: z.string().optional(),
  nonce: z.string().regex(/^[0-9]+$/).optional(),
  json: z.boolean().optional(),
});

function parsePosition(raw: string): 0 | 1 {
  const parsed = positionSchema.parse(raw);
  if (parsed === 'upper' || parsed === '0') return 0;
  return 1;
}

function parseExpiry(raw: string): bigint {
  if (/^[0-9]+$/.test(raw)) return BigInt(raw);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid --expiry "${raw}". Use unix-seconds or ISO-8601.`);
  }
  return BigInt(Math.floor(ms / 1000));
}

export const commitmentsSubmitRawCommand = addSignerOptions(
  new Command('submit-raw')
    .description(
      'Protocol-level escape hatch — sign + post an EIP-712 OspexCommitment using ' +
        'the literal canonical tuple. Prefer `ospex commitments submit` for the ' +
        'domain-language flow with preview block.',
    )
    .argument('<contestId>', 'contest id (uint256)')
    .argument('<scorer>', 'scorer module address')
    .argument('<lineTicks>', 'line ticks (int32, 10× scale)')
    .argument('<position>', 'upper | lower (or 0 | 1)')
    .argument('<oddsTick>', 'odds tick (uint16, 100× scale; 191 = 1.91)')
    .argument('<riskAmount>', 'risk amount (USDC, 6 decimals; multiple of 100)')
    .option('--expiry <iso-or-unix>', 'expiry (default: 24h from now)')
    .option('--nonce <bigint>', 'override nonce strategy with an explicit value')
    .addOption(new Option('--json').hideHelp(false)),
)
  .action(async (contestIdArg, scorerArg, lineTicksArg, positionArg, oddsTickArg, riskAmountArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const args = {
      contestId: BigInt(contestIdArg),
      scorer: scorerArg as Hex,
      lineTicks: Number(lineTicksArg),
      positionType: parsePosition(positionArg),
      oddsTick: Number(oddsTickArg),
      riskAmount: BigInt(riskAmountArg),
      ...(opts.expiry !== undefined ? { expiry: parseExpiry(opts.expiry) } : {}),
      ...(opts.nonce !== undefined ? { nonce: BigInt(opts.nonce) } : {}),
    };

    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });

    const trySubmit = async () => client.commitments.submitRaw(args);

    let result;
    try {
      result = await trySubmit();
    } catch (err) {
      if (!(err instanceof OspexAllowanceError)) throw err;
      const handled = await handleAllowance(client, err);
      if (!handled) throw err;
      result = await trySubmit();
    }

    if (opts.json === true) {
      formatOutput({ hash: result.hash, commitment: result.commitment }, { json: true });
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
