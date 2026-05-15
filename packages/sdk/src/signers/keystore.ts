/**
 * KeystoreSigner — implements the `Signer` interface backed by a
 * standard JSON keystore v3 file. Encryption / decryption uses ethers
 * v6's keystore primitives (the spec explicitly approves ethers as a
 * bundled dep for this purpose); signing operations use viem so the
 * rest of the SDK can stay on a single chain library.
 *
 * Construction paths:
 *
 *   - `KeystoreSigner.unlock(keystoreJson, passphrase)` — decrypts a
 *     keystore JSON string and returns a ready-to-use signer. Pure
 *     in-memory; the caller has already done any required I/O.
 *
 *   - `KeystoreSigner.fromKeystoreFile({ keystorePath, ... })` —
 *     non-interactive helper that reads the keystore file, reads the
 *     passphrase (file / stdin / literal / env), decrypts, and
 *     optionally verifies an expected address. Agent-friendly entry
 *     point.
 *
 *   - `KeystoreSigner.fromFoundryAccount({ account, ... })` — same as
 *     `fromKeystoreFile` but resolves the keystore path from a Foundry
 *     account name under `~/.foundry/keystores/` (or
 *     `$FOUNDRY_DIR/keystores`, or
 *     `$OSPEX_FOUNDRY_KEYSTORES_DIR`).
 *
 *   - `KeystoreSigner.fromPrivateKey(privateKey)` — direct construction
 *     from a raw key (for tests, or for session-cached unlocked keys
 *     where the CLI has already paid the scrypt cost once).
 *
 * Plus the `encrypt` static helper for `ospex wallet import`, which
 * encrypts a freshly-imported private key into a keystore JSON.
 *
 * The decrypted private key never leaves this class. The `Foundry`
 * helpers below take file/stdin/env input, sequence the reads, and
 * delegate to `unlock` — no decrypted material crosses a function
 * boundary outside this file.
 */

import { promises as fs } from 'node:fs';
import { decryptKeystoreJson, encryptKeystoreJson } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import type {
  Hex,
  Signer,
  SignTransactionArgs,
  SignTypedDataArgs,
} from '../types/signer.js';
import { OspexSignerResolutionError, OspexSigningError } from '../errors.js';
import {
  checkPasswordFilePermissions,
  readPassphrase,
  resolveKeystoreSource,
  type ReadPassphraseArgs,
} from './foundry.js';

// Re-export the Foundry resolver / passphrase helpers from this subpath
// so consumers only need one import path for the whole signer surface.
export {
  resolveKeystoreSource,
  readPassphrase,
  checkPasswordFilePermissions,
} from './foundry.js';
export type {
  KeystoreSource,
  ResolveKeystoreSourceArgs,
  PassphraseSource,
  ReadPassphraseArgs,
  PermissionCheckResult,
  OspexEnv,
} from './foundry.js';

export class KeystoreSigner implements Signer {
  private readonly account: PrivateKeyAccount;

  private constructor(privateKey: Hex) {
    try {
      this.account = privateKeyToAccount(privateKey);
    } catch (err) {
      throw new OspexSigningError('Invalid private key for KeystoreSigner', { cause: err });
    }
  }

  /** Decrypt a keystore JSON v3 file and return an unlocked signer. */
  static async unlock(keystoreJson: string, passphrase: string): Promise<KeystoreSigner> {
    let privateKey: string;
    try {
      const account = await decryptKeystoreJson(keystoreJson, passphrase);
      privateKey = account.privateKey;
    } catch (err) {
      throw new OspexSigningError('Failed to decrypt keystore', { cause: err });
    }
    return new KeystoreSigner(ensureHex(privateKey));
  }

  /**
   * Direct construction from a raw private key. Used by the CLI when
   * loading from a session-cached unlocked key, and by tests.
   */
  static fromPrivateKey(privateKey: Hex): KeystoreSigner {
    return new KeystoreSigner(privateKey);
  }

  /**
   * Non-interactive construction from a v3 keystore file plus a
   * passphrase source. Reads the keystore, reads the passphrase from
   * whichever source is supplied (`passwordFile` / `fromStdin` /
   * `passphrase` literal / `OSPEX_PASSWORD_FILE` env), decrypts in
   * memory, and optionally verifies the unlocked address matches
   * `expectedAddress`.
   *
   * Throws `OspexSignerResolutionError` with a stable `reason` code:
   *   - `keystore_not_found`
   *   - `password_file_not_found`
   *   - `non_interactive_password_required`
   *   - `password_source_conflict`
   *   - `decryption_failed`
   *   - `address_mismatch`
   *   - `password_file_permissions_loose` (only when `strict: true`)
   */
  static async fromKeystoreFile(args: FromKeystoreFileArgs): Promise<KeystoreSigner> {
    const source = await resolveKeystoreSource({
      keystorePath: args.keystorePath,
      ...(args.env !== undefined ? { env: args.env } : {}),
    });
    return fromResolvedSource(source, args, args);
  }

