/**
 * `ospex contests create --game-id <id>`
 *  - `gameId` is the stable identifier from `ospex games list` (the
 *    row's `jsonodds_id`). The SDK fetches `/v1/games/:gameId`,
 *    extracts the three external IDs the contract requires, and builds
 *    the on-chain tx. Users never deal with the three IDs directly.
 *  - On OspexAllowanceError: prompt to approve the right (token, spender)
 *    pair and retry. Both LINK→OracleModule and USDC→TreasuryModule may
 *    be missing on a fresh wallet, so the call site loops up to two
 *    approvals before giving up — fixing one at a time would surface the
 *    second as a hard error after a successful approve tx.
 *  - Without `--no-wait`, blocks until the Chainlink callback flips the
 *    contest to Verified (or timeout, in which case the contestId is
 *    surfaced and the user can re-poll with `ospex contests wait-verified`).
 */
import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import { formatUnits, parseUnits } from 'viem';
import { getAddresses, OspexAllowanceError, type OspexClient } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import { promptYesNo, promptValue } from '../../lib/prompt.js';

const optionsSchema = z.object({
  gameId: z.string().min(1),
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
  .requiredOption('--game-id <id>', 'gameId from `ospex games list`')
  .option(
    '--subscription-id <n>',
    'Chainlink Functions subscription id (defaults to OSPEX_SHARED_SUBSCRIPTION_ID per chain)',
  )
  .option('--gas-limit <n>', 'callback gas limit (default 500000)')
  .option('--no-wait', 'skip polling for verification; print txHash and return')
  .addOption(new Option('--json').hideHelp(false))
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);

    const client = await getClient({ requiresSigner: true, requiresChain: true });

    const args: Parameters<typeof client.contests.create>[0] = {
      gameId: opts.gameId,
    };
    if (opts.subscriptionId !== undefined) args.subscriptionId = BigInt(opts.subscriptionId);
    if (opts.gasLimit !== undefined) args.gasLimit = opts.gasLimit;

    // A fresh wallet typically needs two approvals (USDC fee, LINK
    // payment). Loop the catch so the second approval prompt fires
    // automatically after the first one succeeds — otherwise the user
    // sees a successful approve tx followed by a hard error.
    const MAX_APPROVAL_RETRIES = 2;
    let result: Awaited<ReturnType<typeof client.contests.create>> | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_APPROVAL_RETRIES; attempt++) {
      try {
        result = await client.contests.create(args);
        break;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof OspexAllowanceError)) throw err;
        if (attempt === MAX_APPROVAL_RETRIES) throw err;
        const handled = await handleContestAllowance(client, err, opts.json === true);
        if (!handled) throw err;
      }
    }
    if (result === undefined) {
      throw lastErr ?? new Error('Contest creation did not return a result.');
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

interface AllowanceCopy {
  symbol: 'LINK' | 'USDC';
  decimals: number;
  moduleName: string;
  purpose: string;
}

function describeAllowance(client: OspexClient, err: OspexAllowanceError): AllowanceCopy {
  // Distinguish LINK→OracleModule from USDC→TreasuryModule by spender.
  const oracleModule = getAddresses(client.chainId()).oracleModule.toLowerCase();
  const isLink = err.spender.toLowerCase() === oracleModule;
  return isLink
    ? {
        symbol: 'LINK',
        decimals: 18,
        moduleName: 'OracleModule',
        purpose: 'Chainlink Functions request payment',
      }
    : {
        symbol: 'USDC',
        decimals: 6,
        moduleName: 'TreasuryModule',
        purpose: 'protocol contest creation fee',
      };
}

async function handleContestAllowance(
  client: OspexClient,
  err: OspexAllowanceError,
  jsonMode: boolean,
): Promise<boolean> {
  const copy = describeAllowance(client, err);
  const requiredHuman = formatUnits(err.required, copy.decimals);
  const currentHuman = formatUnits(err.current, copy.decimals);

  // In --json mode, the user is scripting and probably doesn't want a
  // half-open interactive flow. Surface the error so they can supply
  // the approval out-of-band (`ospex contests approve …` is the SDK
  // surface; the CLI subcommand for it is on the M3 backlog).
  if (jsonMode) return false;

  process.stderr.write(
    `\n${copy.symbol} approval needed (${copy.purpose}).\n` +
      `  Required: ${requiredHuman} ${copy.symbol}\n` +
      `  Approved: ${currentHuman} ${copy.symbol}\n` +
      `\nThe ${copy.moduleName} contract pulls this ${copy.symbol} from your wallet during the\n` +
      `create transaction. This is a standard ERC-20 \`approve\` — your tokens stay in\n` +
      `your wallet until the create call runs. Approve more than the minimum if you\n` +
      `want to skip this prompt on future create calls.\n` +
      `  Spender: ${err.spender} (${copy.moduleName})\n` +
      `  Token:   ${err.token} (${copy.symbol})\n`,
  );

  const ok = await promptYesNo(
    `Allow ${copy.moduleName} to spend ${copy.symbol} from your wallet?`,
    true,
  );
  if (!ok) return false;

  const choice = await promptValue(
    `Amount in ${copy.symbol} (number, or "max" for unlimited)`,
    requiredHuman,
  );
  let approveAmount: bigint | 'max';
  if (choice.toLowerCase() === 'max') {
    approveAmount = 'max';
  } else {
    try {
      approveAmount = parseUnits(choice, copy.decimals);
    } catch {
      process.stderr.write(`Could not parse "${choice}" as a ${copy.symbol} amount.\n`);
      return false;
    }
    if (approveAmount < err.required) {
      process.stderr.write(
        `Amount ${choice} ${copy.symbol} is less than the required ${requiredHuman} ${copy.symbol}.\n`,
      );
      return false;
    }
  }

  const tx =
    copy.symbol === 'LINK'
      ? await client.contests.approveLink(approveAmount)
      : await client.contests.approveFee(approveAmount);
  process.stdout.write(`approve tx: ${tx.txHash} (status ${tx.receipt.status})\n`);
  return true;
}
