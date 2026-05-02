import { promises as fs } from 'node:fs';
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getKeystorePath, isFileNotFound } from '../../lib/config.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const walletAddressCommand = new Command('address')
  .description('Print the keystore address (no decryption needed).')
  .option('--json', 'output as JSON')
  .action(async (opts) => {
    const parsed = optionsSchema.parse(opts);
    const file = getKeystorePath();
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (isFileNotFound(err)) {
        console.error(`No keystore at ${file}. Run \`ospex wallet import\` first.`);
        process.exit(1);
      }
      throw err;
    }
    const parsedJson = JSON.parse(raw) as { address?: string };
    const address = parsedJson.address;
    if (typeof address !== 'string') {
      console.error('Keystore is missing an address field.');
      process.exit(1);
    }
    const checksummed = address.startsWith('0x') ? address : `0x${address}`;
    formatOutput({ address: checksummed }, { json: parsed.json === true });
  });