  /**
   * Non-interactive construction from a Foundry account name. Resolves
   * the keystore path under `~/.foundry/keystores/<account>` (or
   * `$FOUNDRY_DIR/keystores/<account>`, or
   * `$OSPEX_FOUNDRY_KEYSTORES_DIR/<account>`, with `foundryKeystoresDir`
   * as an explicit override), then proceeds exactly as
   * `fromKeystoreFile`.
   *
   * Throws the same `OspexSignerResolutionError` reason codes as
   * `fromKeystoreFile`. `keystore_not_found` includes the resolved
   * path in `error.path`.
   */
  static async fromFoundryAccount(args: FromFoundryAccountArgs): Promise<KeystoreSigner> {
    const source = await resolveKeystoreSource({
      account: args.account,
      ...(args.foundryKeystoresDir !== undefined
        ? { foundryKeystoresDir: args.foundryKeystoresDir }
        : {}),
      ...(args.env !== undefined ? { env: args.env } : {}),
    });
    return fromResolvedSource(source, args, args);
  }

  /**
   * Encrypt a private key into a keystore JSON v3 string. The
   * scrypt parameters are ethers' defaults (n=131_072, r=8, p=1) —
   * adequate for a per-user wallet.
   */
  static async encrypt(privateKey: Hex, passphrase: string): Promise<string> {
    const account = privateKeyToAccount(privateKey);
    try {
      return await encryptKeystoreJson(
        { address: account.address, privateKey },
        passphrase,
      );
    } catch (err) {
      throw new OspexSigningError('Failed to encrypt keystore', { cause: err });
    }
  }

  async getAddress(): Promise<Hex> {
    return this.account.address;
  }

  async signTypedData(args: SignTypedDataArgs): Promise<Hex> {
    try {
      // viem's signTypedData type expects a `types` map plus a
      // primaryType; the EIP712Domain entry is auto-injected.
      return await this.account.signTypedData({
        domain: args.domain,
        types: args.types,
        primaryType: args.primaryType,
        message: args.message,
      } as Parameters<PrivateKeyAccount['signTypedData']>[0]);
    } catch (err) {
      throw new OspexSigningError('signTypedData failed', { cause: err });
    }
  }

  async signTransaction(tx: SignTransactionArgs): Promise<Hex> {
    try {
      const serializable = toViemTransactionSerializable(tx);
      return await this.account.signTransaction(
        serializable as Parameters<PrivateKeyAccount['signTransaction']>[0],
      );
    } catch (err) {
      throw new OspexSigningError('signTransaction failed', { cause: err });
    }
  }
}

// ── Foundry-helper argument shapes ─────────────────────────────────

/**
 * Shared options for `fromKeystoreFile` / `fromFoundryAccount`.
 * Passphrase-source fields mirror `ReadPassphraseArgs`; the helpers
 * forward them to `readPassphrase`.
 */
interface FromKeystoreCommonArgs extends ReadPassphraseArgs {
  /**
   * When set, the unlocked address must match this value (case-
   * insensitively). Throws `OspexSignerResolutionError({ reason:
   * 'address_mismatch' })` on mismatch — agent guardrail against
   * accidentally signing with the wrong wallet.
   */
  expectedAddress?: Hex;
  /**
   * When `true`, treat a group/other-readable password file as a hard
   * failure (`password_file_permissions_loose`) instead of returning
   * the unlocked signer. Default `false`. Used by
   * `ospex auth check --strict` and CI flows.
   */
  strict?: boolean;
}

export interface FromKeystoreFileArgs extends FromKeystoreCommonArgs {
  /** Absolute path to a v3 keystore JSON. */
  keystorePath: string;
}

export interface FromFoundryAccountArgs extends FromKeystoreCommonArgs {
  /**
   * Foundry account name (the file name under the keystores
   * directory). Resolves to `<foundryKeystoresDir>/<account>`.
   */
  account: string;
  /**
   * Override the Foundry keystores directory. Default precedence
   * (high to low): this option, `OSPEX_FOUNDRY_KEYSTORES_DIR`,
   * `$FOUNDRY_DIR/keystores`, `~/.foundry/keystores`.
   */
  foundryKeystoresDir?: string;
}

