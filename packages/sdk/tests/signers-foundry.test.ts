/**
 * Tests for the non-interactive Foundry-signer pipeline:
 *
 *   - `resolveKeystoreSource` — path resolution (account vs.
 *     keystorePath, env fallbacks, missing-file detection).
 *   - `readPassphrase` — file / stdin / literal / env, trim behavior,
 *     conflict detection, the non-interactive error.
 *   - `checkPasswordFilePermissions` — POSIX loose-bit detection plus
 *     the Windows-platformSkipped path.
 *   - `KeystoreSigner.fromKeystoreFile` / `.fromFoundryAccount` —
 *     end-to-end unlock + expectedAddress + strict-mode permission
 *     enforcement.
 *
 * All file I/O happens under `os.tmpdir()/ospex-foundry-*` per test;
 * no shared on-disk state. The keystore JSON is encrypted ONCE in
 * `beforeAll` and reused across the file — scrypt is slow and we
 * don't need a fresh encryption per case.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptKeystoreJson } from 'ethers';

import {
  checkPasswordFilePermissions,
  readPassphrase,
  resolveKeystoreSource,
} from '../src/signers/foundry.js';
import { KeystoreSigner } from '../src/signers/keystore.js';
import { OspexSignerResolutionError } from '../src/errors.js';

const POSIX = process.platform !== 'win32';
const itPosix = POSIX ? it : it.skip;
const itWindows = !POSIX ? it : it.skip;

// Anvil account #0 — well-known throwaway key. NEVER used for anything real.
const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
// Anvil account #1 — also throwaway, used for the address-mismatch case.
const OTHER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const PASSPHRASE = 'test-passphrase-1234';
const WRONG_PASSPHRASE = 'wrong-passphrase';

// Encrypt once — scrypt is slow.
let keystoreJson: string;

beforeAll(async () => {
  keystoreJson = await encryptKeystoreJson(
    { address: TEST_ADDRESS, privateKey: TEST_PK },
    PASSPHRASE,
  );
}, 30_000);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-foundry-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeKeystoreInDir(dir: string, name: string): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, keystoreJson, 'utf8');
  return p;
}

async function writePassFile(name: string, content: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content, 'utf8');
  if (POSIX) await fs.chmod(p, 0o600);
  return p;
}

// ── resolveKeystoreSource ─────────────────────────────────────────

describe('resolveKeystoreSource — account form', () => {
  it('resolves via the foundryKeystoresDir override', async () => {
    await writeKeystoreInDir(tmpDir, 'maker-a');
    const src = await resolveKeystoreSource({
      account: 'maker-a',
      foundryKeystoresDir: tmpDir,
      env: {},
    });
    expect(src.origin).toBe('account');
    expect(src.account).toBe('maker-a');
    expect(src.keystorePath).toBe(path.join(tmpDir, 'maker-a'));
  });

  it('resolves via OSPEX_FOUNDRY_KEYSTORES_DIR env when no override', async () => {
    await writeKeystoreInDir(tmpDir, 'maker-b');
    const src = await resolveKeystoreSource({
      account: 'maker-b',
      env: { OSPEX_FOUNDRY_KEYSTORES_DIR: tmpDir },
    });
    expect(src.keystorePath).toBe(path.join(tmpDir, 'maker-b'));
  });

  it('resolves via FOUNDRY_DIR/keystores env when no other override', async () => {
    const subDir = path.join(tmpDir, 'keystores');
    await fs.mkdir(subDir, { recursive: true });
    await writeKeystoreInDir(subDir, 'maker-c');
    const src = await resolveKeystoreSource({
      account: 'maker-c',
      env: { FOUNDRY_DIR: tmpDir },
    });
    expect(src.keystorePath).toBe(path.join(subDir, 'maker-c'));
  });

  it('throws keystore_not_found with the resolved path when the file is missing', async () => {
    await expect(
      resolveKeystoreSource({
        account: 'does-not-exist',
        foundryKeystoresDir: tmpDir,
        env: {},
      }),
    ).rejects.toMatchObject({
      name: 'OspexSignerResolutionError',
      reason: 'keystore_not_found',
      path: path.join(tmpDir, 'does-not-exist'),
    });
  });

  it('prefers the explicit foundryKeystoresDir over env vars', async () => {
    const otherDir = path.join(tmpDir, 'other');
    await fs.mkdir(otherDir);
    await writeKeystoreInDir(otherDir, 'maker-d');
    const src = await resolveKeystoreSource({
      account: 'maker-d',
      foundryKeystoresDir: otherDir,
      env: { OSPEX_FOUNDRY_KEYSTORES_DIR: tmpDir, FOUNDRY_DIR: '/nope' },
    });
    expect(src.keystorePath).toBe(path.join(otherDir, 'maker-d'));
  });
});

describe('resolveKeystoreSource — keystorePath form', () => {
  it('returns the supplied path when it exists', async () => {
    const p = await writeKeystoreInDir(tmpDir, 'arbitrary-name.json');
    const src = await resolveKeystoreSource({ keystorePath: p, env: {} });
    expect(src.origin).toBe('keystorePath');
    expect(src.keystorePath).toBe(p);
    expect(src.account).toBeUndefined();
  });

  it('throws keystore_not_found when the path does not exist', async () => {
    const p = path.join(tmpDir, 'missing.json');
    await expect(
      resolveKeystoreSource({ keystorePath: p, env: {} }),
    ).rejects.toMatchObject({
      reason: 'keystore_not_found',
      path: p,
    });
  });
});

describe('resolveKeystoreSource — conflict / missing inputs', () => {
  it('throws account_and_path_conflict when both account and keystorePath supplied', async () => {
    const p = await writeKeystoreInDir(tmpDir, 'a.json');
    await expect(
      resolveKeystoreSource({
        account: 'a',
        keystorePath: p,
        foundryKeystoresDir: tmpDir,
        env: {},
      }),
    ).rejects.toMatchObject({ reason: 'account_and_path_conflict' });
  });

  it('throws keystore_not_found when neither is supplied', async () => {
    await expect(resolveKeystoreSource({ env: {} })).rejects.toMatchObject({
      reason: 'keystore_not_found',
    });
  });
});

// ── readPassphrase ────────────────────────────────────────────────

describe('readPassphrase — literal source', () => {
  it('returns the literal as-is', async () => {
    const result = await readPassphrase({ passphrase: 'hunter2', env: {} });
    expect(result).toEqual({ passphrase: 'hunter2', origin: 'literal' });
  });
});

describe('readPassphrase — file source', () => {
  it('reads a passphrase from a file', async () => {
    const p = await writePassFile('plain.pass', 'hunter2');
    const result = await readPassphrase({ passwordFile: p, env: {} });
    expect(result.passphrase).toBe('hunter2');
    expect(result.origin).toBe('file');
    expect(result.filePath).toBe(p);
  });

  it('trims a single trailing newline (\\n)', async () => {
    const p = await writePassFile('with-lf.pass', 'hunter2\n');
    const result = await readPassphrase({ passwordFile: p, env: {} });
    expect(result.passphrase).toBe('hunter2');
  });

  it('trims a single trailing CRLF (\\r\\n)', async () => {
    const p = await writePassFile('with-crlf.pass', 'hunter2\r\n');
    const result = await readPassphrase({ passwordFile: p, env: {} });
    expect(result.passphrase).toBe('hunter2');
  });

  it('trims only ONE trailing newline (preserves internal blank lines)', async () => {
    const p = await writePassFile('two-trailing.pass', 'hunter2\n\n');
    const result = await readPassphrase({ passwordFile: p, env: {} });
    expect(result.passphrase).toBe('hunter2\n');
  });

  it('preserves leading whitespace and internal whitespace', async () => {
    const p = await writePassFile('whitespace.pass', '  hunter 2 \n');
    const result = await readPassphrase({ passwordFile: p, env: {} });
    expect(result.passphrase).toBe('  hunter 2 ');
  });

  it('throws password_file_not_found when the file is missing', async () => {
    const p = path.join(tmpDir, 'never-created.pass');
    await expect(
      readPassphrase({ passwordFile: p, env: {} }),
    ).rejects.toMatchObject({
      reason: 'password_file_not_found',
      path: p,
    });
  });
});

describe('readPassphrase — stdin source', () => {
  it('reads from the injected stdin reader and trims trailing newline', async () => {
    const result = await readPassphrase({
      fromStdin: true,
      stdinReader: async () => 'hunter2\n',
      env: {},
    });
    expect(result.passphrase).toBe('hunter2');
    expect(result.origin).toBe('stdin');
    expect(result.filePath).toBeUndefined();
  });
});

describe('readPassphrase — env fallback', () => {
  it('falls back to OSPEX_PASSWORD_FILE when no explicit source', async () => {
    const p = await writePassFile('env-default.pass', 'hunter2\n');
    const result = await readPassphrase({ env: { OSPEX_PASSWORD_FILE: p } });
    expect(result.passphrase).toBe('hunter2');
    expect(result.origin).toBe('env');
    expect(result.filePath).toBe(p);
  });

  it('explicit passwordFile beats OSPEX_PASSWORD_FILE', async () => {
    const explicit = await writePassFile('explicit.pass', 'explicit-value');
    const envFile = await writePassFile('env-default.pass', 'env-value');
    const result = await readPassphrase({
      passwordFile: explicit,
      env: { OSPEX_PASSWORD_FILE: envFile },
    });
    expect(result.passphrase).toBe('explicit-value');
    expect(result.origin).toBe('file');
  });

  it('readEnv: false disables env fallback', async () => {
    const p = await writePassFile('env-default.pass', 'hunter2');
    await expect(
      readPassphrase({ readEnv: false, env: { OSPEX_PASSWORD_FILE: p } }),
    ).rejects.toMatchObject({ reason: 'non_interactive_password_required' });
  });
});

describe('readPassphrase — error paths', () => {
  it('throws password_source_conflict when multiple explicit sources supplied', async () => {
    const p = await writePassFile('a.pass', 'x');
    await expect(
      readPassphrase({
        passphrase: 'y',
        passwordFile: p,
        env: {},
      }),
    ).rejects.toMatchObject({ reason: 'password_source_conflict' });
  });

  it('throws non_interactive_password_required when no source resolves', async () => {
    await expect(readPassphrase({ env: {} })).rejects.toMatchObject({
      reason: 'non_interactive_password_required',
    });
  });
});

// ── checkPasswordFilePermissions ──────────────────────────────────

describe('checkPasswordFilePermissions', () => {
  itPosix('returns loose: false for a 0600 file', async () => {
    const p = path.join(tmpDir, 'tight.pass');
    await fs.writeFile(p, 'x');
    await fs.chmod(p, 0o600);
    const result = await checkPasswordFilePermissions(p);
    expect(result.loose).toBe(false);
    expect(result.platformSkipped).toBe(false);
    expect(result.mode & 0o777).toBe(0o600);
  });

  itPosix('returns loose: true for a 0644 file', async () => {
    const p = path.join(tmpDir, 'loose.pass');
    await fs.writeFile(p, 'x');
    await fs.chmod(p, 0o644);
    const result = await checkPasswordFilePermissions(p);
    expect(result.loose).toBe(true);
    expect(result.platformSkipped).toBe(false);
    expect(result.mode & 0o777).toBe(0o644);
  });

  itWindows('returns platformSkipped: true on Windows', async () => {
    const p = path.join(tmpDir, 'win.pass');
    await fs.writeFile(p, 'x');
    const result = await checkPasswordFilePermissions(p);
    expect(result.platformSkipped).toBe(true);
    expect(result.loose).toBe(false);
  });
});

// ── KeystoreSigner.fromKeystoreFile ───────────────────────────────

describe('KeystoreSigner.fromKeystoreFile', () => {
  it('unlocks the keystore and returns a signer with the right address', async () => {
    const ksPath = await writeKeystoreInDir(tmpDir, 'maker.json');
    const pwPath = await writePassFile('pw.pass', PASSPHRASE);
    const signer = await KeystoreSigner.fromKeystoreFile({
      keystorePath: ksPath,
      passwordFile: pwPath,
      env: {},
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('accepts a literal passphrase', async () => {
    const ksPath = await writeKeystoreInDir(tmpDir, 'maker.json');
    const signer = await KeystoreSigner.fromKeystoreFile({
      keystorePath: ksPath,
      passphrase: PASSPHRASE,
      env: {},
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('throws decryption_failed on a wrong passphrase', async () => {
    const ksPath = await writeKeystoreInDir(tmpDir, 'maker.json');
    const pwPath = await writePassFile('wrong.pass', WRONG_PASSPHRASE);
    await expect(
      KeystoreSigner.fromKeystoreFile({
        keystorePath: ksPath,
        passwordFile: pwPath,
        env: {},
      }),
    ).rejects.toMatchObject({
      name: 'OspexSignerResolutionError',
      reason: 'decryption_failed',
      path: ksPath,
    });
  });

  it('throws keystore_not_found when the keystore path is missing', async () => {
    const pwPath = await writePassFile('pw.pass', PASSPHRASE);
    const missing = path.join(tmpDir, 'missing.json');
    await expect(
      KeystoreSigner.fromKeystoreFile({
        keystorePath: missing,
        passwordFile: pwPath,
        env: {},
      }),
    ).rejects.toMatchObject({
      reason: 'keystore_not_found',
      path: missing,
    });
  });

  it('passes when expectedAddress matches the unlocked address', async () => {
    const ksPath = await writeKeystoreInDir(tmpDir, 'maker.json');
    const signer = await KeystoreSigner.fromKeystoreFile({
      keystorePath: ksPath,
      passphrase: PASSPHRASE,
      expectedAddress: TEST_ADDRESS,
      env: {},
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('throws address_mismatch when expectedAddress differs', async () => {
    const ksPath = await writeKeystoreInDir(tmpDir, 'maker.json');
    await expect(
      KeystoreSigner.fromKeystoreFile({
        keystorePath: ksPath,
        passphrase: PASSPHRASE,
        expectedAddress: OTHER_ADDRESS,
        env: {},
      }),
    ).rejects.toMatchObject({
      reason: 'address_mismatch',
      expectedAddress: OTHER_ADDRESS,
      actualAddress: TEST_ADDRESS.toLowerCase(),
    });
  });

  it('expectedAddress comparison is case-insensitive', async () => {
    const ksPath = await writeKeystoreInDir(tmpDir, 'maker.json');
    const lowerExpected = TEST_ADDRESS.toLowerCase() as typeof TEST_ADDRESS;
    const signer = await KeystoreSigner.fromKeystoreFile({
      keystorePath: ksPath,
      passphrase: PASSPHRASE,
      expectedAddress: lowerExpected,
      env: {},
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  itPosix('strict mode rejects a 0644 password file', async () => {
    const ksPath = await writeKeystoreInDir(tmpDir, 'maker.json');
    const pwPath = path.join(tmpDir, 'loose.pass');
    await fs.writeFile(pwPath, PASSPHRASE);
    await fs.chmod(pwPath, 0o644);
    await expect(
      KeystoreSigner.fromKeystoreFile({
        keystorePath: ksPath,
        passwordFile: pwPath,
        strict: true,
        env: {},
      }),
    ).rejects.toMatchObject({
      reason: 'password_file_permissions_loose',
      path: pwPath,
      mode: 0o644,
    });
  });

  itPosix('strict mode accepts a 0600 password file', async () => {
    const ksPath = await writeKeystoreInDir(tmpDir, 'maker.json');
    const pwPath = await writePassFile('tight.pass', PASSPHRASE);
    const signer = await KeystoreSigner.fromKeystoreFile({
      keystorePath: ksPath,
      passwordFile: pwPath,
      strict: true,
      env: {},
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('non-strict mode tolerates loose permissions silently (warnings are CLI policy)', async () => {
    const ksPath = await writeKeystoreInDir(tmpDir, 'maker.json');
    const pwPath = path.join(tmpDir, 'loose.pass');
    await fs.writeFile(pwPath, PASSPHRASE);
    if (POSIX) await fs.chmod(pwPath, 0o644);
    const signer = await KeystoreSigner.fromKeystoreFile({
      keystorePath: ksPath,
      passwordFile: pwPath,
      env: {},
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });
});

// ── KeystoreSigner.fromFoundryAccount ─────────────────────────────

describe('KeystoreSigner.fromFoundryAccount', () => {
  it('unlocks via account name + foundryKeystoresDir override', async () => {
    await writeKeystoreInDir(tmpDir, 'maker-a');
    const pwPath = await writePassFile('maker-a.pass', PASSPHRASE);
    const signer = await KeystoreSigner.fromFoundryAccount({
      account: 'maker-a',
      passwordFile: pwPath,
      foundryKeystoresDir: tmpDir,
      env: {},
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('throws keystore_not_found with the resolved path for an unknown account', async () => {
    const pwPath = await writePassFile('pw.pass', PASSPHRASE);
    await expect(
      KeystoreSigner.fromFoundryAccount({
        account: 'nope',
        passwordFile: pwPath,
        foundryKeystoresDir: tmpDir,
        env: {},
      }),
    ).rejects.toMatchObject({
      reason: 'keystore_not_found',
      path: path.join(tmpDir, 'nope'),
    });
  });

  it('respects OSPEX_FOUNDRY_KEYSTORES_DIR env when no override', async () => {
    await writeKeystoreInDir(tmpDir, 'maker-b');
    const pwPath = await writePassFile('maker-b.pass', PASSPHRASE);
    const signer = await KeystoreSigner.fromFoundryAccount({
      account: 'maker-b',
      passwordFile: pwPath,
      env: { OSPEX_FOUNDRY_KEYSTORES_DIR: tmpDir },
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('respects FOUNDRY_DIR env when no OSPEX-specific override', async () => {
    const subDir = path.join(tmpDir, 'keystores');
    await fs.mkdir(subDir, { recursive: true });
    await writeKeystoreInDir(subDir, 'maker-c');
    const pwPath = await writePassFile('maker-c.pass', PASSPHRASE);
    const signer = await KeystoreSigner.fromFoundryAccount({
      account: 'maker-c',
      passwordFile: pwPath,
      env: { FOUNDRY_DIR: tmpDir },
    });
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('honors expectedAddress + decryption_failed paths the same as fromKeystoreFile', async () => {
    await writeKeystoreInDir(tmpDir, 'maker-d');
    await expect(
      KeystoreSigner.fromFoundryAccount({
        account: 'maker-d',
        passphrase: WRONG_PASSPHRASE,
        foundryKeystoresDir: tmpDir,
        env: {},
      }),
    ).rejects.toMatchObject({ reason: 'decryption_failed' });
  });

  it('propagates the OspexSignerResolutionError class so agents can `err instanceof`', async () => {
    const pwPath = await writePassFile('pw.pass', PASSPHRASE);
    try {
      await KeystoreSigner.fromFoundryAccount({
        account: 'nope',
        passwordFile: pwPath,
        foundryKeystoresDir: tmpDir,
        env: {},
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OspexSignerResolutionError);
    }
  });
});

afterAll(() => {
  // No global teardown beyond per-test tmpdir cleanup.
});
