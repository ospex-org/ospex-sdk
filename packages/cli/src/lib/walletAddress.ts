/**
 * Shared "give me the configured wallet's address, cheaply if possible"
 * helper. Used by `ospex approvals show` and the upcoming `ospex doctor`
 * — both want to look up on-chain state for the user's address but
 * shouldn't trigger a Foundry-keystore passphrase prompt unless the
 * keystore can't yield the address any other way.
 *
 * Resolution order:
 *   1. `--address` override (caller passes it in pre-resolved). Returned
 *      as-is, no keystore touch.
 *   2. Top-level `address` field in the keystore JSON (legacy `ospex
 *      wallet import` path).
 *   3. Active `~/.ospex/session` cache (if `ospex wallet unlock` was
 *      run within the last 15 min). Reuses the cached private key.
 *   4. Prompt for the keystore passphrase and decrypt.
 */

import { promises as fs } from 'node:fs';
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';
import { readSession } from './client.js';
import { getKeystorePath, isFileNotFound } from './config.js';
import { getKeystoreAddressIfPresent } from './keystore.js';
import { promptHidden } from './prompt.js';

export type Hex = `0x${string}`;

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidAddress(input: string): input is Hex {
  return HEX_ADDRESS_RE.test(input);
}

/**
 * Resolve the wallet address to use for read-only allowance / balance
 * lookups. Prefers cheap paths (config-supplied override, in-keystore
 * field, session cache) so the common case doesn't prompt.
 */
export async function resolveWalletAddress(
  override: string | undefined,
): Promise<Hex> {
  if (override !== undefined) {
    if (!isValidAddress(override)) {
      throw new Error(
        `--address must be a 0x-prefixed 20-byte hex address, got "${override}".`,
      );
    }
    return override.toLowerCase() as Hex;
  }

  const file = await getKeystorePath();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) {
      throw new Error(
        `No keystore at ${file}. Either run \`ospex init\` and supply a ` +
          'Foundry keystore path when prompted, or pass --address <0x…> ' +
          'to look up allowances for any wallet.',
      );
    }
    throw err;
  }

  const fromFile = getKeystoreAddressIfPresent(raw);
  if (fromFile !== null && isValidAddress(fromFile)) {
    return fromFile.toLowerCase() as Hex;
  }

  const session = await readSession();
  if (session && isValidAddress(session.address)) {
    return session.address.toLowerCase() as Hex;
  }

  const passphrase = await promptHidden('Keystore passphrase: ');
  const signer = await KeystoreSigner.unlock(raw, passphrase);
  const addr = await signer.getAddress();
  return addr.toLowerCase() as Hex;
}
