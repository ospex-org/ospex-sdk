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
