import { promises as fs } from 'node:fs';
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';
import { loadSigner } from '../../lib/client.js';
import { getKeystorePath, isFileNotFound } from '../../lib/config.js';
import { getKeystoreAddressIfPresent } from '../../lib/keystore.js';
import { formatOutput } from '../../lib/format.js';
import { promptHidden } from '../../lib/prompt.js';
import {
  addSignerOptions,
  hasExplicitKeystoreSource,
  parseSignerIntent,
} from '../../lib/signer-options.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const walletAddressCommand = addSignerOptions(
  new Command('address')
    .description(
      'Print the keystore address. Foundry-produced keystores omit the field; ' +
        'in that case the passphrase is requested to derive it (or supply ' +
        '--password-file for a non-interactive unlock).',
    )
    .option('--json', 'output as JSON'),
)
  .action(async (rawOpts) => {
    const parsed = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);

    // New flags path: when an explicit keystore source is supplied
    // (--account / --keystore-path / OSPEX_KEYSTORE_PATH), route
    // through `loadSigner` so the agent-friendly --password-file /
    // --password-stdin / OSPEX_PASSWORD_FILE flow works here too.
    if (hasExplicitKeystoreSource(signerIntent)) {
      const signer = await loadSigner(signerIntent);
      formatOutput({ address: await signer.getAddress() }, { json: parsed.json === true });
      return;
    }

    // Legacy path: read the configured keystore directly so users with
    // an ethers-format keystore (top-level `address` field present) get
    // the address without paying for a scrypt decrypt.
    const file = await getKeystorePath();
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (isFileNotFound(err)) {
        console.error(
          `No keystore at ${file}. Run \`ospex init\` and supply a Foundry ` +
            'keystore path when prompted, set OSPEX_KEYSTORE_PATH for a ' +
            'per-shell override, or pass --account/--keystore-path inline. ' +
            'See docs/QUICKSTART.md.',
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
