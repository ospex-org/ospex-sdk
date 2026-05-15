/**
 * Tests for `resolvePreviewAddress` in `lib/client.ts` — the helper
 * that `commitments submit --json` / `commitments match --json` use
 * to derive a maker/taker address WITHOUT triggering a keystore
 * unlock. Spec §17.2.
 *
 * Branches verified:
 *   - `--expected-address` set → return it as-is. Zero I/O.
 *   - Explicit --account / --keystore-path with non-interactive
 *     passphrase → silent unlock, derive.
 *   - Explicit --account / --keystore-path WITHOUT non-interactive
 *     passphrase → throw (must NOT fall back to session cache).
 *   - Legacy session cache (`~/.ospex/session`) present + no explicit
 *     intent → use cached address.
 *   - Env-only OSPEX_KEYSTORE_PATH + OSPEX_PASSWORD_FILE → silent
 *     unlock.
 *   - Nothing supplied → throw `non_interactive_password_required`.
 *
 * Also covers Hermes's PR 48 blockers as they apply to the preview
 * path (parallel to load-signer.test.ts for the sign path).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptKeystoreJson } from 'ethers';
import { OspexSignerResolutionError } from '@ospex/sdk';
import { resolvePreviewAddress } from '../src/lib/client.js';

const EXPECTED: `0x${string}` = '0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34';
const SESSION_ADDR: `0x${string}` = '0xcd34ef56cd34ef56cd34ef56cd34ef56cd34ef56';

// Anvil #0 — for the env-only unlock test.
const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-preview-address-'));
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
  // Per-test teardown handles all cleanup.
});

async function writeSession(payload: {
  address: string;
  privateKey: string;
  expiresAt: number;
}): Promise<void> {
  const sessionPath = path.join(tmpDir, 'session');
  await fs.writeFile(sessionPath, JSON.stringify(payload) + '\n');
}

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

describe('resolvePreviewAddress — expected-address branch', () => {
  it('returns intent.expectedAddress as-is when set (zero I/O)', async () => {
    const result = await resolvePreviewAddress({ expectedAddress: EXPECTED });
    expect(result).toBe(EXPECTED);
  });

  it('returns expectedAddress even when conflicting non-interactive intent is present', async () => {
    // Precedence: --expected-address wins over any credential source.
    // This lets agents pin the address even when they have credentials
    // configured (e.g. for multi-wallet flows).
    const result = await resolvePreviewAddress({
      expectedAddress: EXPECTED,
      account: 'maker-a',
      passwordFile: '/nope',
    });
    expect(result).toBe(EXPECTED);
  });
});

describe('resolvePreviewAddress — cached-session branch', () => {
  it('returns the session address when a fresh session is on disk', async () => {
    await writeSession({
      address: SESSION_ADDR,
      privateKey: '0x'.padEnd(66, '1'),
      expiresAt: Date.now() + 60_000,
    });
    const result = await resolvePreviewAddress({});
    expect(result.toLowerCase()).toBe(SESSION_ADDR);
  });

  it('falls through (throws) when the session has expired', async () => {
    await writeSession({
      address: SESSION_ADDR,
      privateKey: '0x'.padEnd(66, '1'),
      expiresAt: Date.now() - 60_000,
    });
    await expect(resolvePreviewAddress({})).rejects.toMatchObject({
      name: 'OspexSignerResolutionError',
      reason: 'non_interactive_password_required',
    });
  });
});

describe('resolvePreviewAddress — empty-intent branch', () => {
  it('throws non_interactive_password_required when nothing is configured', async () => {
    await expect(resolvePreviewAddress({})).rejects.toBeInstanceOf(
      OspexSignerResolutionError,
    );
    await expect(resolvePreviewAddress({})).rejects.toMatchObject({
      reason: 'non_interactive_password_required',
    });
  });

  it("error message hints at the three actionable next steps", async () => {
    try {
      await resolvePreviewAddress({});
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OspexSignerResolutionError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/--expected-address/);
      expect(msg).toMatch(/--account/);
      expect(msg).toMatch(/--password-file/);
      expect(msg).toMatch(/wallet unlock/);
    }
  });
});

// ── Hermes PR 48 regression coverage ──────────────────────────────

describe('resolvePreviewAddress — explicit intent skips session (PR 48 blocker #1)', () => {
  it('--account WITHOUT a passphrase source does NOT fall through to the cached session', async () => {
    // Session is for SESSION_ADDR. Asking for an --account in
    // preview-only mode without a passphrase source: must NOT
    // silently return SESSION_ADDR. Preview can't prompt, so this
    // is the right place to error.
    await writeSession({
      address: SESSION_ADDR,
      privateKey: '0x'.padEnd(66, '1'),
      expiresAt: Date.now() + 60_000,
    });
    await expect(
      resolvePreviewAddress({ account: 'maker-a', foundryKeystoresDir: tmpDir }),
    ).rejects.toMatchObject({
      name: 'OspexSignerResolutionError',
      reason: 'non_interactive_password_required',
    });
  });

  it('--keystore-path WITHOUT a passphrase source also errors instead of using the session', async () => {
    await writeSession({
      address: SESSION_ADDR,
      privateKey: '0x'.padEnd(66, '1'),
      expiresAt: Date.now() + 60_000,
    });
    const ksPath = await writeKeystoreFile('explicit.json');
    await expect(
      resolvePreviewAddress({ keystorePath: ksPath }),
    ).rejects.toMatchObject({
      reason: 'non_interactive_password_required',
    });
  });

  it('--account + --password-file silently unlocks and returns the derived address (NOT the session)', async () => {
    await writeSession({
      address: SESSION_ADDR,
      privateKey: '0x'.padEnd(66, '1'),
      expiresAt: Date.now() + 60_000,
    });
    await writeKeystoreFile('maker-a');
    const pwPath = await writePassFile(PASSPHRASE);
    const addr = await resolvePreviewAddress({
      account: 'maker-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
    });
    // The unlocked keystore's TEST_ADDRESS, not SESSION_ADDR.
    expect(addr.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });
});

describe('resolvePreviewAddress — env-only path (PR 48 blocker #3)', () => {
  it('unlocks via OSPEX_KEYSTORE_PATH + OSPEX_PASSWORD_FILE with no intent supplied', async () => {
    const ksPath = await writeKeystoreFile('env-keystore.json');
    const pwPath = await writePassFile(PASSPHRASE);
    process.env.OSPEX_KEYSTORE_PATH = ksPath;
    process.env.OSPEX_PASSWORD_FILE = pwPath;
    const addr = await resolvePreviewAddress({});
    expect(addr.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });
});
