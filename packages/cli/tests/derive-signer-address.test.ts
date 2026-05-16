/**
 * Hermes PR 55 review regression test.
 *
 * The doctor was deriving `wallet.address` through the legacy
 * `resolveWalletAddress(...)` path, which only consults
 * `getKeystorePath()` and never sees a config-pinned
 * `foundryAccount` / `passwordFile` / `expectedAddress`. Result: with
 * the SAME config that let `auth check --json` unlock cleanly,
 * `doctor --json` reported `wallet.address: null` and
 * `signer.address_known: fail`.
 *
 * PR 4 fix adds `deriveSignerAddress` in `lib/authResolution.ts` —
 * a walker-aware derivation that respects the same provenance
 * `auth check` already reports. These tests cover the paths that
 * mattered for the repro: --address override, expected-address pin,
 * non-interactive unlock via Foundry account, and the no-prompt
 * failure mode.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptKeystoreJson } from 'ethers';
import {
  deriveSignerAddress,
  type AuthSourceResolution,
} from '../src/lib/authResolution.js';
import { WalletAddressUnresolvedError } from '../src/lib/walletAddress.js';

const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as const; // lowercased
const PINNED_ADDRESS = '0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34' as const;
const PASSPHRASE = 'derive-test-passphrase';

let keystoreJson: string;
let foundryStyleKeystoreJson: string;

beforeAll(async () => {
  keystoreJson = await encryptKeystoreJson(
    { address: TEST_ADDRESS, privateKey: TEST_PK },
    PASSPHRASE,
  );
  // Foundry-produced keystores omit the top-level `address` field
  // that ethers writes. Strip it so the in-keystore-field cheap
  // path returns null and the test forces the unlock branch — which
  // is the path that fixes Hermes's PR 55 blocker.
  const parsed = JSON.parse(keystoreJson) as Record<string, unknown>;
  delete parsed['address'];
  foundryStyleKeystoreJson = JSON.stringify(parsed);
}, 30_000);

let tmpDir: string;
const savedHome = process.env.OSPEX_HOME;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-derive-'));
  // Point OSPEX_HOME at the tmp dir so any stale session cache from
  // the real user environment doesn't leak into the test.
  process.env.OSPEX_HOME = tmpDir;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.OSPEX_HOME;
  else process.env.OSPEX_HOME = savedHome;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Build a walker resolution that mirrors what `resolveAuthSources`
 *  would emit for a given on-disk setup. The doctor passes the real
 *  walker output; these fixtures pass equivalent synthetic data. */
function makeResolution(over: Partial<AuthSourceResolution>): AuthSourceResolution {
  return {
    keystore: {
      provenance: 'default-legacy',
      path: '/nonexistent/keystore.json',
      account: null,
      exists: false,
      ...over.keystore,
    },
    password: {
      provenance: 'none',
      path: null,
      exists: null,
      ...over.password,
    },
    expectedAddress: {
      provenance: 'none',
      value: null,
      ...over.expectedAddress,
    },
    foundryKeystoresDir: {
      provenance: 'default',
      value: '/home/agent/.foundry/keystores',
      ...over.foundryKeystoresDir,
    },
  };
}

describe('deriveSignerAddress — --address override', () => {
  it('returns the override lowercased without touching the keystore', async () => {
    const r = await deriveSignerAddress({
      override: '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd',
      resolution: makeResolution({}),
      noPrompt: true,
    });
    expect(r.address).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(r.source).toBe('flag-address');
  });

  it('rejects a malformed --address', async () => {
    await expect(
      deriveSignerAddress({
        override: 'not-an-address',
        resolution: makeResolution({}),
        noPrompt: true,
      }),
    ).rejects.toThrow(/must be a 0x-prefixed/);
  });
});

describe('deriveSignerAddress — expected-address pin (Hermes PR 55 trigger condition)', () => {
  it('returns the pin when no credentials are available (zero I/O)', async () => {
    const r = await deriveSignerAddress({
      override: undefined,
      resolution: makeResolution({
        // Pin set via `auth use-foundry` — the typical pinned setup.
        expectedAddress: { provenance: 'config', value: PINNED_ADDRESS },
      }),
      noPrompt: true,
    });
    expect(r.address).toBe(PINNED_ADDRESS);
    expect(r.source).toBe('expected-address-pin');
  });
});

