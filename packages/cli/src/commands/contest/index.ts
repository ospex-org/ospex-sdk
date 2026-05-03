/**
 * Composes the `ospex contest *` command group.
 */
import { Command } from '@commander-js/extra-typings';
import { contestCreateCommand } from './create.js';
import { contestGetCommand } from './get.js';
import { contestListCommand } from './list.js';
import { contestScoreCommand } from './score.js';
import { contestScriptsCommand } from './scripts.js';
import { contestWaitVerifiedCommand } from './wait-verified.js';

export function makeContestCommand(): Command {
  const contest = new Command('contest').description(
    'Create, score, and inspect contests. ' +
      'Contest creation submits an OracleModule.createContestFromOracle tx that triggers a ' +
      'Chainlink Functions verification request; scoring submits scoreContestFromOracle.',
  );
  contest.addCommand(contestCreateCommand);
  contest.addCommand(contestScoreCommand);
  contest.addCommand(contestGetCommand);
  contest.addCommand(contestListCommand);
  contest.addCommand(contestWaitVerifiedCommand);
  contest.addCommand(contestScriptsCommand);
  return contest;
}
