/**
 * Composes the `ospex contests *` command group.
 */
import { Command } from '@commander-js/extra-typings';
import { contestCreateCommand } from './create.js';
import { contestListCommand } from './list.js';
import { contestScoreCommand } from './score.js';
import { contestShowCommand } from './show.js';
import { contestUpdateMarketsCommand } from './update-markets.js';
import { contestWaitVerifiedCommand } from './wait-verified.js';

export function makeContestsCommand(): Command {
  const contests = new Command('contests').description(
    'Create, score, refresh markets for, and inspect contests. ' +
      'Contest creation submits a CreOracleReceiver.createContestAndRequestVerify tx that triggers ' +
      'a Chainlink CRE verification request; scoring submits requestScore; update-markets submits ' +
      'requestMarketUpdate. All are permissionless.',
  );
  contests.addCommand(contestCreateCommand);
  contests.addCommand(contestScoreCommand);
  contests.addCommand(contestUpdateMarketsCommand);
  contests.addCommand(contestShowCommand);
  contests.addCommand(contestListCommand);
  contests.addCommand(contestWaitVerifiedCommand);
  return contests;
}
