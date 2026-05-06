import { Command } from '@commander-js/extra-typings';
import { gamesListCommand } from './list.js';

export const gamesCommand: Command = new Command('games')
  .description('Browse upcoming games available for contest creation.')
  .addCommand(gamesListCommand);
