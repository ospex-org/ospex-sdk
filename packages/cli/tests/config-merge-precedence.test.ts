/**
 * Tests for the config-merge step in `lib/client.ts` (PR 3).
 * `auth use-foundry` writes `foundryAccount` / `passwordFile` /
 * `foundryKeystoresDir` / `expectedAddress` to
 * `~/.ospex/config.json`. Subsequent `loadSigner` /
 * `resolvePreviewAddress` calls must:
 *
 *   1. Lift those values into the intent when no flag / env is set.
 *   2. Preserve precedence: flag > env > config.
 *   3. Enforce config-pinned `expectedAddress` on every unlock —
 *      same as a per-invocation `--expected-address` flag.
 *
 * No CLI command is invoked from these tests; the loader is called
 * directly so the precedence ladder is exercised in isolation.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptKeystoreJson } from 'ethers';
import { loadSigner, resolvePreviewAddress } from '../src/lib/client.js';
import { saveConfigFile } from '../src/lib/config.js';

const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const OTHER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const PASSPHRASE = 'test-passphrase-1234';

let keystoreJson: string;

beforeAll(async () => {
  keystoreJson = await encryptKeystoreJson(
    { address: TEST_ADDRESS, privateKey: TEST_PK },
    PASSPHRASE,
  );
}, 30_000);

let tmpDir: string;
let prevEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-config-merge-'));
  prevEnv = {
    OSPEX_HOME: process.env.OSPEX_HOME,
    OSPEX_KEYSTORE_PATH: process.env.OSPEX_KEYSTORE_PATH,
    OSPEX_PASSWORD_FILE: process.env.OSPEX_PASSWORD_FILE,
    OSPEX_FOUNDRY_KEYSTORES_DIR: process.env.OSPEX_FOUNDRY_KEYSTORES_DIR,
    FOUNDRY_DIR: process.env.FOUNDRY_DIR,
  };
  process.env.OSPEX_HOME = tmpDir;
  delete process.env.OSPEX_KEYSTORE_PATH;
  delete process.env.OSPEX_PASSWORD_FILE;
  delete process.env.OSPEX_FOUNDRY_KEYSTORES_DIR;
  delete process.env.FOUNDRY_DIR;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  // Per-test teardown handles cleanup.
});

async function writeKeystoreFile(name: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, keystoreJson, 'utf8');
  return p;
}

async function writePassFile(content: string): Promise<string> {
  const p = path.join(tmpDir, 'pw.pass');
  await fs.writeFile(p, content);
  if (process.platform !== 'win32') await fs.chmod(p, 0o600);
  return p;
}

// ── loadSigner: config picked up when no flag / env ───────────────

describe('loadSigner — config-pinned foundryAccount + passwordFile (no flags, no env)', () => {
  it('unlocks via the configured foundryAccount + passwordFile + expectedAddress', async () => {
    await writeKeystoreFile('maker-a');
    const pwPath = await writePassFile(PASSPHRASE);
    await saveConfigFile({
      foundryAccount: 'maker-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
      expectedAddress: TEST_ADDRESS.toLowerCase(),
    });

    const signer = await loadSigner({});
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('throws address_mismatch when the resolved signer disagrees with config-pinned expectedAddress', async () => {
    // Simulates key rotation: config thinks the account is OTHER_ADDRESS
    // but the keystore actually unlocks to TEST_ADDRESS. The final
    // guard in loadSigner should catch this.
    await writeKeystoreFile('maker-a');
    const pwPath = await writePassFile(PASSPHRASE);
    await saveConfigFile({
      foundryAccount: 'maker-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
      expectedAddress: OTHER_ADDRESS.toLowerCase(),
    });

    await expect(loadSigner({})).rejects.toMatchObject({
      name: 'OspexSignerResolutionError',
      reason: 'address_mismatch',
      expectedAddress: OTHER_ADDRESS.toLowerCase(),
      actualAddress: TEST_ADDRESS.toLowerCase(),
    });
  });

  it('config-pinned defaults work even when the user passes no SignerIntent at all', async () => {
    await writeKeystoreFile('maker-a');
    const pwPath = await writePassFile(PASSPHRASE);
    await saveConfigFile({
      foundryAccount: 'maker-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
    });

    // No intent argument at all — config still gets merged in.
    const signer = await loadSigner();
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });
});

// ── Precedence: flag > env > config ───────────────────────────────

describe('loadSigner — precedence (flag > env > config)', () => {
  it('flag --account beats config-pinned foundryAccount', async () => {
    // Config says maker-a, flag says maker-b. The flag-named keystore
    // exists; the config-named one does not. If config won, we'd see
    // keystore_not_found for maker-a; instead we see a successful
    // unlock from maker-b.
    await writeKeystoreFile('maker-b');
    const pwPath = await writePassFile(PASSPHRASE);
    await saveConfigFile({
      foundryAccount: 'maker-a', // not on disk
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
    });

    const signer = await loadSigner({
      account: 'maker-b',
      foundryKeystoresDir: tmpDir,
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('env OSPEX_KEYSTORE_PATH beats config-pinned foundryAccount', async () => {
    // Config says maker-a; env points at a different file. Both end
    // up unlocking the same keystore JSON (same PK), but only the
    // env path's file exists on disk — the config-pinned name does
    // not. Successful unlock proves env materialized into the intent
    // and beat the config merge.
    const envKsPath = await writeKeystoreFile('env-keystore.json');
    const pwPath = await writePassFile(PASSPHRASE);
    await saveConfigFile({
      foundryAccount: 'maker-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
    });
    process.env.OSPEX_KEYSTORE_PATH = envKsPath;

    const signer = await loadSigner({});
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('flag --expected-address beats config-pinned expectedAddress', async () => {
    // Config has a benign pin (TEST_ADDRESS = actual). Flag passes
    // OTHER_ADDRESS, which doesn't match. The final guard fires off
    // the flag value, not the config value.
    await writeKeystoreFile('maker-a');
    const pwPath = await writePassFile(PASSPHRASE);
    await saveConfigFile({
      foundryAccount: 'maker-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
      expectedAddress: TEST_ADDRESS.toLowerCase(),
    });

    await expect(
      loadSigner({ expectedAddress: OTHER_ADDRESS.toLowerCase() as `0x${string}` }),
    ).rejects.toMatchObject({ reason: 'address_mismatch' });
  });
});

// ── resolvePreviewAddress: config support ─────────────────────────

describe('resolvePreviewAddress — config-pinned expectedAddress', () => {
  it('returns the config-pinned expectedAddress without unlocking', async () => {
    await saveConfigFile({
      expectedAddress: TEST_ADDRESS.toLowerCase(),
    });
    const addr = await resolvePreviewAddress({});
    expect(addr.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it('config-pinned foundryAccount + passwordFile silently unlocks for preview', async () => {
    // No expectedAddress in config — preview falls through to the
    // explicit-source branch using config's foundryAccount + passwordFile.
    await writeKeystoreFile('maker-a');
    const pwPath = await writePassFile(PASSPHRASE);
    await saveConfigFile({
      foundryAccount: 'maker-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
    });

    const addr = await resolvePreviewAddress({});
    expect(addr.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it('per-invocation --expected-address beats config-pinned expectedAddress', async () => {
    await saveConfigFile({
      expectedAddress: TEST_ADDRESS.toLowerCase(),
    });
    const addr = await resolvePreviewAddress({
      expectedAddress: OTHER_ADDRESS.toLowerCase() as `0x${string}`,
    });
    expect(addr.toLowerCase()).toBe(OTHER_ADDRESS.toLowerCase());
  });
});

// ── Hermes PR 49 regression coverage ──────────────────────────────

describe('Hermes PR 49 blocker #1 — config-pinned foundryKeystorePath is sticky', () => {
  it('loadSigner: config foundryKeystorePath + passwordFile unlocks non-interactively', async () => {
    // The bug: writing keystorePath to config via auth use-foundry
    // landed in the legacy field, which `mergeIntentFromConfig`
    // intentionally doesn't lift. loadSigner then fell through to
    // path 3 (legacy default) and prompted for a passphrase,
    // ignoring the pinned password file.
    //
    // Fix: a new `foundryKeystorePath` config slot, lifted by
    // mergeIntentFromConfig. This test exercises the corrected path.
    const ksPath = await writeKeystoreFile('foundry-pinned.json');
    const pwPath = await writePassFile(PASSPHRASE);
    await saveConfigFile({
      foundryKeystorePath: ksPath,
      passwordFile: pwPath,
      expectedAddress: TEST_ADDRESS.toLowerCase(),
    });

    const signer = await loadSigner();
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('resolvePreviewAddress: same config produces a preview address without unlocking', async () => {
    // The config has expectedAddress pinned, so preview should
    // return it via the shortcut (no decrypt).
    const ksPath = await writeKeystoreFile('foundry-pinned.json');
    const pwPath = await writePassFile(PASSPHRASE);
    await saveConfigFile({
      foundryKeystorePath: ksPath,
      passwordFile: pwPath,
      expectedAddress: TEST_ADDRESS.toLowerCase(),
    });

    const addr = await resolvePreviewAddress({});
    expect(addr.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });
});

describe('Hermes PR 49 blocker #3 — env foundry-keystores-dir beats config', () => {
  it('OSPEX_FOUNDRY_KEYSTORES_DIR env overrides config-pinned foundryKeystoresDir', async () => {
    // Config points at an empty dir; env points at the dir containing
    // maker-a. Before the fix, materializeIntent didn't lift the env
    // var, mergeIntentFromConfig lifted the config value, and the SDK
    // helper used the explicit-arg config value (which won over env at
    // the helper level). Now materializeIntent lifts the env var
    // first; merge sees the field already set and skips.
    const emptyDir = path.join(tmpDir, 'empty');
    await fs.mkdir(emptyDir, { recursive: true });
    const realDir = path.join(tmpDir, 'real');
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, 'maker-a'), keystoreJson, 'utf8');
    const pwPath = await writePassFile(PASSPHRASE);

    await saveConfigFile({
      foundryAccount: 'maker-a',
      passwordFile: pwPath,
      foundryKeystoresDir: emptyDir,
    });
    process.env.OSPEX_FOUNDRY_KEYSTORES_DIR = realDir;

    const signer = await loadSigner();
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('FOUNDRY_DIR env (with /keystores suffix) overrides config-pinned foundryKeystoresDir', async () => {
    const emptyDir = path.join(tmpDir, 'empty');
    await fs.mkdir(emptyDir, { recursive: true });
    const realKeystoresDir = path.join(tmpDir, 'real-foundry', 'keystores');
    await fs.mkdir(realKeystoresDir, { recursive: true });
    await fs.writeFile(
      path.join(realKeystoresDir, 'maker-a'),
      keystoreJson,
      'utf8',
    );
    const pwPath = await writePassFile(PASSPHRASE);

    await saveConfigFile({
      foundryAccount: 'maker-a',
      passwordFile: pwPath,
      foundryKeystoresDir: emptyDir,
    });
    // FOUNDRY_DIR is the parent — the lifter appends /keystores.
    process.env.FOUNDRY_DIR = path.join(tmpDir, 'real-foundry');

    const signer = await loadSigner();
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });
});

describe('Hermes PR 49 blocker #4 — explicit per-invocation source beats config expectedAddress in preview', () => {
  it('resolvePreviewAddress: flag --account + --password-file returns unlocked address, NOT config-pinned address', async () => {
    // Bug: config has expectedAddress for account-A. User runs a
    // preview with explicit --account B + password file. Before the
    // fix, resolvePreviewAddress returned the A-pin instead of B's
    // actual address. After: the explicit per-invocation source
    // suppresses the config pin lift, and B's actual address is
    // returned.
    //
    // Both the configured "A" and the flag "B" point at the same
    // keystore for test simplicity (so the keystore actually exists
    // under both names). The lifted-vs-not-lifted check is what
    // matters: if config.expectedAddress (set to OTHER_ADDRESS) were
    // lifted, the preview would return OTHER_ADDRESS. With the fix,
    // it returns TEST_ADDRESS (the actual unlocked address).
    await fs.writeFile(path.join(tmpDir, 'account-a'), keystoreJson, 'utf8');
    await fs.writeFile(path.join(tmpDir, 'account-b'), keystoreJson, 'utf8');
    const pwPath = await writePassFile(PASSPHRASE);

    await saveConfigFile({
      foundryAccount: 'account-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
      expectedAddress: OTHER_ADDRESS.toLowerCase(), // pin for A
    });

    const addr = await resolvePreviewAddress({
      account: 'account-b', // different from configured account
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
    });
    // We get B's actual unlocked address, NOT the config-pinned A pin.
    expect(addr.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });

  it('loadSigner: flag --account different from config does not apply config-pinned expectedAddress guard', async () => {
    // Same scenario — flag account differs from config. The final
    // guard in loadSigner must NOT apply the config-pinned
    // expectedAddress (which is for the configured account, not the
    // flag-named one). Before fix: merge lifted config.expectedAddress
    // unconditionally → guard threw address_mismatch.
    await fs.writeFile(path.join(tmpDir, 'account-a'), keystoreJson, 'utf8');
    await fs.writeFile(path.join(tmpDir, 'account-b'), keystoreJson, 'utf8');
    const pwPath = await writePassFile(PASSPHRASE);

    await saveConfigFile({
      foundryAccount: 'account-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
      expectedAddress: OTHER_ADDRESS.toLowerCase(),
    });

    // Flag picks a different account. The config-pinned pin must
    // NOT apply here. Both keystores happen to encrypt the same PK
    // so the unlock succeeds and returns TEST_ADDRESS.
    const signer = await loadSigner({
      account: 'account-b',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('loadSigner: when flag account matches config foundryAccount, the pin DOES apply', async () => {
    // The other direction — the pin SHOULD apply when the flag-named
    // account matches the configured one (the agent re-stated the
    // same account; the pin is still relevant). Mismatching the
    // actual unlocked address vs the pin throws.
    await fs.writeFile(path.join(tmpDir, 'account-a'), keystoreJson, 'utf8');
    const pwPath = await writePassFile(PASSPHRASE);

    await saveConfigFile({
      foundryAccount: 'account-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
      expectedAddress: OTHER_ADDRESS.toLowerCase(), // wrong pin
    });

    await expect(
      loadSigner({
        account: 'account-a', // same as config
        passwordFile: pwPath,
        foundryKeystoresDir: tmpDir,
      }),
    ).rejects.toMatchObject({
      name: 'OspexSignerResolutionError',
      reason: 'address_mismatch',
    });
  });
});
