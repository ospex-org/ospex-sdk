#!/usr/bin/env node
/**
 * `ospex` CLI entry point. Registers every command and dispatches.
 *
 * Errors fall through to commander; we print the message to stderr and
 * exit non-zero, but suppress the stack trace for typed Ospex errors —
 * those are user-facing problems (bad input, missing config) and a
 * stack trace is noise.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from '@commander-js/extra-typings';
import { OspexError } from '@ospex/sdk';

import { CLI_VERSION } from './lib/agentEnvelope.js';
import { sanitizeUntargetedMessage } from './lib/redact.js';

import { healthCommand } from './commands/health.js';
import { initCommand } from './commands/init.js';
import { doctorCommand } from './commands/doctor.js';
import { approvalsShowCommand } from './commands/approvals/show.js';
import { approvalsSetupCommand } from './commands/approvals/setup.js';
import { commitmentsListCommand } from './commands/commitments/list.js';
import { commitmentsApproveCommand } from './commands/commitments/approve.js';
import { commitmentsApproveRawCommand } from './commands/commitments/approve-raw.js';
import { commitmentsSubmitCommand } from './commands/commitments/submit.js';
import { commitmentsSubmitRawCommand } from './commands/commitments/submit-raw.js';
import { commitmentsMatchCommand } from './commands/commitments/match.js';
import { commitmentsFillabilityCommand } from './commands/commitments/fillability.js';
import { commitmentsCancelCommand } from './commands/commitments/cancel.js';
import { commitmentsCancelOnchainCommand } from './commands/commitments/cancel-onchain.js';
import { commitmentsCancelAllCommand } from './commands/commitments/cancel-all.js';
import { commitmentsNonceFloorCommand } from './commands/commitments/nonce-floor.js';
import { commitmentsShowCommand } from './commands/commitments/show.js';
import { makeContestsCommand } from './commands/contests/index.js';
import { gamesCommand } from './commands/games/index.js';
import { makeSpeculationsCommand } from './commands/speculations/index.js';
import { positionsListCommand } from './commands/positions/list.js';
import { positionsStatusCommand } from './commands/positions/status.js';
import { positionsClaimCommand } from './commands/positions/claim.js';
import { positionsClaimAllCommand } from './commands/positions/claim-all.js';
import { positionsSettleCommand } from './commands/positions/settle.js';
import { positionsHistoryCommand } from './commands/positions/history.js';
import { leaderboardShowCommand } from './commands/leaderboard/show.js';
import { makeOddsCommand } from './commands/odds/index.js';
import { makeOwnStateCommand } from './commands/own-state/index.js';
import { walletImportCommand } from './commands/wallet/import.js';
import { walletUnlockCommand } from './commands/wallet/unlock.js';
import { walletLockCommand } from './commands/wallet/lock.js';
import { walletAddressCommand } from './commands/wallet/address.js';
import { authUseFoundryCommand } from './commands/auth/use-foundry.js';
import { authClearFoundryCommand } from './commands/auth/clear-foundry.js';
import { authCheckCommand } from './commands/auth/check.js';

/**
 * Build the top-level commander program. Exported (rather than
 * inlined into `main()`) so tests can construct a program instance
 * and parse argv through it — most notably the PR-7
 * `nextCommands` argv-roundtrip test (`tests/next-commands-argv-
 * roundtrip.test.ts`), which validates every registered template's
 * argv against the real command surface.
 */
