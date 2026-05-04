import { promises as fs } from 'node:fs';
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';
import { getKeystorePath, isFileNotFound } from '../../lib/config.js';
import { getKeystoreAddressIfPresent } from '../../lib/keystore.js';
import { formatOutput } from '../../lib/format.js';
import { promptHidden } from '../../lib/prompt.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const walletAddressCommand = new Command('address')
  .description(
    'Print the keystore address. Foundry-produced keystores omit the field; ' +
      'in that case the passphrase is requested to derive it.',
  )
  .option('--json', 'output as JSON')
  .action(async (opts) => {
    const parsed = optionsSchema.parse(opts);
    const file = getKeystorePath();
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (isFileNotFound(err)) {
        console.error(
          `No keystore at ${file}. See docs/QUICKSTART.md to set up a Foundry ` +
            'keystore and point Ospex at it via OSPEX_KEYSTORE_PATH.',
        );
        process.exit(1);
      }
      throw err;
    }
    let address = getKeystoreAddressIfPresent(raw);
    if (address === null) {
      const passphrase = await promptHidden('Keystore passphrase: ');
      const signer = await KeystoreSigner.unlock(raw, passphrase);
      address = await signer.getAddress();
    }
    formatOutput({ address }, { json: parsed.json === true });
  });
