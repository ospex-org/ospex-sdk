import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getConfigPath,
  getKeystorePath,
  getOspexHome,
  getSessionPath,
  loadConfigFile,
  resolveCliConfig,
  saveConfigFile,
} from '../src/lib/config.js';

let tmpDir: string;
const ENV_KEYS = [
  'OSPEX_HOME',
  'OSPEX_API_URL',
  'OSPEX_SUPABASE_URL',
  'OSPEX_SUPABASE_ANON_KEY',
  'OSPEX_KEYSTORE_PATH',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-cli-test-'));
  process.env.OSPEX_HOME = tmpDir;
  delete process.env.OSPEX_API_URL;
  delete process.env.OSPEX_SUPABASE_URL;
  delete process.env.OSPEX_SUPABASE_ANON_KEY;
  delete process.env.OSPEX_KEYSTORE_PATH;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('CLI config', () => {
  it('OSPEX_HOME overrides the home directory', () => {
    expect(getOspexHome()).toBe(tmpDir);
    expect(getConfigPath()).toBe(path.join(tmpDir, 'config.json'));
    expect(getKeystorePath()).toBe(path.join(tmpDir, 'keystore.json'));
    expect(getSessionPath()).toBe(path.join(tmpDir, 'session'));
  });

  it('OSPEX_KEYSTORE_PATH overrides getKeystorePath even with OSPEX_HOME set', () => {
    const override = path.join(tmpDir, 'foundry-keystore.json');
    process.env.OSPEX_KEYSTORE_PATH = override;
    expect(getKeystorePath()).toBe(override);
    // Other paths still derived from OSPEX_HOME — only the keystore is redirected.
    expect(getConfigPath()).toBe(path.join(tmpDir, 'config.json'));
    expect(getSessionPath()).toBe(path.join(tmpDir, 'session'));
  });

  it('OSPEX_KEYSTORE_PATH treats empty string as unset', () => {
    process.env.OSPEX_KEYSTORE_PATH = '';
    expect(getKeystorePath()).toBe(path.join(tmpDir, 'keystore.json'));
  });

  it('loadConfigFile returns {} when the file does not exist', async () => {
    const config = await loadConfigFile();
    expect(config).toEqual({});
  });

  it('save → load round-trips', async () => {
    await saveConfigFile({ apiUrl: 'https://custom.api', supabaseUrl: 'https://x.supabase.co' });
    const loaded = await loadConfigFile();
    expect(loaded).toEqual({ apiUrl: 'https://custom.api', supabaseUrl: 'https://x.supabase.co' });
  });

  it('resolveCliConfig prefers env vars over the config file', async () => {
    await saveConfigFile({ apiUrl: 'https://from-file' });
    process.env.OSPEX_API_URL = 'https://from-env';
    const resolved = await resolveCliConfig();
    expect(resolved.apiUrl).toBe('https://from-env');
  });

  it('resolveCliConfig falls back to the config file when env is unset', async () => {
    await saveConfigFile({ apiUrl: 'https://from-file' });
    const resolved = await resolveCliConfig();
    expect(resolved.apiUrl).toBe('https://from-file');
  });

  it('loadConfigFile ignores unknown fields', async () => {
    await fs.writeFile(getConfigPath(), JSON.stringify({ apiUrl: 'x', extra: 'ignored' }));
    const loaded = await loadConfigFile();
    expect(loaded).toEqual({ apiUrl: 'x' });
  });
});