/**
 * Shared finish-line logic for both `fromKeystoreFile` and
 * `fromFoundryAccount`: read the keystore JSON, read the passphrase,
 * apply optional strict permission check, decrypt, verify expected
 * address. Module-level so it can capture the `KeystoreSigner.unlock`
 * call without accessing private constructor state.
 */
async function fromResolvedSource(
  source: { keystorePath: string },
  passphraseArgs: ReadPassphraseArgs,
  options: { expectedAddress?: Hex; strict?: boolean },
): Promise<KeystoreSigner> {
  // 1. Read the keystore JSON file. ENOENT shouldn't happen here
  //    (resolveKeystoreSource already checked) but other I/O errors
  //    can — surface them with the path attached.
  let keystoreJson: string;
  try {
    keystoreJson = await fs.readFile(source.keystorePath, 'utf8');
  } catch (err) {
    throw new OspexSignerResolutionError(
      `Failed to read keystore at ${source.keystorePath}.`,
      { reason: 'keystore_not_found', path: source.keystorePath, cause: err },
    );
  }

  // 2. Read the passphrase from whichever source the caller supplied.
  const passSource = await readPassphrase(passphraseArgs);

  // 3. Strict mode: refuse to proceed if the password file's POSIX
  //    permissions are loose. Only applies when the passphrase came
  //    from a file (literal / stdin / env-from-file all skip this).
  if (options.strict === true && passSource.filePath !== undefined) {
    const perms = await checkPasswordFilePermissions(passSource.filePath);
    if (perms.loose) {
      throw new OspexSignerResolutionError(
        `Password file ${passSource.filePath} is readable by group/other ` +
          `(mode 0${perms.mode.toString(8)}). Tighten with \`chmod 600 <file>\`.`,
        {
          reason: 'password_file_permissions_loose',
          path: passSource.filePath,
          mode: perms.mode,
        },
      );
    }
  }

  // 4. Decrypt. `unlock` throws OspexSigningError on a bad
  //    passphrase / malformed keystore. Wrap as the typed
  //    signer-resolution error so agents only have to switch on
  //    one error class for the whole non-interactive flow.
  let signer: KeystoreSigner;
  try {
    signer = await KeystoreSigner.unlock(keystoreJson, passSource.passphrase);
  } catch (err) {
    if (err instanceof OspexSigningError) {
      throw new OspexSignerResolutionError(
        `Failed to decrypt keystore at ${source.keystorePath}. ` +
          `Verify the passphrase source matches the account.`,
        { reason: 'decryption_failed', path: source.keystorePath, cause: err },
      );
    }
    throw err;
  }

  // 5. Address pin / guardrail. Compare lowercase for tolerance to
  //    checksum-vs-lower differences in how the user typed the
  //    expected value.
  if (options.expectedAddress !== undefined) {
    const actual = (await signer.getAddress()).toLowerCase();
    const expected = options.expectedAddress.toLowerCase();
    if (actual !== expected) {
      throw new OspexSignerResolutionError(
        `Keystore at ${source.keystorePath} unlocks to ${actual} ` +
          `but expectedAddress is ${expected}.`,
        {
          reason: 'address_mismatch',
          path: source.keystorePath,
          expectedAddress: options.expectedAddress,
          actualAddress: actual,
        },
      );
    }
  }

  return signer;
}

function toViemTransactionSerializable(tx: SignTransactionArgs): Record<string, unknown> {
  // Default to EIP-1559 unless the caller explicitly opts into legacy/2930.
  const type = tx.type ?? 'eip1559';
  const out: Record<string, unknown> = { chainId: tx.chainId };
  if (tx.to !== undefined) out.to = tx.to;
  if (tx.data !== undefined) out.data = tx.data;
  if (tx.value !== undefined) out.value = tx.value;
  if (tx.gas !== undefined) out.gas = tx.gas;
  if (tx.nonce !== undefined) out.nonce = tx.nonce;

  if (type === 'eip1559') {
    out.type = 'eip1559';
    if (tx.maxFeePerGas !== undefined) out.maxFeePerGas = tx.maxFeePerGas;
    if (tx.maxPriorityFeePerGas !== undefined) {
      out.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
    }
  } else if (type === 'legacy') {
    out.type = 'legacy';
    if (tx.gasPrice !== undefined) out.gasPrice = tx.gasPrice;
  } else {
    out.type = 'eip2930';
    if (tx.gasPrice !== undefined) out.gasPrice = tx.gasPrice;
  }
  return out;
}

function ensureHex(value: string): Hex {
  if (!value.startsWith('0x')) return `0x${value}` as Hex;
  return value as Hex;
}
