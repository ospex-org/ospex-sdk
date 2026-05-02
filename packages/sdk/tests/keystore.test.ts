/**
 * KeystoreSigner roundtrip tests. We use a deterministic well-known
 * test private key (Anvil's #0) so we never have to touch user-side
 * key material, and we keep encrypt-side scrypt cost bounded by
 * encrypting once per file.
 *
 * - Typed-data: sign with the keystore signer, verify with viem's
 *   verifyTypedData (which reproduces the EIP-712 hash + ecrecover).
 * - Transaction: sign with the keystore signer, parse the serialized
 *   transaction with viem, and ecrecover from the unsigned hash.
 * - Encrypt/unlock roundtrip: prove the public encrypt() helper and
 *   unlock() agree.
 */

import { describe, expect, it } from 'vitest';
import {
  keccak256,
  parseTransaction,
  recoverAddress,
  serializeTransaction,
  verifyTypedData,
} from 'viem';
import { encryptKeystoreJson } from 'ethers';
import { KeystoreSigner } from '../src/signers/keystore.js';

// Anvil account #0 — well-known, never used for anything real.
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const PASSPHRASE = 'test-passphrase-1234';

const TYPED_DATA = {
  domain: {
    name: 'Ospex',
    version: '1',
    chainId: 137,
    verifyingContract: '0x1B93579B044f0eE3c4C8a9F479A323DeF7770712' as `0x${string}`,
  },
  types: {
    OspexCommitment: [
      { name: 'maker', type: 'address' },
      { name: 'contestId', type: 'uint256' },
      { name: 'scorer', type: 'address' },
      { name: 'lineTicks', type: 'int32' },
      { name: 'positionType', type: 'uint8' },
      { name: 'oddsTick', type: 'uint16' },
      { name: 'riskAmount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'expiry', type: 'uint256' },
    ],
  },
  primaryType: 'OspexCommitment' as const,
  message: {
    maker: TEST_ADDRESS,
    contestId: 42n,
    scorer: '0xd846B7FdbD8C9F67d1580B2C6a8Bd7Fdcb15390b' as `0x${string}`,
    lineTicks: -35,
    positionType: 0,
    oddsTick: 220,
    riskAmount: 10_000_000n,
    nonce: 1730000000n,
    expiry: 1735000000n,
  },
};

describe('KeystoreSigner — typed data', () => {
  it('signs an EIP-712 commitment that recovers to the signer address', async () => {
    const signer = KeystoreSigner.fromPrivateKey(TEST_PK);
    const address = await signer.getAddress();
    expect(address.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());

    const signature = await signer.signTypedData({
      domain: TYPED_DATA.domain,
      types: TYPED_DATA.types,
      primaryType: TYPED_DATA.primaryType,
      message: TYPED_DATA.message,
    });
    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/);

    const valid = await verifyTypedData({
      address,
      domain: TYPED_DATA.domain,
      types: TYPED_DATA.types,
      primaryType: TYPED_DATA.primaryType,
      message: TYPED_DATA.message,
      signature,
    });
    expect(valid).toBe(true);
  });
});

describe('KeystoreSigner — transactions', () => {
  it('signs a 1559 transaction whose signature recovers to the signer address', async () => {
    const signer = KeystoreSigner.fromPrivateKey(TEST_PK);
    const address = await signer.getAddress();

    const tx = {
      to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
      value: 1_000n,
      gas: 21_000n,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_500_000_000n,
      nonce: 7,
      chainId: 137,
      type: 'eip1559' as const,
    };
    const serialized = await signer.signTransaction(tx);
    expect(serialized).toMatch(/^0x[0-9a-fA-F]+$/);

    // Parse the signed serialization to extract r, s, yParity. Then
    // hash the unsigned form and recover.
    const parsed = parseTransaction(serialized);
    expect(parsed.r).toBeTruthy();
    expect(parsed.s).toBeTruthy();

    const unsignedSerialized = serializeTransaction({
      to: tx.to,
      value: tx.value,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce: tx.nonce,
      chainId: tx.chainId,
      type: 'eip1559',
    });
    const hash = keccak256(unsignedSerialized);
    const recovered = await recoverAddress({
      hash,
      signature: {
        r: parsed.r as `0x${string}`,
        s: parsed.s as `0x${string}`,
        yParity: parsed.yParity ?? 0,
      },
    });
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());
  });
});

describe('KeystoreSigner — encrypt/unlock roundtrip', () => {
  it(
    'encrypts a private key and unlocks it back to the same address',
    async () => {
      // Use ethers directly with relaxed scrypt N to keep this test fast.
      // The on-disk keystore in real usage uses ethers' default (N=131072),
      // which is also covered transitively by KeystoreSigner.encrypt — we
      // do that as a slower secondary assertion below.
      const account = { address: TEST_ADDRESS, privateKey: TEST_PK };
      const fastJson = await encryptKeystoreJson(account, PASSPHRASE, {
        scrypt: { N: 1024 },
      });
      const signer = await KeystoreSigner.unlock(fastJson, PASSPHRASE);
      const address = await signer.getAddress();
      expect(address.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    },
    15_000,
  );

  it(
    'public KeystoreSigner.encrypt produces a JSON unlock can decrypt',
    async () => {
      const json = await KeystoreSigner.encrypt(TEST_PK, PASSPHRASE);
      const signer = await KeystoreSigner.unlock(json, PASSPHRASE);
      const address = await signer.getAddress();
      expect(address.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    },
    60_000,
  );

  it('unlock with the wrong passphrase throws OspexSigningError', async () => {
    const account = { address: TEST_ADDRESS, privateKey: TEST_PK };
    const json = await encryptKeystoreJson(account, PASSPHRASE, { scrypt: { N: 1024 } });
    await expect(KeystoreSigner.unlock(json, 'wrong-passphrase')).rejects.toMatchObject({
      code: 'SIGNING_ERROR',
    });
  }, 15_000);
});
