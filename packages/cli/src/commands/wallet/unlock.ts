import { promises as fs } from 'node:fs';
import { Command } from '@commander-js/extra-typings';
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';
import { getKeystorePath, isFileNotFound } from '../../lib/config.js';
import { writeSession } from '../../lib/client.js';
import { promptHidden } from '../../lib/prompt.js';

export const walletUnlockCommand = new Command('unlock')
  .description('Decrypt the keystore and cache for 15 minutes.')
  .action(async () => {
    const file = getKeystorePath();
    let json: string;
    try {
      json = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (isFileNotFound(err)) {
        console.error(`No keystore at ${file}. Run \`ospex wallet import\` first.`);
        process.exit(1);
      }
      throw err;
    }

    const passphrase = await promptHidden('Keystore passphrase: ');
    const signer = await KeystoreSigner.unlock(json, passphrase);
    const address = await signer.getAddress();

    // Recover the decrypted private key for the session cache. We hold
    // it in a closure inside KeystoreSigner; rather than expose it, we
    // re-decrypt directly via ethers. This keeps the SDK's Signer
    // surface clean (private keys never leak through the abstraction).
    const { decryptKeystoreJson } = await import('ethers');
    const account = await decryptKeystoreJson(json, passphrase);
    await writeSession(address, account.privateKey);

    console.log(`Unlocked ${address}. Session valid for 15 minutes.`);
  });
