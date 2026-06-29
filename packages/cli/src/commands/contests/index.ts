/**
 * Composes the `ospex contests *` command group.
 */
import { Command } from '@commander-js/extra-typings';
import { contestCreateCommand } from './create.js';
import { contestListCommand } from './list.js';
import { contestScoreCommand } from './score.js';
import { contestShowCommand } from './show.js';
import { contestWaitVerifiedCommand } from './wait-verified.js';

export function makeContestsCommand(): Command {
  const contests = new Command('contests').description(
    'Create, score, and inspect contests. ' +
      'Contest creation submits a CreOracleReceiver.createContestAndRequestVerify tx that triggers ' +
      'a Chainlink CRE verification request; scoring submits requestScore. Both are permissionless.',
  );
  contests.addCommand(contestCreateCommand);
  contests.addCommand(contestScoreCommand);
  contests.addCommand(contestShowCommand);
  contests.addCommand(contestListCommand);
  contests.addCommand(contestWaitVerifiedCommand);
  return contests;
}
