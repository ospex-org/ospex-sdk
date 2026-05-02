/**
 * KeystoreSigner — implements the `Signer` interface backed by a
 * standard JSON keystore v3 file. Encryption / decryption uses ethers
 * v6's keystore primitives (the spec explicitly approves ethers as a
 * bundled dep for this purpose); signing operations use viem so the
 * rest of the SDK can stay on a single chain library.
 *
 * Two construction paths:
 *
 *   - `KeystoreSigner.unlock(keystoreJson, passphrase)` — decrypts a
 *     keystore JSON string and returns a ready-to-use signer.
 *   - `KeystoreSigner.fromPrivateKey(privateKey)` — direct construction
 *     from a raw key (for tests, or for session-cached unlocked keys
 *     where the CLI has already paid the scrypt cost once).
 *
 * Plus the `encrypt` static helper for `ospex wallet import`, which
 * encrypts a freshly-imported private key into a keystore JSON.
 */

import { decryptKeystoreJson, encryptKeystoreJson } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import type {
  Hex,
  Signer,
  SignTransactionArgs,
  SignTypedDataArgs,
} from '../types/signer.js';
import { OspexSigningError } from '../errors.js';

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