export function makeProgram(): Command {
  const program = new Command()
    .name('ospex')
    .description('Command-line interface for the Ospex protocol.')
    .version(CLI_VERSION);

  program.addCommand(healthCommand);
  program.addCommand(doctorCommand);
  program.addCommand(initCommand);

  const commitments = new Command('commitments').description(
    'Read or sign commitments (orderbook + EIP-712 submit/match/cancel).',
  );
  commitments.addCommand(commitmentsListCommand);
  commitments.addCommand(commitmentsShowCommand);
  commitments.addCommand(commitmentsApproveCommand);
  commitments.addCommand(commitmentsApproveRawCommand);
  commitments.addCommand(commitmentsSubmitCommand);
  commitments.addCommand(commitmentsSubmitRawCommand);
  commitments.addCommand(commitmentsMatchCommand);
  commitments.addCommand(commitmentsFillabilityCommand);
  commitments.addCommand(commitmentsCancelCommand);
  commitments.addCommand(commitmentsCancelOnchainCommand);
  commitments.addCommand(commitmentsCancelAllCommand);
  commitments.addCommand(commitmentsNonceFloorCommand);
  program.addCommand(commitments);

  program.addCommand(makeContestsCommand());
  program.addCommand(gamesCommand);
  program.addCommand(makeSpeculationsCommand());

  const positions = new Command('positions').description('Read positions for an address.');
  positions.addCommand(positionsListCommand);
  positions.addCommand(positionsStatusCommand);
  positions.addCommand(positionsHistoryCommand);
  program.addCommand(positions);

  // Top-level write commands. `claim`/`settle`/`claim-all` aren't
  // nested under `positions` so the day-to-day flow ("ospex claim-all"
  // → done) reads naturally.
  program.addCommand(positionsClaimCommand);
  program.addCommand(positionsClaimAllCommand);
  program.addCommand(positionsSettleCommand);

  const leaderboard = new Command('leaderboard').description('Read the active leaderboard.');
  leaderboard.addCommand(leaderboardShowCommand);
  program.addCommand(leaderboard);

  program.addCommand(makeOddsCommand());
  program.addCommand(makeOwnStateCommand());

  const wallet = new Command('wallet').description('Manage the local keystore wallet.');
  wallet.addCommand(walletImportCommand);
  wallet.addCommand(walletUnlockCommand);
  wallet.addCommand(walletLockCommand);
  wallet.addCommand(walletAddressCommand);
  program.addCommand(wallet);

  const approvals = new Command('approvals').description(
    'Inspect and manage USDC + LINK approvals against Ospex modules.',
  );
  approvals.addCommand(approvalsShowCommand);
  approvals.addCommand(approvalsSetupCommand);
  program.addCommand(approvals);

  const auth = new Command('auth').description(
    'Manage non-interactive Foundry signer defaults in ~/.ospex/config.json. ' +
      'Use `auth use-foundry` to pin an account + password file (and, by default, ' +
      'the resolved address); use `auth clear-foundry` to remove the pinned defaults; ' +
      'use `auth check` to diagnose the resolved signer source without signing a tx.',
  );
  auth.addCommand(authUseFoundryCommand);
  auth.addCommand(authClearFoundryCommand);
  auth.addCommand(authCheckCommand);
  program.addCommand(auth);

  return program;
}

async function main(): Promise<void> {
  const program = makeProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof OspexError) {
      process.stderr.write(`error (${err.code}): ${sanitizeUntargetedMessage(err.message)}\n`);
      writeCauseChain(err);
      process.exit(1);
    }
    if (err instanceof Error) {
      process.stderr.write(`error: ${sanitizeUntargetedMessage(err.message)}\n`);
      writeCauseChain(err);
      process.exit(1);
    }
    process.stderr.write(`error: ${sanitizeUntargetedMessage(String(err))}\n`);
    process.exit(1);
  }
}

/**
 * Walk `Error.cause` chain to surface viem / RPC errors that the SDK
 * attached but didn't unpack. viem's BaseError carries the decoded
 * revert under `shortMessage` and any auxiliary lines under
 * `metaMessages` — both are useful when an estimateGas reverts in
 * `contests create` and the cause is a custom error like
 * `OracleModule__InvalidScriptApproval`.
 *
 * Both `headline` and every `metaMessages` line are routed through
 * `sanitizeUntargetedMessage` first: viem transport errors embed the
 * request URL (including a credentialed Alchemy `/v2/<key>`) in
 * `metaMessages[]`, and AGENT_ENVELOPE_SPEC §7 bans secrets on stderr
 * as well as stdout. The sanitizer is a no-op on credential-free
 * lines, so legitimate revert detail is preserved verbatim.
 */
function writeCauseChain(err: unknown): void {
  let cur: unknown = (err as { cause?: unknown }).cause;
  let depth = 0;
  while (cur instanceof Error && depth < 6) {
    const e = cur as {
      message: string;
      shortMessage?: string;
      metaMessages?: string[];
    };
    const headline = e.shortMessage ?? e.message;
    process.stderr.write(`  caused by: ${sanitizeUntargetedMessage(headline)}\n`);
    if (e.metaMessages?.length) {
      for (const line of e.metaMessages) {
        process.stderr.write(`    ${sanitizeUntargetedMessage(line)}\n`);
      }
    }
    cur = (cur as { cause?: unknown }).cause;
    depth++;
  }
}

/**
 * True when this module is the program entry point — i.e. invoked
 * directly via `node dist/index.js` OR via the `ospex` bin symlink
 * that `npm install` / `yarn add` creates in `node_modules/.bin`.
 *
 * The naive comparison `process.argv[1] === fileURLToPath(import.meta.url)`
 * fails through the bin symlink: argv[1] points at
 * `node_modules/.bin/ospex` while import.meta.url resolves to
 * `node_modules/@ospex/cli/dist/index.js`, so main() never runs and
 * the installed CLI becomes a no-op (review blocker).
 *
 * Fix: resolve BOTH paths via `realpathSync` so symlinks collapse
 * to their canonical targets before comparison. realpathSync can
 * throw on a path that doesn't exist; defensive try/catch returns
 * false so test imports never accidentally fire main().
 */
export function isMainModule(argv1: string | undefined, metaUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    const argvReal = realpathSync(argv1);
    const moduleReal = realpathSync(fileURLToPath(metaUrl));
    return argvReal === moduleReal;
  } catch {
    return false;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  void main();
}
