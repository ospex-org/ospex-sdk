/**
 * Tests for `ospex auth check` — the diagnostic command that walks
 * the signer-resolution ladder, optionally unlocks, optionally signs
 * a deterministic challenge, and emits a stable JSON envelope.
 *
 * The CLI action's `process.exit(...)` shell is untestable through
 * `parseAsync` (would kill vitest), so we test the exported
 * `buildEnvelope(args)` directly — same code path, same envelope.
 * The shell is a thin wrapper documented in the command file's header.
 *
 * Verifies:
 *   - Each precedence layer in keystore + password + expected-address
 *     + foundry-keystores-dir gets the right provenance label.
 *   - Unlock attempts fire only when a non-interactive password is
 *     available; otherwise `skippedReason` reports it.
 *   - `--expected-address` mismatch becomes a typed error in the
 *     envelope (no signer-resolution exception leaks).
 *   - POSIX-only: `--strict` flips a loose-perm warning into an error.
 *   - `--sign-challenge` produces a valid 0x-prefixed signature; absent
 *     a non-interactive source it surfaces `non_interactive_password_required`.
 *   - JSON envelope shape (`schemaVersion`, top-level keys) stays
 *     stable so the agent contract doesn't drift.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptKeystoreJson } from 'ethers';
import { buildEnvelope, AUTH_CHALLENGE } from '../src/commands/auth/check.js';
import type { CliConfigFile } from '../src/lib/config.js';
import type { SignerIntent } from '../src/lib/signer-options.js';

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-auth-check-'));
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

afterAll(() => {});

async function writeKeystoreAt(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await fs.writeFile(p, keystoreJson, 'utf8');
  return p;
}

async function writePass(content: string, name = 'pw.pass'): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content);
  if (process.platform !== 'win32') await fs.chmod(p, 0o600);
  return p;
}

async function writeLoosePass(content: string, name = 'pw.pass'): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content);
  if (process.platform !== 'win32') await fs.chmod(p, 0o644);
  return p;
}

// POSIX-only test runner — permission semantics don't apply on Windows.
const itPosix = process.platform !== 'win32' ? it : it.skip;

// ── Keystore resolution provenance ────────────────────────────────

describe('auth check — keystore resolution provenance', () => {
  it('flag-account beats env beats config', async () => {
    const accountDir = path.join(tmpDir, 'flagdir');
    await writeKeystoreAt(accountDir, 'maker-a');

    // Stale env + config that would point elsewhere — flag should win.
    process.env.OSPEX_KEYSTORE_PATH = '/never/used.json';
    const config: CliConfigFile = {
      foundryAccount: 'never-used',
      foundryKeystoresDir: '/also-never',
    };

    const env = await buildEnvelope({
      intent: { account: 'maker-a', foundryKeystoresDir: accountDir },
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('flag-account');
    expect(env.resolution.keystore.account).toBe('maker-a');
    expect(env.resolution.keystore.path).toBe(path.join(accountDir, 'maker-a'));
    expect(env.resolution.keystore.exists).toBe(true);
  });

  it('flag-keystore-path beats env beats config', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'flagks.json');
    process.env.OSPEX_KEYSTORE_PATH = '/never/used.json';
    const config: CliConfigFile = { foundryAccount: 'never-used' };

    const env = await buildEnvelope({
      intent: { keystorePath: ks },
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('flag-keystore-path');
    expect(env.resolution.keystore.path).toBe(ks);
  });

  it('env OSPEX_KEYSTORE_PATH beats config', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'envks.json');
    process.env.OSPEX_KEYSTORE_PATH = ks;
    const config: CliConfigFile = { foundryAccount: 'never-used' };

    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('env-OSPEX_KEYSTORE_PATH');
    expect(env.resolution.keystore.path).toBe(ks);
  });

  it('config.foundryAccount when no flag/env', async () => {
    const accountDir = path.join(tmpDir, 'foundrydir');
    await writeKeystoreAt(accountDir, 'configmaker');
    const config: CliConfigFile = {
      foundryAccount: 'configmaker',
      foundryKeystoresDir: accountDir,
    };

    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('config-foundryAccount');
    expect(env.resolution.keystore.account).toBe('configmaker');
    expect(env.resolution.keystore.path).toBe(
      path.join(accountDir, 'configmaker'),
    );
  });

  it('config.foundryKeystorePath beats legacy config.keystorePath', async () => {
    const newPath = await writeKeystoreAt(tmpDir, 'foundry-pinned.json');
    const config: CliConfigFile = {
      foundryKeystorePath: newPath,
      keystorePath: '/legacy/init-set.json',
    };

    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('config-foundryKeystorePath');
    expect(env.resolution.keystore.path).toBe(newPath);
  });

  it('legacy config.keystorePath beats default', async () => {
    const legacy = await writeKeystoreAt(tmpDir, 'legacy.json');
    const config: CliConfigFile = { keystorePath: legacy };

    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('config-keystorePath-legacy');
    expect(env.resolution.keystore.path).toBe(legacy);
  });

  it('default ~/.ospex/keystore.json when nothing configured (file missing → exists=false)', async () => {
    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('default-legacy');
    expect(env.resolution.keystore.path).toBe(path.join(tmpDir, 'keystore.json'));
    expect(env.resolution.keystore.exists).toBe(false);
    expect(env.errors.map((e) => e.code)).toContain('keystore_not_found');
    expect(env.ok).toBe(false);
  });
});

// ── Password resolution provenance ────────────────────────────────

describe('auth check — password resolution provenance', () => {
  it('flag-password-file beats env beats config', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    const pwFile = await writePass(PASSPHRASE, 'flag.pass');
    process.env.OSPEX_PASSWORD_FILE = '/never/used';
    const config: CliConfigFile = { passwordFile: '/also-never' };

    const env = await buildEnvelope({
      intent: { keystorePath: ks, passwordFile: pwFile },
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.password.provenance).toBe('flag-password-file');
    expect(env.resolution.password.path).toBe(pwFile);
  });

  it('flag-password-stdin provenance is recorded (unlock path covered by integration)', async () => {
    // Point at a non-existent keystore so `canAttemptUnlock` is false
    // — the actual stdin read would block forever without a piped
    // input, and there's no clean way to inject a synthetic stdin
    // through buildEnvelope's public signature. The provenance label
    // is the unit-testable invariant; end-to-end stdin piping is
    // covered by the manual integration playbook.
    const missingKs = path.join(tmpDir, 'no-such-keystore.json');

    const env = await buildEnvelope({
      intent: { keystorePath: missingKs, fromStdin: true },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.password.provenance).toBe('flag-password-stdin');
    expect(env.resolution.password.path).toBeNull();
    expect(env.unlock.attempted).toBe(false);
  });

  it('env OSPEX_PASSWORD_FILE beats config', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    const pwFile = await writePass(PASSPHRASE, 'env.pass');
    process.env.OSPEX_PASSWORD_FILE = pwFile;
    const config: CliConfigFile = { passwordFile: '/never' };

    const env = await buildEnvelope({
      intent: { keystorePath: ks },
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.password.provenance).toBe('env-OSPEX_PASSWORD_FILE');
    expect(env.resolution.password.path).toBe(pwFile);
  });

  it('config.passwordFile when no flag/env', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    const pwFile = await writePass(PASSPHRASE, 'config.pass');
    const config: CliConfigFile = { passwordFile: pwFile };

    const env = await buildEnvelope({
      intent: { keystorePath: ks },
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.password.provenance).toBe('config-passwordFile');
    expect(env.resolution.password.path).toBe(pwFile);
  });

  it('none when nothing configured', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');

    const env = await buildEnvelope({
      intent: { keystorePath: ks },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.password.provenance).toBe('none');
    expect(env.unlock.attempted).toBe(false);
    expect(env.unlock.skippedReason).toBe('no_non_interactive_password');
    expect(env.ok).toBe(true);
  });
});

// ── Foundry keystores dir provenance ──────────────────────────────

describe('auth check — foundry keystores dir provenance', () => {
  it('flag beats env', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    process.env.OSPEX_FOUNDRY_KEYSTORES_DIR = '/never';

    const env = await buildEnvelope({
      intent: { keystorePath: ks, foundryKeystoresDir: '/flag/dir' },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.foundryKeystoresDir.provenance).toBe('flag');
    expect(env.resolution.foundryKeystoresDir.value).toBe('/flag/dir');
  });

  it('env OSPEX_FOUNDRY_KEYSTORES_DIR beats env FOUNDRY_DIR beats config beats default', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    process.env.OSPEX_FOUNDRY_KEYSTORES_DIR = '/ospex-env';
    process.env.FOUNDRY_DIR = '/foundry-env';

    const env = await buildEnvelope({
      intent: { keystorePath: ks },
      env: process.env,
      config: { foundryKeystoresDir: '/cfg' },
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.foundryKeystoresDir.provenance).toBe(
      'env-OSPEX_FOUNDRY_KEYSTORES_DIR',
    );
    expect(env.resolution.foundryKeystoresDir.value).toBe('/ospex-env');
  });

  it('FOUNDRY_DIR appends /keystores', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    process.env.FOUNDRY_DIR = '/foundry-env';

    const env = await buildEnvelope({
      intent: { keystorePath: ks },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.foundryKeystoresDir.provenance).toBe('env-FOUNDRY_DIR');
    expect(env.resolution.foundryKeystoresDir.value).toBe(
      path.join('/foundry-env', 'keystores'),
    );
  });
});

// ── Expected-address resolution ───────────────────────────────────

describe('auth check — expected-address provenance', () => {
  it('flag beats config', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    const intent: SignerIntent = {
      keystorePath: ks,
      expectedAddress: '0xabababababababababababababababababababab' as `0x${string}`,
    };
    const config: CliConfigFile = {
      expectedAddress: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
    };

    const env = await buildEnvelope({
      intent,
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.expectedAddress.provenance).toBe('flag');
    expect(env.resolution.expectedAddress.value).toBe(
      '0xabababababababababababababababababababab',
    );
  });

  it('config pin applies when keystore was lifted from config', async () => {
    const dir = path.join(tmpDir, 'fdir');
    await writeKeystoreAt(dir, 'maker-a');
    const config: CliConfigFile = {
      foundryAccount: 'maker-a',
      foundryKeystoresDir: dir,
      expectedAddress: TEST_ADDRESS.toLowerCase(),
    };

    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.expectedAddress.provenance).toBe('config');
    expect(env.resolution.expectedAddress.value).toBe(TEST_ADDRESS.toLowerCase());
  });

  it('config pin does NOT apply when flag account differs from config', async () => {
    const dir = path.join(tmpDir, 'fdir');
    await writeKeystoreAt(dir, 'maker-other');
    const config: CliConfigFile = {
      foundryAccount: 'maker-pinned',
      foundryKeystoresDir: dir,
      expectedAddress: '0xabababababababababababababababababababab',
    };

    const env = await buildEnvelope({
      intent: { account: 'maker-other', foundryKeystoresDir: dir },
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    // Wrong wallet — the pin must not silently attach to a different
    // account. Same conditional lift as `mergeIntentFromConfig`.
    expect(env.resolution.expectedAddress.provenance).toBe('none');
    expect(env.resolution.expectedAddress.value).toBeNull();
  });

  it('config pin still applies when explicit flag matches config account', async () => {
    const dir = path.join(tmpDir, 'fdir');
    await writeKeystoreAt(dir, 'maker-a');
    const config: CliConfigFile = {
      foundryAccount: 'maker-a',
      foundryKeystoresDir: dir,
      expectedAddress: TEST_ADDRESS.toLowerCase(),
    };

    const env = await buildEnvelope({
      intent: { account: 'maker-a', foundryKeystoresDir: dir },
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.expectedAddress.provenance).toBe('config');
    expect(env.resolution.expectedAddress.value).toBe(TEST_ADDRESS.toLowerCase());
  });
});

// ── Unlock behavior ───────────────────────────────────────────────

describe('auth check — unlock behavior', () => {
  it('unlocks via --account + --password-file and reports the address', async () => {
    const dir = path.join(tmpDir, 'fdir');
    await writeKeystoreAt(dir, 'maker-a');
    const pwFile = await writePass(PASSPHRASE);

    const env = await buildEnvelope({
      intent: { account: 'maker-a', passwordFile: pwFile, foundryKeystoresDir: dir },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.unlock.attempted).toBe(true);
    expect(env.unlock.succeeded).toBe(true);
    expect(env.unlock.address?.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    expect(env.ok).toBe(true);
  });

  it('skipped when no non-interactive password is available', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');

    const env = await buildEnvelope({
      intent: { keystorePath: ks },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.unlock.attempted).toBe(false);
    expect(env.unlock.skippedReason).toBe('no_non_interactive_password');
    expect(env.ok).toBe(true); // Diagnostic only — not configured isn't an error.
  });

  it('--expected-address mismatch surfaces as a typed error', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    const pwFile = await writePass(PASSPHRASE);

    const env = await buildEnvelope({
      intent: {
        keystorePath: ks,
        passwordFile: pwFile,
        expectedAddress: OTHER_ADDRESS.toLowerCase() as `0x${string}`,
      },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.unlock.attempted).toBe(true);
    expect(env.unlock.succeeded).toBe(false);
    expect(env.errors.map((e) => e.code)).toContain('address_mismatch');
    expect(env.ok).toBe(false);
  });

  it('wrong passphrase reports decryption_failed', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    const pwFile = await writePass('definitely-not-the-passphrase');

    const env = await buildEnvelope({
      intent: { keystorePath: ks, passwordFile: pwFile },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.unlock.attempted).toBe(true);
    expect(env.unlock.succeeded).toBe(false);
    expect(env.errors.map((e) => e.code)).toContain('decryption_failed');
    expect(env.ok).toBe(false);
  });

  it('keystore missing → error before any unlock attempt', async () => {
    const env = await buildEnvelope({
      intent: { keystorePath: path.join(tmpDir, 'nope.json') },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.exists).toBe(false);
    expect(env.errors.map((e) => e.code)).toContain('keystore_not_found');
    expect(env.unlock.attempted).toBe(false);
    expect(env.ok).toBe(false);
  });

  it('password file path missing → error before any unlock attempt', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');

    const env = await buildEnvelope({
      intent: { keystorePath: ks, passwordFile: path.join(tmpDir, 'nope.pass') },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.errors.map((e) => e.code)).toContain('password_file_not_found');
    expect(env.unlock.attempted).toBe(false);
    expect(env.ok).toBe(false);
  });
});

// ── Permission gate ────────────────────────────────────────────────

describe('auth check — --strict permission gate', () => {
  itPosix('loose perm → warning in default mode (unlock still runs)', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    const pwFile = await writeLoosePass(PASSPHRASE);

    const env = await buildEnvelope({
      intent: { keystorePath: ks, passwordFile: pwFile },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.passwordFilePermissions.checked).toBe(true);
    expect(env.passwordFilePermissions.loose).toBe(true);
    expect(env.warnings.length).toBe(1);
    expect(env.warnings[0]).toMatch(/group\/other/);
    expect(env.errors).toEqual([]);
    expect(env.unlock.succeeded).toBe(true);
    expect(env.ok).toBe(true);
  });

  itPosix('loose perm + --strict → error, unlock attempt blocked', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    const pwFile = await writeLoosePass(PASSPHRASE);

    const env = await buildEnvelope({
      intent: { keystorePath: ks, passwordFile: pwFile },
      env: process.env,
      config: {},
      strict: true,
      signChallengeRequested: false,
    });

    expect(env.passwordFilePermissions.loose).toBe(true);
    expect(env.errors.map((e) => e.code)).toContain('password_file_permissions_loose');
    expect(env.unlock.attempted).toBe(false);
    expect(env.ok).toBe(false);
  });

  itPosix('tight perm → no warning, no error, unlock succeeds', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    const pwFile = await writePass(PASSPHRASE);

    const env = await buildEnvelope({
      intent: { keystorePath: ks, passwordFile: pwFile },
      env: process.env,
      config: {},
      strict: true,
      signChallengeRequested: false,
    });

    expect(env.passwordFilePermissions.loose).toBe(false);
    expect(env.warnings).toEqual([]);
    expect(env.errors).toEqual([]);
    expect(env.unlock.succeeded).toBe(true);
    expect(env.ok).toBe(true);
  });
});

// ── Sign challenge ────────────────────────────────────────────────

describe('auth check — --sign-challenge', () => {
  it('signs the deterministic EIP-712 challenge and returns a 0x signature', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    const pwFile = await writePass(PASSPHRASE);

    const env = await buildEnvelope({
      intent: { keystorePath: ks, passwordFile: pwFile },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: true,
    });

    expect(env.challenge.requested).toBe(true);
    expect(env.challenge.signed).toBe(true);
    expect(env.challenge.signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(env.ok).toBe(true);
  });

  it('challenge payload exposed for agents is deterministic and stable', () => {
    // Smoke-check the AUTH_CHALLENGE constants — agents recreating the
    // typed-data for verification depend on this exact shape.
    expect(AUTH_CHALLENGE.domain).toEqual({
      name: 'Ospex Auth Check',
      version: '1',
    });
    expect(AUTH_CHALLENGE.primaryType).toBe('AuthChallenge');
    expect(AUTH_CHALLENGE.message).toEqual({
      product: 'ospex',
      purpose: 'auth-check signing self-test',
    });
  });

  it('errors with non_interactive_password_required when no password source', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');

    const env = await buildEnvelope({
      intent: { keystorePath: ks },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: true,
    });

    expect(env.challenge.signed).toBe(false);
    expect(env.errors.map((e) => e.code)).toContain(
      'non_interactive_password_required',
    );
    expect(env.ok).toBe(false);
  });
});

// ── JSON envelope shape ───────────────────────────────────────────

describe('auth check — JSON envelope shape', () => {
  it('always includes schemaVersion:1 and the top-level keys', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'ks.json');
    const pwFile = await writePass(PASSPHRASE);

    const env = await buildEnvelope({
      intent: { keystorePath: ks, passwordFile: pwFile },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.schemaVersion).toBe(1);
    expect(Object.keys(env)).toEqual(
      expect.arrayContaining([
        'schemaVersion',
        'ok',
        'strict',
        'resolution',
        'unlock',
        'passwordFilePermissions',
        'challenge',
        'warnings',
        'errors',
      ]),
    );
    expect(Object.keys(env.resolution)).toEqual(
      expect.arrayContaining([
        'keystore',
        'password',
        'expectedAddress',
        'foundryKeystoresDir',
      ]),
    );
  });

  it('error entries carry stable {code, message} shape', async () => {
    const env = await buildEnvelope({
      intent: { keystorePath: path.join(tmpDir, 'nope.json') },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.errors.length).toBeGreaterThan(0);
    for (const e of env.errors) {
      expect(typeof e.code).toBe('string');
      expect(e.code.length).toBeGreaterThan(0);
      expect(typeof e.message).toBe('string');
    }
  });
});

// ── Command surface (help text) ───────────────────────────────────

describe('auth check — command help', () => {
  it('exposes the signer-options flag group + --strict + --sign-challenge + --json', async () => {
    const { authCheckCommand } = await import('../src/commands/auth/check.js');
    const help = authCheckCommand.helpInformation();
    expect(help).toMatch(/--account/);
    expect(help).toMatch(/--keystore-path/);
    expect(help).toMatch(/--password-file/);
    expect(help).toMatch(/--password-stdin/);
    expect(help).toMatch(/--expected-address/);
    expect(help).toMatch(/--foundry-keystores-dir/);
    expect(help).toMatch(/--strict/);
    expect(help).toMatch(/--sign-challenge/);
    expect(help).toMatch(/--json/);
  });
});

// ── Hermes PR 50 regression — session-cache must mirror loadSigner ──

// Anvil PK #1 — used as the session-cache wallet in regression tests
// so we can tell the difference between an explicit-source unlock
// (uses #0 / TEST_ADDRESS) and a session-fallback unlock (uses #1).
const SESSION_PK =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const SESSION_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

async function writeFakeSession(privateKey: string, address: string): Promise<void> {
  // `getSessionPath()` returns `<OSPEX_HOME>/session` — beforeEach sets
  // OSPEX_HOME to tmpDir, so writing here lands where `readSession()`
  // will look. 1-minute TTL so the entry is fresh during the test.
  await fs.writeFile(
    path.join(tmpDir, 'session'),
    JSON.stringify({
      address,
      privateKey,
      expiresAt: Date.now() + 60_000,
    }) + '\n',
  );
}

describe('auth check — Hermes PR 50 blocker #1 (session-cache must not leak past explicit sources)', () => {
  it('explicit --account + active session + no password → password.provenance is "none", NOT "session-cache"', async () => {
    // Repro from Hermes's review: `auth check --account maker-a` was
    // returning 'session-cache' when a stale session existed, which
    // would let `--sign-challenge` sign with the WRONG wallet.
    await writeFakeSession(SESSION_PK, SESSION_ADDRESS);
    const accountDir = path.join(tmpDir, 'fdir');
    await writeKeystoreAt(accountDir, 'maker-a');

    const env = await buildEnvelope({
      intent: { account: 'maker-a', foundryKeystoresDir: accountDir },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.password.provenance).toBe('none');
    expect(env.unlock.attempted).toBe(false);
    expect(env.unlock.skippedReason).toBe('no_non_interactive_password');
  });

  it('explicit --account + --password-file + active session for a different wallet → unlock uses maker-a, NOT session', async () => {
    await writeFakeSession(SESSION_PK, SESSION_ADDRESS);
    const accountDir = path.join(tmpDir, 'fdir');
    await writeKeystoreAt(accountDir, 'maker-a');
    const pwFile = await writePass(PASSPHRASE);

    const env = await buildEnvelope({
      intent: {
        account: 'maker-a',
        passwordFile: pwFile,
        foundryKeystoresDir: accountDir,
      },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.password.provenance).toBe('flag-password-file');
    expect(env.unlock.attempted).toBe(true);
    expect(env.unlock.succeeded).toBe(true);
    // The explicit account's address — NOT the session's.
    expect(env.unlock.address?.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    expect(env.unlock.address?.toLowerCase()).not.toBe(SESSION_ADDRESS.toLowerCase());
  });

  it('env OSPEX_KEYSTORE_PATH + active session → password.provenance is "none"', async () => {
    await writeFakeSession(SESSION_PK, SESSION_ADDRESS);
    const ks = await writeKeystoreAt(tmpDir, 'envks.json');
    process.env.OSPEX_KEYSTORE_PATH = ks;

    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('env-OSPEX_KEYSTORE_PATH');
    expect(env.resolution.password.provenance).toBe('none');
  });

  it('config.foundryAccount + active session (no config.passwordFile) → password.provenance is "none"', async () => {
    await writeFakeSession(SESSION_PK, SESSION_ADDRESS);
    const accountDir = path.join(tmpDir, 'fdir');
    await writeKeystoreAt(accountDir, 'configmaker');
    const config: CliConfigFile = {
      foundryAccount: 'configmaker',
      foundryKeystoresDir: accountDir,
    };

    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('config-foundryAccount');
    expect(env.resolution.password.provenance).toBe('none');
  });

  it('legacy config.keystorePath + active session → password.provenance IS "session-cache"', async () => {
    // Affirmative case: legacy keystore path is the one where session
    // cache is meant to apply (mirrors loadSigner's path 2 before
    // path 3 readKeystore).
    await writeFakeSession(SESSION_PK, SESSION_ADDRESS);
    const legacy = await writeKeystoreAt(tmpDir, 'legacy.json');

    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config: { keystorePath: legacy },
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('config-keystorePath-legacy');
    expect(env.resolution.password.provenance).toBe('session-cache');
  });

  it('default-legacy + active session → password.provenance IS "session-cache"', async () => {
    await writeFakeSession(SESSION_PK, SESSION_ADDRESS);
    // Don't write a keystore file — exercising the default-legacy path.
    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('default-legacy');
    expect(env.resolution.password.provenance).toBe('session-cache');
  });
});

describe('auth check — Hermes PR 50 blocker #2 (session unlocks even when legacy keystore file missing)', () => {
  it('legacy default keystore missing + session active → unlock via session, no keystore_not_found error', async () => {
    // Real loadSigner reaches path 2 (session) before path 3 reads
    // the keystore file. Previously we hard-failed with
    // keystore_not_found before ever consulting the session.
    await writeFakeSession(SESSION_PK, SESSION_ADDRESS);
    // Intentionally NO keystore at <tmpDir>/keystore.json.

    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('default-legacy');
    expect(env.resolution.keystore.exists).toBe(false);
    expect(env.resolution.password.provenance).toBe('session-cache');
    expect(env.errors.map((e) => e.code)).not.toContain('keystore_not_found');
    expect(env.unlock.attempted).toBe(true);
    expect(env.unlock.succeeded).toBe(true);
    expect(env.unlock.address?.toLowerCase()).toBe(SESSION_ADDRESS.toLowerCase());
    expect(env.ok).toBe(true);
  });

  it('legacy config.keystorePath set to a missing file + session active → unlock via session, no keystore_not_found', async () => {
    // Same as above but with config-pinned legacy path (vs the
    // hard-coded default).
    await writeFakeSession(SESSION_PK, SESSION_ADDRESS);

    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config: { keystorePath: path.join(tmpDir, 'absent.json') },
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('config-keystorePath-legacy');
    expect(env.resolution.keystore.exists).toBe(false);
    expect(env.resolution.password.provenance).toBe('session-cache');
    expect(env.errors.map((e) => e.code)).not.toContain('keystore_not_found');
    expect(env.unlock.succeeded).toBe(true);
    expect(env.ok).toBe(true);
  });

  it('explicit --account that doesn\'t exist + session active → keystore_not_found still errors (session does NOT rescue an explicit path)', async () => {
    // Negative case: the rescue applies only to legacy keystores.
    // Explicit sources must fail loudly when the configured keystore
    // is missing — agents shouldn't silently fall back.
    await writeFakeSession(SESSION_PK, SESSION_ADDRESS);

    const env = await buildEnvelope({
      intent: { account: 'never-existed', foundryKeystoresDir: tmpDir },
      env: process.env,
      config: {},
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('flag-account');
    expect(env.resolution.keystore.exists).toBe(false);
    expect(env.errors.map((e) => e.code)).toContain('keystore_not_found');
    expect(env.unlock.attempted).toBe(false);
    expect(env.ok).toBe(false);
  });
});

describe('auth check — Hermes PR 50 blocker #3 (config expectedAddress vs env OSPEX_KEYSTORE_PATH)', () => {
  it('env OSPEX_KEYSTORE_PATH set + config.expectedAddress pinned to a different wallet → no false address_mismatch', async () => {
    // Repro from Hermes's review: env points at wallet A, config has a
    // stale pin for wallet B. Previously the pin would falsely apply
    // and unlock would emit address_mismatch.
    const ks = await writeKeystoreAt(tmpDir, 'envks.json');
    const pwFile = await writePass(PASSPHRASE);
    process.env.OSPEX_KEYSTORE_PATH = ks;
    const config: CliConfigFile = {
      // A pin from a previous `auth use-foundry` of a different account.
      foundryAccount: 'some-other-account',
      expectedAddress: '0xababababababababababababababababababababab',
    };

    const env = await buildEnvelope({
      intent: { passwordFile: pwFile },
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('env-OSPEX_KEYSTORE_PATH');
    expect(env.resolution.expectedAddress.provenance).toBe('none');
    expect(env.resolution.expectedAddress.value).toBeNull();
    expect(env.unlock.succeeded).toBe(true);
    expect(env.unlock.address?.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    expect(env.errors.map((e) => e.code)).not.toContain('address_mismatch');
    expect(env.ok).toBe(true);
  });

  it('env OSPEX_KEYSTORE_PATH matching config.foundryKeystorePath + pin → pin DOES apply', async () => {
    // Affirmative case: when the env path equals the config-pinned
    // path, the pin is for THIS wallet (it was set by `auth
    // use-foundry --keystore-path <same>`). Mirrors
    // `mergeIntentFromConfig`'s `explicitMatchesConfigKeystorePath`.
    const ks = await writeKeystoreAt(tmpDir, 'pinned.json');
    process.env.OSPEX_KEYSTORE_PATH = ks;
    const config: CliConfigFile = {
      foundryKeystorePath: ks,
      expectedAddress: TEST_ADDRESS.toLowerCase(),
    };

    const env = await buildEnvelope({
      intent: {},
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('env-OSPEX_KEYSTORE_PATH');
    expect(env.resolution.expectedAddress.provenance).toBe('config');
    expect(env.resolution.expectedAddress.value?.toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('flag --keystore-path matching config.foundryKeystorePath + pin → pin DOES apply', async () => {
    const ks = await writeKeystoreAt(tmpDir, 'pinned.json');
    const config: CliConfigFile = {
      foundryKeystorePath: ks,
      expectedAddress: TEST_ADDRESS.toLowerCase(),
    };

    const env = await buildEnvelope({
      intent: { keystorePath: ks },
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.keystore.provenance).toBe('flag-keystore-path');
    expect(env.resolution.expectedAddress.provenance).toBe('config');
  });

  it('flag --keystore-path NOT matching config.foundryKeystorePath + pin → pin does NOT apply', async () => {
    const otherKs = await writeKeystoreAt(tmpDir, 'other.json');
    const config: CliConfigFile = {
      foundryKeystorePath: '/some/configured/path.json',
      expectedAddress: '0xababababababababababababababababababababab',
    };

    const env = await buildEnvelope({
      intent: { keystorePath: otherKs },
      env: process.env,
      config,
      strict: false,
      signChallengeRequested: false,
    });

    expect(env.resolution.expectedAddress.provenance).toBe('none');
  });
});
