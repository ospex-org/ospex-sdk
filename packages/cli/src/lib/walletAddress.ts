/**
 * Shared "give me the configured wallet's address, cheaply if possible"
 * helper. Used by `ospex approvals show` and `ospex doctor` — both want
 * to look up on-chain state for the user's address but shouldn't
 * trigger a Foundry-keystore passphrase prompt unless the keystore
 * can't yield the address any other way.
 *
 * Resolution order:
 *   1. `--address` override (caller passes it in pre-resolved). Returned
 *      as-is, no keystore touch.
 *   2. Top-level `address` field in the keystore JSON (legacy `ospex
 *      wallet import` path).
 *   3. Active `~/.ospex/session` cache (if `ospex wallet unlock` was
 *      run within the last 15 min). Reuses the cached private key.
 *   4. Prompt for the keystore passphrase and decrypt.
 *
 * Step 4 is suppressed under `noPrompt: true` — used by `ospex doctor
 * --json` / non-TTY mode to honor the no-prompt guarantee. Throws
 * `WalletAddressUnresolvedError` instead, which the doctor catches and
 * converts to a structured `signer.address_known: fail` check.
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
 * Reasons the no-prompt path can't resolve an address. Stable enum the
 * doctor's `signer.address_known` check switches on (currently only
 * one value, but additive — future PRs may distinguish "no keystore on
 * disk at all" from "keystore exists but needs a passphrase").
 */
export type WalletAddressUnresolvedReason =
  | 'keystore_not_found'
  | 'password_source_missing';

export class WalletAddressUnresolvedError extends Error {
  readonly reason: WalletAddressUnresolvedReason;
  constructor(reason: WalletAddressUnresolvedReason, message: string) {
    super(message);
    this.name = 'WalletAddressUnresolvedError';
    this.reason = reason;
  }
}

export interface ResolveWalletAddressOptions {
  /**
   * When true, never prompt for a passphrase. If steps 1-3 fail to
   * yield an address, throws `WalletAddressUnresolvedError` rather
   * than reading hidden input. The doctor sets this in `--json` /
   * non-TTY mode.
   */
  noPrompt?: boolean;
}

/**
 * Resolve the wallet address to use for read-only allowance / balance
 * lookups. Prefers cheap paths (config-supplied override, in-keystore
 * field, session cache) so the common case doesn't prompt.
 */
export async function resolveWalletAddress(
  override: string | undefined,
  options: ResolveWalletAddressOptions = {},
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
      if (options.noPrompt === true) {
        throw new WalletAddressUnresolvedError(
          'keystore_not_found',
          `no keystore at ${file}`,
        );
      }
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

  if (options.noPrompt === true) {
    throw new WalletAddressUnresolvedError(
      'password_source_missing',
      'address could not be derived without unlocking the keystore',
    );
  }

  const passphrase = await promptHidden('Keystore passphrase: ');
  const signer = await KeystoreSigner.unlock(raw, passphrase);
  const addr = await signer.getAddress();
  return addr.toLowerCase() as Hex;
}
