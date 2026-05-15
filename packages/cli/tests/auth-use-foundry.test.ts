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
  it('writes keystorePath, clears any stale foundryAccount', async () => {
    // Pre-seed config with a stale foundryAccount to verify the
    // command clears it when switching modes.
    const home = tmpDir;
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ foundryAccount: 'stale', passwordFile: '/old/pw' }) + '\n',
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
    expect(config.keystorePath).toBe(ksPath);
    expect(config.foundryAccount).toBeUndefined();
    expect(config.passwordFile).toBe(pwPath);
    expect(config.expectedAddress?.toLowerCase()).toBe(
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
