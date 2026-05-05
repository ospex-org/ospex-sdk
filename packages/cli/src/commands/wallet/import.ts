import { promises as fs } from 'node:fs';
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';
import { getKeystorePath, getOspexHome, isFileNotFound } from '../../lib/config.js';
import { promptHidden, promptPassphraseConfirmed } from '../../lib/prompt.js';
import { secureMkdirP, secureWriteFile } from '../../lib/secure-fs.js';

const optionsSchema = z.object({
  force: z.boolean().optional(),
});

const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;

export const walletImportCommand = new Command('import')
  .description('Encrypt a private key into ~/.ospex/keystore.json.')
  .option('--force', 'overwrite an existing keystore')
  .action(async (opts) => {
    const parsed = optionsSchema.parse(opts);
    const file = await getKeystorePath();

    if (!parsed.force) {
      try {
        await fs.access(file);
        console.error(
          `Keystore already exists at ${file}. Use --force to overwrite.`,
        );
        process.exit(1);
      } catch (err) {
        if (!isFileNotFound(err)) throw err;
      }
    }

    const rawPk =
      process.env.OSPEX_IMPORT_PRIVATE_KEY ??
      (await promptHidden('Private key (0x…64 hex chars): '));
    const privateKey = rawPk.trim().startsWith('0x') ? rawPk.trim() : `0x${rawPk.trim()}`;
    if (!PRIVATE_KEY_REGEX.test(privateKey)) {
      console.error('Invalid private key. Expected 0x-prefixed 64 hex characters.');
      process.exit(1);
    }

    const passphrase = await promptPassphraseConfirmed();

    const json = await KeystoreSigner.encrypt(privateKey as `0x${string}`, passphrase);
    await secureMkdirP(getOspexHome());
    await secureWriteFile(file, json + '\n');

    const signer = await KeystoreSigner.unlock(json, passphrase);
    const address = await signer.getAddress();
    console.log(`Imported wallet ${address} → ${file}`);
  });
