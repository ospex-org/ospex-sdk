/**
 * Composes the `ospex speculations *` command group. Reads only —
 * no chain writes (speculation creation happens implicitly via
 * commitment matching, not as an operator action).
 */
import { Command } from '@commander-js/extra-typings';
import { speculationsListCommand } from './list.js';
import { speculationsShowCommand } from './show.js';

export function makeSpeculationsCommand(): Command {
  const speculations = new Command('speculations').description('Read speculations (the on-chain bettable lines on contests).');
  speculations.addCommand(speculationsListCommand);
  speculations.addCommand(speculationsShowCommand);
  return speculations;
}
