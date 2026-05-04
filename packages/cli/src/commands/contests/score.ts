/**
 * `ospex contest score <contestId>` — submit a scoring request.
 * Returns immediately after on-chain inclusion; the Chainlink callback
 * (with the actual score) lands ~30-90 s later. Caller can poll
 * `ospex contest get <contestId>` for `status === 'scored'`.
 */
import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexAllowanceError, type OspexClient } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import { promptYesNo, promptValue } from '../../lib/prompt.js';

const optionsSchema = z.object({
  subscriptionId: z.string().regex(/^[0-9]+$/).optional(),
  gasLimit: z.coerce.number().int().positive().max(10_000_000).optional(),
  json: z.boolean().optional(),
});

export const contestScoreCommand = new Command('score')
  .description('Submit OracleModule.scoreContestFromOracle for an existing contest.')
  .argument('<contestId>', 'contest id (uint256)')
  .option('--subscription-id <n>', 'Chainlink Functions subscription id')
  .option('--gas-limit <n>', 'callback gas limit (default 500000)')
  .addOption(new Option('--json').hideHelp(false))
  .action(async (contestIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: true, requiresChain: true });

    const args: Parameters<typeof client.contests.score>[0] = {
      contestId: BigInt(contestIdArg),
    };
    if (opts.subscriptionId !== undefined) args.subscriptionId = BigInt(opts.subscriptionId);
    if (opts.gasLimit !== undefined) args.gasLimit = opts.gasLimit;

    const tryScore = async () => client.contests.score(args);

    let result;
    try {
      result = await tryScore();
    } catch (err) {
      if (!(err instanceof OspexAllowanceError)) throw err;
      const handled = await handleLinkAllowance(client, err);
      if (!handled) throw err;
      result = await tryScore();
    }

    if (opts.json === true) {
      formatOutput(
        {
          contestId: result.contestId.toString(),
          txHash: result.txHash,
          requestId: result.requestId,
          status: result.receipt.status,
        },
        { json: true },
      );
    } else {
      process.stdout.write(
        `Scoring request sent (tx ${result.txHash}).\n` +
          (result.requestId !== null ? `Chainlink requestId: ${result.requestId}\n` : '') +
          `Chainlink callback typically lands within 30-90s. ` +
          `Run \`ospex contest get ${result.contestId}\` to check status.\n`,
      );
    }
  });

async function handleLinkAllowance(
  client: OspexClient,
  err: OspexAllowanceError,
): Promise<boolean> {
  process.stdout.write(
    `\nInsufficient LINK allowance.\n` +
      `  Required: ${err.required.toString()}\n` +
      `  Current:  ${err.current.toString()}\n` +
      `  Spender:  ${err.spender} (OracleModule)\n` +
      `  Token:    ${err.token}\n`,
  );
  const ok = await promptYesNo('Approve OracleModule for LINK?', true);
  if (!ok) return false;
  const choice = await promptValue('Amount? (max | <wei units>)', 'max');
  const approveAmount = choice === 'max' ? 'max' : BigInt(choice);
  const tx = await client.contests.approveLink(approveAmount);
  process.stdout.write(`approve tx: ${tx.txHash} (status ${tx.receipt.status})\n`);
  return true;
}
