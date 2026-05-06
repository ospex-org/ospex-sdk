#!/usr/bin/env node
/**
 * `ospex` CLI entry point. Registers every command and dispatches.
 *
 * Errors fall through to commander; we print the message to stderr and
 * exit non-zero, but suppress the stack trace for typed Ospex errors —
 * those are user-facing problems (bad input, missing config) and a
 * stack trace is noise.
 */

import { Command } from '@commander-js/extra-typings';
import { OspexError } from '@ospex/sdk';

import { healthCommand } from './commands/health.js';
import { initCommand } from './commands/init.js';
import { commitmentsListCommand } from './commands/commitments/list.js';
import { commitmentsApproveCommand } from './commands/commitments/approve.js';
import { commitmentsSubmitCommand } from './commands/commitments/submit.js';
import { commitmentsMatchCommand } from './commands/commitments/match.js';
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
import { oddsWatchCommand } from './commands/odds/watch.js';
import { walletImportCommand } from './commands/wallet/import.js';
import { walletUnlockCommand } from './commands/wallet/unlock.js';
import { walletLockCommand } from './commands/wallet/lock.js';
import { walletAddressCommand } from './commands/wallet/address.js';

function makeProgram(): Command {
  const program = new Command()
    .name('ospex')
    .description('Command-line interface for the Ospex protocol.')
    .version('0.1.0');

  program.addCommand(healthCommand);
  program.addCommand(initCommand);

  const commitments = new Command('commitments').description(
    'Read or sign commitments (orderbook + EIP-712 submit/match/cancel).',
  );
  commitments.addCommand(commitmentsListCommand);
  commitments.addCommand(commitmentsShowCommand);
  commitments.addCommand(commitmentsApproveCommand);
  commitments.addCommand(commitmentsSubmitCommand);
  commitments.addCommand(commitmentsMatchCommand);
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

  const odds = new Command('odds').description('Live odds streaming.');
  odds.addCommand(oddsWatchCommand);
  program.addCommand(odds);

  const wallet = new Command('wallet').description('Manage the local keystore wallet.');
  wallet.addCommand(walletImportCommand);
  wallet.addCommand(walletUnlockCommand);
  wallet.addCommand(walletLockCommand);
  wallet.addCommand(walletAddressCommand);
  program.addCommand(wallet);

  return program;
}

async function main(): Promise<void> {
  const program = makeProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof OspexError) {
      process.stderr.write(`error (${err.code}): ${err.message}\n`);
      process.exit(1);
    }
    if (err instanceof Error) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`error: ${String(err)}\n`);
    process.exit(1);
  }
}

void main();