describe('deriveSignerAddress — non-interactive unlock via Foundry account', () => {
  it('unlocks the keystore via a password file and returns the derived address', async () => {
    // Construct the on-disk setup that mirrors Hermes's repro:
    // a Foundry-account keystore + a password file + an
    // expectedAddress pin.
    const keystoresDir = path.join(tmpDir, 'foundry-keystores');
    const accountName = 'maker-a';
    await fs.mkdir(keystoresDir, { recursive: true });
    const keystorePath = path.join(keystoresDir, accountName);
    await fs.writeFile(keystorePath, foundryStyleKeystoreJson, 'utf8');

    const pwPath = path.join(tmpDir, 'maker-a.pass');
    await fs.writeFile(pwPath, PASSPHRASE, 'utf8');
    if (process.platform !== 'win32') await fs.chmod(pwPath, 0o600);

    const r = await deriveSignerAddress({
      override: undefined,
      resolution: makeResolution({
        keystore: {
          provenance: 'config-foundryAccount',
          path: keystorePath,
          account: accountName,
          exists: true,
        },
        password: {
          provenance: 'config-passwordFile',
          path: pwPath,
          exists: true,
        },
        expectedAddress: { provenance: 'config', value: TEST_ADDRESS },
        foundryKeystoresDir: { provenance: 'default', value: keystoresDir },
      }),
      noPrompt: true,
    });

    expect(r.address).toBe(TEST_ADDRESS);
    expect(r.source).toBe('non-interactive-unlock');
  }, 30_000);

  it('falls back to the pin when unlock fails (e.g. wrong password)', async () => {
    const keystoresDir = path.join(tmpDir, 'foundry-keystores');
    const accountName = 'maker-a';
    await fs.mkdir(keystoresDir, { recursive: true });
    const keystorePath = path.join(keystoresDir, accountName);
    await fs.writeFile(keystorePath, keystoreJson, 'utf8');

    const wrongPwPath = path.join(tmpDir, 'wrong.pass');
    await fs.writeFile(wrongPwPath, 'WRONG-PASSPHRASE', 'utf8');
    if (process.platform !== 'win32') await fs.chmod(wrongPwPath, 0o600);

    // Need the path used by the second test to match a freshly-
    // re-written Foundry-style keystore (the prior subtest above
    // wrote one too, but each test has its own tmpDir).
    await fs.writeFile(keystorePath, foundryStyleKeystoreJson, 'utf8');

    const r = await deriveSignerAddress({
      override: undefined,
      resolution: makeResolution({
        keystore: {
          provenance: 'config-foundryAccount',
          path: keystorePath,
          account: accountName,
          exists: true,
        },
        password: {
          provenance: 'config-passwordFile',
          path: wrongPwPath,
          exists: true,
        },
        expectedAddress: { provenance: 'config', value: PINNED_ADDRESS },
        foundryKeystoresDir: { provenance: 'default', value: keystoresDir },
      }),
      noPrompt: true,
    });

    // Unlock failed → fall through to the pin.
    expect(r.address).toBe(PINNED_ADDRESS);
    expect(r.source).toBe('expected-address-pin');
  }, 30_000);
});

describe('deriveSignerAddress — no-prompt failure modes', () => {
  it('throws keystore_not_found when keystore does not exist and no pin/session', async () => {
    let caught: unknown;
    try {
      await deriveSignerAddress({
        override: undefined,
        resolution: makeResolution({}),
        noPrompt: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WalletAddressUnresolvedError);
    expect((caught as WalletAddressUnresolvedError).reason).toBe('keystore_not_found');
  });

  it('throws password_source_missing when keystore exists but no creds/pin and noPrompt', async () => {
    // Keystore exists but it's a Foundry-style one (no in-keystore
    // address field), no session, no password file, no pin.
    const keystorePath = path.join(tmpDir, 'keystore.json');
    // Write a Foundry-style minimal keystore (no top-level address field).
    await fs.writeFile(
      keystorePath,
      JSON.stringify({
        id: 'placeholder',
        version: 3,
        crypto: {
          cipher: 'aes-128-ctr',
          ciphertext: '00',
          cipherparams: { iv: '00' },
          kdf: 'scrypt',
          kdfparams: { dklen: 32, n: 8, p: 1, r: 8, salt: '00' },
          mac: '00',
        },
      }),
    );

    let caught: unknown;
    try {
      await deriveSignerAddress({
        override: undefined,
        resolution: makeResolution({
          keystore: {
            provenance: 'config-foundryAccount',
            path: keystorePath,
            account: 'maker-a',
            exists: true,
          },
        }),
        noPrompt: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WalletAddressUnresolvedError);
    expect((caught as WalletAddressUnresolvedError).reason).toBe(
      'password_source_missing',
    );
  });
});

describe('deriveSignerAddress — in-keystore address field (legacy ethers)', () => {
  it('reads the top-level address from an ethers-style keystore', async () => {
    // An ethers-encrypted v3 keystore carries the address at the
    // top level — `getKeystoreAddressIfPresent` finds it without
    // ever decrypting.
    const keystorePath = path.join(tmpDir, 'keystore.json');
    await fs.writeFile(keystorePath, keystoreJson, 'utf8');

    const r = await deriveSignerAddress({
      override: undefined,
      resolution: makeResolution({
        keystore: {
          provenance: 'default-legacy',
          path: keystorePath,
          account: null,
          exists: true,
        },
      }),
      noPrompt: true,
    });
    expect(r.address).toBe(TEST_ADDRESS);
    expect(r.source).toBe('keystore-field');
  });
});
