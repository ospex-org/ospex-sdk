/**
 * Tests for `ospex auth use-foundry` — the set-once command that
 * pins a Foundry account + password file (and, by default, the
 * resolved address) as the signer for every future `ospex` write.
 *
 * Verifies:
 *   - Command surface (flag presence, mutual exclusivity).
 *   - Validates by decrypting once → fails fast on wrong passphrase.
 *   - Writes the four config fields (foundryAccount /
 *     keystorePath / passwordFile / foundryKeystoresDir).
 *   - Pins the resolved address by default; `--no-pin-address`
 *     omits the pin.
 *   - Re-running clears the mutually-exclusive slot
 *     (account ↔ keystorePath).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptKeystoreJson } from 'ethers';
import { authUseFoundryCommand } from '../src/commands/auth/use-foundry.js';
import { loadConfigFile } from '../src/lib/config.js';

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-auth-use-'));
  prevEnv = {
    OSPEX_HOME: process.env.OSPEX_HOME,
    OSPEX_FOUNDRY_KEYSTORES_DIR: process.env.OSPEX_FOUNDRY_KEYSTORES_DIR,
    FOUNDRY_DIR: process.env.FOUNDRY_DIR,
  };
  process.env.OSPEX_HOME = tmpDir;
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

describe('auth use-foundry — command surface', () => {
  it('exposes the four args + flags documented in the spec', () => {
    const help = authUseFoundryCommand.helpInformation();
    expect(help).toMatch(/--account/);
    expect(help).toMatch(/--keystore-path/);
    expect(help).toMatch(/--password-file/);
    expect(help).toMatch(/--foundry-keystores-dir/);
    expect(help).toMatch(/--no-pin-address|pin-address/);
    expect(help).toMatch(/--json/);
  });
});

describe('auth use-foundry — happy path with --account', () => {
  it('validates, writes config, pins address by default', async () => {
    await writeKeystoreFile('maker-a');
    const pwPath = await writePassFile(PASSPHRASE);

    await authUseFoundryCommand.parseAsync(
      [
        '--account',
        'maker-a',
        '--password-file',
        pwPath,
        '--foundry-keystores-dir',
        tmpDir,
        '--json',
      ],
      { from: 'user' },
    );

    const config = await loadConfigFile();
    expect(config.foundryAccount).toBe('maker-a');
    expect(config.passwordFile).toBe(pwPath);
    expect(config.foundryKeystoresDir).toBe(tmpDir);
    expect(config.expectedAddress?.toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
    expect(config.keystorePath).toBeUndefined();
  });

  it('--no-pin-address omits expectedAddress', async () => {
    await writeKeystoreFile('maker-b');
    const pwPath = await writePassFile(PASSPHRASE);

    await authUseFoundryCommand.parseAsync(
      [
        '--account',
        'maker-b',
        '--password-file',
        pwPath,
        '--foundry-keystores-dir',
        tmpDir,
        '--no-pin-address',
        '--json',
      ],
      { from: 'user' },
    );

    const config = await loadConfigFile();
    expect(config.foundryAccount).toBe('maker-b');
    expect(config.passwordFile).toBe(pwPath);
    expect(config.expectedAddress).toBeUndefined();
  });
});

describe('auth use-foundry — happy path with --keystore-path', () => {
  it('writes foundryKeystorePath (NOT legacy keystorePath), clears any stale foundryAccount', async () => {
    // Pre-seed config with a stale foundryAccount and a legacy
    // `keystorePath` from `ospex init` to verify:
    //   - foundryAccount is cleared (mode switch).
    //   - The new sticky-signer path goes into `foundryKeystorePath`,
    //     NOT the legacy `keystorePath` slot.
    //   - Legacy `keystorePath` is preserved (set by `ospex init`).
    const home = tmpDir;
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({
        foundryAccount: 'stale',
        passwordFile: '/old/pw',
        keystorePath: '/legacy/init-set.json',
      }) + '\n',
    );

    const ksPath = await writeKeystoreFile('explicit.json');
    const pwPath = await writePassFile(PASSPHRASE);

    await authUseFoundryCommand.parseAsync(
      [
        '--keystore-path',
        ksPath,
        '--password-file',
        pwPath,
        '--json',
      ],
      { from: 'user' },
    );

    const config = await loadConfigFile();
    // New sticky-signer slot got the new value.
    expect(config.foundryKeystorePath).toBe(ksPath);
    // Stale foundryAccount cleared (mutually exclusive with foundryKeystorePath).
    expect(config.foundryAccount).toBeUndefined();
    // Legacy `keystorePath` from a prior `ospex init` is preserved.
    expect(config.keystorePath).toBe('/legacy/init-set.json');
    expect(config.passwordFile).toBe(pwPath);
    expect(config.expectedAddress?.toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });
});

describe('auth use-foundry — review round 2 (stale foundryKeystoresDir)', () => {
  it('replaces a stale foundryKeystoresDir with the dir actually used during validation', async () => {
    // Seed config with a stale empty dir. Real keystore lives elsewhere
    // (in tmpDir/real). User re-runs use-foundry pointing at the real
    // dir via env (no --foundry-keystores-dir flag). Before the fix,
    // the stale dir survived in config and broke the next write.
    const staleEmptyDir = path.join(tmpDir, 'empty-stale');
    await fs.mkdir(staleEmptyDir, { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.ospex'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({ foundryKeystoresDir: staleEmptyDir }) + '\n',
    );

    const realDir = path.join(tmpDir, 'real');
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, 'maker-a'), keystoreJson, 'utf8');
    const pwPath = await writePassFile(PASSPHRASE);
    process.env.OSPEX_FOUNDRY_KEYSTORES_DIR = realDir;

    await authUseFoundryCommand.parseAsync(
      ['--account', 'maker-a', '--password-file', pwPath, '--json'],
      { from: 'user' },
    );

    const config = await loadConfigFile();
    // The stale dir is replaced with the effective dir used during
    // validation (the real dir from the env var).
    expect(config.foundryKeystoresDir).toBe(realDir);
    expect(config.foundryAccount).toBe('maker-a');
    expect(config.expectedAddress?.toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });

  it('--foundry-keystores-dir flag writes the flag value (independent of env)', async () => {
    const flagDir = path.join(tmpDir, 'flag-dir');
    await fs.mkdir(flagDir, { recursive: true });
    await fs.writeFile(path.join(flagDir, 'maker-a'), keystoreJson, 'utf8');
    const pwPath = await writePassFile(PASSPHRASE);

    // Env points elsewhere — flag should beat env, and the flag value
    // should be persisted.
    const envDir = path.join(tmpDir, 'env-dir');
    await fs.mkdir(envDir, { recursive: true });
    process.env.OSPEX_FOUNDRY_KEYSTORES_DIR = envDir;

    await authUseFoundryCommand.parseAsync(
      [
        '--account',
        'maker-a',
        '--password-file',
        pwPath,
        '--foundry-keystores-dir',
        flagDir,
        '--json',
      ],
      { from: 'user' },
    );

    const config = await loadConfigFile();
    expect(config.foundryKeystoresDir).toBe(flagDir);
  });

  it('--keystore-path mode clears any stale foundryKeystoresDir', async () => {
    // Path mode doesn't use a Foundry dir. Stale --account-mode
    // values shouldn't survive a switch to path mode.
    await fs.writeFile(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        foundryAccount: 'stale-account',
        foundryKeystoresDir: '/stale/dir',
        passwordFile: '/stale/pw',
      }) + '\n',
    );

    const ksPath = await writeKeystoreFile('explicit.json');
    const pwPath = await writePassFile(PASSPHRASE);

    await authUseFoundryCommand.parseAsync(
      ['--keystore-path', ksPath, '--password-file', pwPath, '--json'],
      { from: 'user' },
    );

    const config = await loadConfigFile();
    expect(config.foundryKeystorePath).toBe(ksPath);
    expect(config.foundryAccount).toBeUndefined();
    expect(config.foundryKeystoresDir).toBeUndefined();
  });

  it('after use-foundry, a follow-up loadSigner() resolves against the same dir validation used', async () => {
    // The full agent flow: set env, run use-foundry (which persists
    // env's dir into config), clear env (next shell), call loadSigner.
    // Without the fix, this would fail because the stale config dir
    // would survive use-foundry and config would be unusable in the
    // next shell.
    const realDir = path.join(tmpDir, 'real');
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, 'maker-a'), keystoreJson, 'utf8');
    const pwPath = await writePassFile(PASSPHRASE);

    // Initial setup uses env to point at the real dir.
    process.env.OSPEX_FOUNDRY_KEYSTORES_DIR = realDir;
    await authUseFoundryCommand.parseAsync(
      ['--account', 'maker-a', '--password-file', pwPath, '--json'],
      { from: 'user' },
    );

    // Simulate a fresh shell — env is no longer set.
    delete process.env.OSPEX_FOUNDRY_KEYSTORES_DIR;

    // loadSigner must still work using only the persisted config.
    const { loadSigner } = await import('../src/lib/client.js');
    const signer = await loadSigner();
    expect((await signer.getAddress()).toLowerCase()).toBe(
      TEST_ADDRESS.toLowerCase(),
    );
  });
});

describe('auth use-foundry — validation errors', () => {
  it('rejects --account + --keystore-path together', async () => {
    await writeKeystoreFile('maker-c');
    const pwPath = await writePassFile(PASSPHRASE);
    await expect(
      authUseFoundryCommand.parseAsync(
        [
          '--account',
          'maker-c',
          '--keystore-path',
          path.join(tmpDir, 'whatever.json'),
          '--password-file',
          pwPath,
          '--foundry-keystores-dir',
          tmpDir,
          '--json',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow();
  });

  it('rejects when neither --account nor --keystore-path is set', async () => {
    const pwPath = await writePassFile(PASSPHRASE);
    await expect(
      authUseFoundryCommand.parseAsync(
        ['--password-file', pwPath, '--json'],
        { from: 'user' },
      ),
    ).rejects.toThrow();
  });

  it('fails fast on wrong passphrase (no config write)', async () => {
    await writeKeystoreFile('maker-d');
    const pwPath = await writePassFile('not-the-right-passphrase');
    await expect(
      authUseFoundryCommand.parseAsync(
        [
          '--account',
          'maker-d',
          '--password-file',
          pwPath,
          '--foundry-keystores-dir',
          tmpDir,
          '--json',
        ],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({ reason: 'decryption_failed' });

    // Config must remain unchanged.
    const config = await loadConfigFile();
    expect(config.foundryAccount).toBeUndefined();
    expect(config.passwordFile).toBeUndefined();
  });
});
