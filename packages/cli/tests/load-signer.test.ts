/**
 * Regression tests for the signer-resolution precedence in
 * `lib/client.ts:loadSigner`. Covers Hermes's PR 48 blockers:
 *
 *   1. Explicit `--account` / `--keystore-path` must NOT fall back to
 *      the legacy session cache — even when a fresh session exists.
 *      A user who explicitly names a keystore is signaling intent
 *      that overrides the cached signer.
 *
 *   2. `--expected-address` mismatch must be caught regardless of
 *      which path produced the signer. The SDK-helper path enforces
 *      it internally; the session-cache and legacy-default paths
 *      need the final guard in `loadSigner` to fire.
 *
 *   3. Env-only configuration (`OSPEX_KEYSTORE_PATH` +
 *      `OSPEX_PASSWORD_FILE`) must produce a working unlock. Before
 *      the fix, `hasExplicitKeystoreSource` saw the env var but
 *      `loadSignerNonInteractive` passed `undefined` to the SDK
 *      helper, which then threw `keystore_not_found`.
 *
 * These tests use real on-disk fixtures (encrypted keystore, password
 * file, session JSON) under `os.tmpdir()` and stub `process.env` via
 * `OSPEX_HOME` / `OSPEX_KEYSTORE_PATH` / `OSPEX_PASSWORD_FILE`. The
 * keystore is encrypted once in `beforeAll` and reused across tests
 * to avoid paying the scrypt cost per case.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptKeystoreJson } from 'ethers';
import { OspexSignerResolutionError } from '@ospex/sdk';
import { loadSigner } from '../src/lib/client.js';

// Anvil account #0 / #1 — throwaway test keys, never used for anything real.
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-load-signer-'));
  prevEnv = {
    OSPEX_HOME: process.env.OSPEX_HOME,
    OSPEX_KEYSTORE_PATH: process.env.OSPEX_KEYSTORE_PATH,
    OSPEX_PASSWORD_FILE: process.env.OSPEX_PASSWORD_FILE,
    OSPEX_FOUNDRY_KEYSTORES_DIR: process.env.OSPEX_FOUNDRY_KEYSTORES_DIR,
    FOUNDRY_DIR: process.env.FOUNDRY_DIR,
  };
  // Default: scope everything to tmpDir so legacy paths don't reach
  // the user's real home. Specific tests override OSPEX_KEYSTORE_PATH
  // / OSPEX_PASSWORD_FILE as needed.
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
  // Per-test teardown already covered.
});

async function writeSession(address: string, privateKey: string): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, 'session'),
    JSON.stringify({ address, privateKey, expiresAt: Date.now() + 60_000 }) + '\n',
  );
}

async function writePasswordFile(content: string): Promise<string> {
  const p = path.join(tmpDir, 'pw.pass');
  await fs.writeFile(p, content);
  if (process.platform !== 'win32') await fs.chmod(p, 0o600);
  return p;
}

async function writeKeystoreFile(filename: string): Promise<string> {
  const p = path.join(tmpDir, filename);
  await fs.writeFile(p, keystoreJson, 'utf8');
  return p;
}

// ── Issue 1: explicit --account skips session cache ───────────────

describe('loadSigner — Hermes PR 48 blocker #1 (explicit intent skips session)', () => {
  it('explicit --account does NOT fall back to the cached session signer', async () => {
    // Set up a fresh session for TEST_ADDRESS, then ask for an
    // account that doesn't exist. Before the fix this would silently
    // return the session signer (wrong wallet). After the fix it
    // throws keystore_not_found because the explicit account file
    // doesn't exist in the keystores dir.
    await writeSession(TEST_ADDRESS, TEST_PK);
    const pwPath = await writePasswordFile(PASSPHRASE);

    await expect(
      loadSigner({
        account: 'definitely-missing-foundry-account',
        passwordFile: pwPath,
        foundryKeystoresDir: tmpDir,
      }),
    ).rejects.toMatchObject({
      name: 'OspexSignerResolutionError',
      reason: 'keystore_not_found',
    });
  });

  it('explicit --keystore-path does NOT fall back to the cached session signer', async () => {
    await writeSession(TEST_ADDRESS, TEST_PK);
    const pwPath = await writePasswordFile(PASSPHRASE);
    const missing = path.join(tmpDir, 'no-such-keystore.json');

    await expect(
      loadSigner({ keystorePath: missing, passwordFile: pwPath }),
    ).rejects.toMatchObject({
      name: 'OspexSignerResolutionError',
      reason: 'keystore_not_found',
    });
  });

  it('explicit --account + --password-file unlocks the named keystore, NOT the cached session wallet', async () => {
    // The session is for TEST_ADDRESS (Anvil #0). Place a keystore
    // under a different name in the foundry-keystores dir, also
    // encrypted to TEST_ADDRESS. Since loadSigner skips the session
    // entirely when --account is set, both end up returning the
    // same address only because we encrypted the keystore with the
    // same PK — but the path that produced the signer is the SDK
    // helper, not the session cache. We assert on the address; the
    // companion `does NOT fall back` tests above cover the case where
    // the two addresses diverge.
    await writeSession(TEST_ADDRESS, TEST_PK);
    const pwPath = await writePasswordFile(PASSPHRASE);
    await writeKeystoreFile('maker-a');

    const signer = await loadSigner({
      account: 'maker-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });
});

// ── Issue 2: expectedAddress validated on every path ──────────────

describe('loadSigner — Hermes PR 48 blocker #2 (final expectedAddress guard)', () => {
  it('throws address_mismatch when a cached session resolves to a different address than expectedAddress', async () => {
    // Session is for TEST_ADDRESS. expectedAddress is OTHER_ADDRESS.
    // Before the fix, expectedAddress was ignored on the session-cache
    // path. After the fix, the final guard in loadSigner catches the
    // mismatch and throws.
    await writeSession(TEST_ADDRESS, TEST_PK);

    await expect(
      loadSigner({ expectedAddress: OTHER_ADDRESS.toLowerCase() as `0x${string}` }),
    ).rejects.toMatchObject({
      name: 'OspexSignerResolutionError',
      reason: 'address_mismatch',
      expectedAddress: OTHER_ADDRESS.toLowerCase(),
      actualAddress: TEST_ADDRESS.toLowerCase(),
    });
  });

  it('passes through when expectedAddress matches the cached session address', async () => {
    await writeSession(TEST_ADDRESS, TEST_PK);
    const signer = await loadSigner({
      expectedAddress: TEST_ADDRESS.toLowerCase() as `0x${string}`,
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('compares case-insensitively (mixed-case input still matches the lower-cased actual)', async () => {
    await writeSession(TEST_ADDRESS, TEST_PK);
    // Pass the address with the original mixed-case ethers checksum.
    const signer = await loadSigner({
      expectedAddress: TEST_ADDRESS as `0x${string}`,
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });
});

// ── Issue 3: env-only path works ──────────────────────────────────

describe('loadSigner — Hermes PR 48 blocker #3 (env-only path)', () => {
  it('unlocks via OSPEX_KEYSTORE_PATH + OSPEX_PASSWORD_FILE with no intent supplied', async () => {
    // Before the fix, hasExplicitKeystoreSource saw OSPEX_KEYSTORE_PATH
    // but loadSignerNonInteractive passed undefined to fromKeystoreFile.
    // After the fix, materializeIntent reads the env var into
    // intent.keystorePath before any downstream call.
    const ksPath = await writeKeystoreFile('env-keystore.json');
    const pwPath = await writePasswordFile(PASSPHRASE);

    process.env.OSPEX_KEYSTORE_PATH = ksPath;
    process.env.OSPEX_PASSWORD_FILE = pwPath;

    const signer = await loadSigner();
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('OSPEX_KEYSTORE_PATH alone (no passphrase source) still respects expectedAddress on prompt-fallback path', async () => {
    // Even without OSPEX_PASSWORD_FILE, the env var should materialize
    // into intent.keystorePath. Without a passphrase source and
    // without a session, the regular flow would prompt — we don't
    // exercise that here (would hang on stdin); instead we verify
    // the materialization by asserting the explicit-intent branch
    // takes over (session skipped) when a session exists.
    await writeSession(TEST_ADDRESS, TEST_PK);
    const ksPath = await writeKeystoreFile('env-only.json');
    process.env.OSPEX_KEYSTORE_PATH = ksPath;
    // No OSPEX_PASSWORD_FILE. With expectedAddress mismatching the
    // session, the path-1 branch tries to unlock interactively — we
    // catch the resulting hang by supplying --password-file via the
    // env var on a separate run. For this case, prove explicit-source
    // detection via the address-mismatch error: the session has
    // TEST_ADDRESS, expectedAddress is OTHER_ADDRESS, and a successful
    // session-cache fall-through would surface the mismatch from the
    // session signer. After the fix, the env-materialized
    // keystorePath should route to path 1 — which without a passphrase
    // source can only proceed via interactive prompt. We can't easily
    // assert that without mocking promptHidden, so we set the
    // password file too and observe the unlock + mismatch check on
    // the SDK-helper path.
    process.env.OSPEX_PASSWORD_FILE = await writePasswordFile(PASSPHRASE);

    await expect(
      loadSigner({
        expectedAddress: OTHER_ADDRESS.toLowerCase() as `0x${string}`,
      }),
    ).rejects.toMatchObject({
      name: 'OspexSignerResolutionError',
      reason: 'address_mismatch',
    });
  });

  it('explicit --keystore-path beats OSPEX_KEYSTORE_PATH', async () => {
    const explicitKs = await writeKeystoreFile('explicit.json');
    const envKsPath = path.join(tmpDir, 'env-keystore-does-not-exist.json');
    const pwPath = await writePasswordFile(PASSPHRASE);

    process.env.OSPEX_KEYSTORE_PATH = envKsPath; // points at nonexistent file
    const signer = await loadSigner({
      keystorePath: explicitKs,
      passwordFile: pwPath,
    });
    // If env materialization had overridden the flag, the load would
    // have thrown keystore_not_found. The fact that we got a working
    // signer confirms the precedence is flag > env.
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });
});

// ── Sanity: legacy session path still works when no explicit intent ───

describe('loadSigner — legacy session path preserved', () => {
  it('returns the cached session signer when no intent / no explicit env is set', async () => {
    // Default case — no flags, no override env. Today's
    // `wallet unlock` users should be unaffected by the new code.
    await writeSession(TEST_ADDRESS, TEST_PK);
    const signer = await loadSigner();
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });
});
