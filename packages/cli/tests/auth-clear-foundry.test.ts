/**
 * Tests for `ospex auth clear-foundry` — surgical or wholesale
 * removal of Foundry signer defaults from `~/.ospex/config.json`.
 *
 * Verifies:
 *   - No flags / `--all` clears every foundry-signer field but
 *     leaves the non-signer fields (apiUrl, rpcUrl, chainId) intact.
 *   - Targeted flags clear only the named fields.
 *   - Idempotent when nothing was set.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authClearFoundryCommand } from '../src/commands/auth/clear-foundry.js';
import { loadConfigFile } from '../src/lib/config.js';

let tmpDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-auth-clear-'));
  prevHome = process.env.OSPEX_HOME;
  process.env.OSPEX_HOME = tmpDir;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OSPEX_HOME;
  else process.env.OSPEX_HOME = prevHome;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedConfig(config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'config.json'),
    JSON.stringify(config, null, 2) + '\n',
  );
}

describe('auth clear-foundry — no flags / --all', () => {
  it('clears every foundry-signer field and preserves non-signer fields', async () => {
    await seedConfig({
      apiUrl: 'https://api.ospex.org',
      rpcUrl: 'https://rpc.example',
      chainId: 137,
      foundryAccount: 'maker-a',
      keystorePath: '/some/keystore.json',
      passwordFile: '/etc/pw',
      foundryKeystoresDir: '/home/agent/.foundry/keystores',
      expectedAddress: '0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34',
    });

    await authClearFoundryCommand.parseAsync(['--json'], { from: 'user' });

    const config = await loadConfigFile();
    expect(config.foundryAccount).toBeUndefined();
    expect(config.keystorePath).toBeUndefined();
    expect(config.passwordFile).toBeUndefined();
    expect(config.foundryKeystoresDir).toBeUndefined();
    expect(config.expectedAddress).toBeUndefined();
    // Non-signer fields preserved.
    expect(config.apiUrl).toBe('https://api.ospex.org');
    expect(config.rpcUrl).toBe('https://rpc.example');
    expect(config.chainId).toBe(137);
  });

  it('is idempotent when nothing was set', async () => {
    await seedConfig({ apiUrl: 'https://api.ospex.org' });
    await expect(
      authClearFoundryCommand.parseAsync(['--json'], { from: 'user' }),
    ).resolves.not.toThrow();
    const config = await loadConfigFile();
    expect(config.apiUrl).toBe('https://api.ospex.org');
  });
});

describe('auth clear-foundry — targeted flags', () => {
  it('--expected-address clears only the pin, keeps account + password', async () => {
    await seedConfig({
      foundryAccount: 'maker-a',
      passwordFile: '/etc/pw',
      expectedAddress: '0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34',
    });

    await authClearFoundryCommand.parseAsync(
      ['--expected-address', '--json'],
      { from: 'user' },
    );

    const config = await loadConfigFile();
    expect(config.expectedAddress).toBeUndefined();
    expect(config.foundryAccount).toBe('maker-a');
    expect(config.passwordFile).toBe('/etc/pw');
  });

  it('--password-file clears only the password file pointer', async () => {
    await seedConfig({
      foundryAccount: 'maker-a',
      passwordFile: '/etc/pw',
      expectedAddress: '0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34',
    });

    await authClearFoundryCommand.parseAsync(
      ['--password-file', '--json'],
      { from: 'user' },
    );

    const config = await loadConfigFile();
    expect(config.passwordFile).toBeUndefined();
    expect(config.foundryAccount).toBe('maker-a');
    expect(config.expectedAddress).toBeDefined();
  });

  it('--account clears only the account name', async () => {
    await seedConfig({
      foundryAccount: 'maker-a',
      passwordFile: '/etc/pw',
      expectedAddress: '0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34',
    });

    await authClearFoundryCommand.parseAsync(
      ['--account', '--json'],
      { from: 'user' },
    );

    const config = await loadConfigFile();
    expect(config.foundryAccount).toBeUndefined();
    expect(config.passwordFile).toBe('/etc/pw');
    expect(config.expectedAddress).toBeDefined();
  });
});
