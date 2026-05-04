/**
 * `ospex contests create [--rundown-id ID] [--sportspage-id ID] [--jsonodds-id ID]`
 *  - At least one of the three external ids is required.
 *  - On OspexAllowanceError: prompt to approve the right (token, spender)
 *    pair and retry once. LINK→OracleModule and USDC→TreasuryModule are
 *    distinguished from M2's USDC→PositionModule by inspecting err.token.
 *  - Without `--no-wait`, blocks until the Chainlink callback flips the
 *    contest to Verified (or timeout, in which case the contestId is
 *    surfaced and the user can re-poll with `ospex contests wait-verified`).
 */
import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getAddresses, OspexAllowanceError, type OspexClient } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import { promptYesNo, promptValue } from '../../lib/prompt.js';

const optionsSchema = z.object({
  rundownId: z.string().min(1).optional(),
  sportspageId: z.string().min(1).optional(),
  jsonoddsId: z.string().min(1).optional(),
  subscriptionId: z.string().regex(/^[0-9]+$/).optional(),
  gasLimit: z.coerce.number().int().positive().max(10_000_000).optional(),
  // Commander's `--no-wait` attribute name is `wait` (default true).
  // The schema must mirror commander's naming or Zod silently strips the
  // value and the wait branch always runs.
  wait: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const contestCreateCommand = new Command('create')
  .description('Create a contest by submitting OracleModule.createContestFromOracle.')
  .option('--rundown-id <id>', 'Rundown contest id')
  .option('--sportspage-id <id>', 'Sportspage contest id')
  .option('--jsonodds-id <id>', 'JSONOdds contest id')
  .option(
    '--subscription-id <n>',
    'Chainlink Functions subscription id (defaults to OSPEX_SHARED_SUBSCRIPTION_ID per chain)',
  )
  .option('--gas-limit <n>', 'callback gas limit (default 500000)')
  .option('--no-wait', 'skip polling for verification; print txHash and return')
  .addOption(new Option('--json').hideHelp(false))
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    if (
      opts.rundownId === undefined &&
      opts.sportspageId === undefined &&
      opts.jsonoddsId === undefined
    ) {
      throw new Error('Provide at least one of --rundown-id, --sportspage-id, --jsonodds-id.');
    }

    const client = await getClient({ requiresSigner: true, requiresChain: true });

    const args: Parameters<typeof client.contests.create>[0] = {};
    if (opts.rundownId !== undefined) args.rundownId = opts.rundownId;
    if (opts.sportspageId !== undefined) args.sportspageId = opts.sportspageId;
    if (opts.jsonoddsId !== undefined) args.jsonoddsId = opts.jsonoddsId;
    if (opts.subscriptionId !== undefined) args.subscriptionId = BigInt(opts.subscriptionId);
    if (opts.gasLimit !== undefined) args.gasLimit = opts.gasLimit;

    if (opts.subscriptionId === undefined && opts.json !== true) {
      process.stdout.write(
        'Using protocol shared Chainlink Functions subscription. Pass --subscription-id to use your own.\n',
      );
    }

    const tryCreate = async () => client.contests.create(args);

    let result;
    try {
      result = await tryCreate();
    } catch (err) {
      if (!(err instanceof OspexAllowanceError)) throw err;
      const handled = await handleContestAllowance(client, err);
      if (!handled) throw err;
      result = await tryCreate();
    }

    // Pretty-print the create result immediately; defer JSON emission
    // to the end so a single combined document covers create +
    // verification. Two separate JSON docs on stdout aren't parseable
    // by automation.
    if (opts.json !== true) {
      process.stdout.write(
        `Contest ${result.contestId} created (tx ${result.txHash}).\n` +
          (result.requestId !== null ? `Chainlink requestId: ${result.requestId}\n` : ''),
      );
    }

    const shouldWait = opts.wait !== false;
    let verification: { contestId: string; status: string } | null = null;
    let verificationError: unknown = null;

    if (shouldWait) {
      if (opts.json !== true) {
        process.stdout.write('Waiting for Chainlink verification (≤120s)...\n');
      }
      try {
        const verified = await client.contests.waitForVerified(result.contestId);
        verification = {
          contestId: verified.contestId.toString(),
          status: verified.status,
        };
        if (opts.json !== true) {
          process.stdout.write(`Verified. Status: ${verified.status}.\n`);
        }
      } catch (err) {
        verificationError = err;
        if (opts.json !== true) {
          process.stdout.write(
            `Verification did not complete in time. Run \`ospex contests wait-verified ${result.contestId}\` to keep watching.\n`,
          );
        }
      }
    }

    if (opts.json === true) {
      formatOutput(
        {
          contestId: result.contestId.toString(),
          txHash: result.txHash,
          requestId: result.requestId,
          status: result.receipt.status,
          verification,
        },
        { json: true },
      );
    }

    if (verificationError !== null) throw verificationError;
  });

async function handleContestAllowance(
  client: OspexClient,
  err: OspexAllowanceError,
): Promise<boolean> {
  // Distinguish LINK→OracleModule from USDC→TreasuryModule by spender.
  const spender = err.spender.toLowerCase();
  const oracleModule = getAddresses(client.chainId()).oracleModule.toLowerCase();
  const isLink = spender === oracleModule;

  process.stdout.write(
    `\nInsufficient ${isLink ? 'LINK' : 'USDC'} allowance.\n` +
      `  Required: ${err.required.toString()}\n` +
      `  Current:  ${err.current.toString()}\n` +
      `  Spender:  ${err.spender} (${isLink ? 'OracleModule' : 'TreasuryModule'})\n` +
      `  Token:    ${err.token}\n`,
  );
  const ok = await promptYesNo(
    `Approve ${isLink ? 'OracleModule for LINK' : 'TreasuryModule for USDC'}?`,
    true,
  );
  if (!ok) return false;
  const choice = await promptValue('Amount? (max | <wei units>)', 'max');
  const approveAmount = choice === 'max' ? 'max' : BigInt(choice);
  const tx = isLink
    ? await client.contests.approveLink(approveAmount)
    : await client.contests.approveFee(approveAmount);
  process.stdout.write(`approve tx: ${tx.txHash} (status ${tx.receipt.status})\n`);
  return true;
}
