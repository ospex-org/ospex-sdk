import { Command } from '@commander-js/extra-typings';
import { deleteSession } from '../../lib/client.js';

export const walletLockCommand = new Command('lock')
  .description('Delete the cached unlocked-key session.')
  .action(async () => {
    await deleteSession();
    console.log('Session cleared.');
  });
