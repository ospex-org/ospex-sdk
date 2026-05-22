import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  expandTilde,
  getConfigPath,
  getKeystorePath,
  getOspexHome,
  getSessionPath,
  loadConfigFile,
  resolveCliConfig,
  resolveCliConfigDetailed,
  saveConfigFile,
} from '../src/lib/config.js';

let tmpDir: string;
const ENV_KEYS = [
  'OSPEX_HOME',
  'OSPEX_API_URL',
  'OSPEX_KEYSTORE_PATH',
  'OSPEX_RPC_URL',
  'OSPEX_CHAIN_ID',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-cli-test-'));
  process.env.OSPEX_HOME = tmpDir;
  delete process.env.OSPEX_API_URL;
  delete process.env.OSPEX_KEYSTORE_PATH;
  delete process.env.OSPEX_RPC_URL;
  delete process.env.OSPEX_CHAIN_ID;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('CLI config', () => {
  it('OSPEX_HOME overrides the home directory', async () => {
    expect(getOspexHome()).toBe(tmpDir);
    expect(getConfigPath()).toBe(path.join(tmpDir, 'config.json'));
    expect(await getKeystorePath()).toBe(path.join(tmpDir, 'keystore.json'));
    expect(getSessionPath()).toBe(path.join(tmpDir, 'session'));
  });

  it('OSPEX_KEYSTORE_PATH overrides getKeystorePath even with OSPEX_HOME set', async () => {
    const override = path.join(tmpDir, 'foundry-keystore.json');
    process.env.OSPEX_KEYSTORE_PATH = override;
    expect(await getKeystorePath()).toBe(override);
    // Other paths still derived from OSPEX_HOME — only the keystore is redirected.
    expect(getConfigPath()).toBe(path.join(tmpDir, 'config.json'));
    expect(getSessionPath()).toBe(path.join(tmpDir, 'session'));
  });

  it('OSPEX_KEYSTORE_PATH treats empty string as unset', async () => {
    process.env.OSPEX_KEYSTORE_PATH = '';
    expect(await getKeystorePath()).toBe(path.join(tmpDir, 'keystore.json'));
  });

  it('config-file keystorePath is used when env var is unset', async () => {
    const stored = path.join(tmpDir, 'foundry-store-from-config.json');
    await saveConfigFile({ keystorePath: stored });
    expect(await getKeystorePath()).toBe(stored);
  });

  it('OSPEX_KEYSTORE_PATH env var overrides config-file keystorePath', async () => {
    const fromConfig = path.join(tmpDir, 'from-config.json');
    const fromEnv = path.join(tmpDir, 'from-env.json');
    await saveConfigFile({ keystorePath: fromConfig });
    process.env.OSPEX_KEYSTORE_PATH = fromEnv;
    expect(await getKeystorePath()).toBe(fromEnv);
  });

  it('config-file keystorePath of empty string falls back to default', async () => {
    await saveConfigFile({ keystorePath: '' });
    expect(await getKeystorePath()).toBe(path.join(tmpDir, 'keystore.json'));
  });

  it('config-file keystorePath expands a leading ~/', async () => {
    await saveConfigFile({ keystorePath: '~/.foundry/keystores/test' });
    expect(await getKeystorePath()).toBe(
      path.join(os.homedir(), '.foundry/keystores/test'),
    );
  });

  it('OSPEX_KEYSTORE_PATH env var expands a leading ~/', async () => {
    process.env.OSPEX_KEYSTORE_PATH = '~/.foundry/keystores/from-env';
    expect(await getKeystorePath()).toBe(
      path.join(os.homedir(), '.foundry/keystores/from-env'),
    );
  });

  it('expandTilde leaves absolute and non-tilde paths alone', () => {
    expect(expandTilde('/abs/path')).toBe('/abs/path');
    expect(expandTilde('relative/path')).toBe('relative/path');
    expect(expandTilde('C:/Windows/path')).toBe('C:/Windows/path');
    // Embedded tildes are not expanded — only leading ones.
    expect(expandTilde('/path/with/~/inside')).toBe('/path/with/~/inside');
  });

  it('expandTilde resolves bare ~ to homedir', () => {
    expect(expandTilde('~')).toBe(os.homedir());
  });

  it('loadConfigFile returns {} when the file does not exist', async () => {
    const config = await loadConfigFile();
    expect(config).toEqual({});
  });

  it('save → load round-trips', async () => {
    await saveConfigFile({ apiUrl: 'https://custom.api', rpcUrl: 'https://rpc.example' });
    const loaded = await loadConfigFile();
    expect(loaded).toEqual({ apiUrl: 'https://custom.api', rpcUrl: 'https://rpc.example' });
  });

  it('save → load round-trips keystorePath', async () => {
    await saveConfigFile({ keystorePath: '/abs/path/to/keystore' });
    const loaded = await loadConfigFile();
    expect(loaded).toEqual({ keystorePath: '/abs/path/to/keystore' });
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

  // PR 3: per-field provenance resolver. Same precedence as
  // `resolveCliConfig` (env > config > default) but also reports
  // WHICH source supplied the value so the doctor envelope can
  // explain "why is apiUrl pointed at staging?".
  describe('resolveCliConfigDetailed', () => {
    it('apiUrl: env wins over config', async () => {
      await saveConfigFile({ apiUrl: 'https://from-file' });
      process.env.OSPEX_API_URL = 'https://from-env';
      const r = await resolveCliConfigDetailed();
      expect(r.apiUrl).toEqual({ value: 'https://from-env', source: 'env-OSPEX_API_URL' });
    });

    it('apiUrl: config wins when env unset', async () => {
      await saveConfigFile({ apiUrl: 'https://from-file' });
      const r = await resolveCliConfigDetailed();
      expect(r.apiUrl).toEqual({ value: 'https://from-file', source: 'config' });
    });

    it('apiUrl: falls through to default https://api.ospex.org when neither env nor config set', async () => {
      const r = await resolveCliConfigDetailed();
      expect(r.apiUrl.value).toBe('https://api.ospex.org');
      expect(r.apiUrl.source).toBe('default');
    });

    it('rpcUrl: env wins over config', async () => {
      await saveConfigFile({ rpcUrl: 'https://from-file/rpc' });
      process.env.OSPEX_RPC_URL = 'https://from-env/rpc';
      const r = await resolveCliConfigDetailed();
      expect(r.rpcUrl).toEqual({ value: 'https://from-env/rpc', source: 'env-OSPEX_RPC_URL' });
    });

    it('rpcUrl: value=null + source=unset when neither env nor config set', async () => {
      const r = await resolveCliConfigDetailed();
      expect(r.rpcUrl).toEqual({ value: null, source: 'unset' });
    });

    it('chainId: env wins, then config, then default 137', async () => {
      process.env.OSPEX_CHAIN_ID = '80002';
      let r = await resolveCliConfigDetailed();
      expect(r.chainId).toEqual({ value: 80002, source: 'env-OSPEX_CHAIN_ID' });

      delete process.env.OSPEX_CHAIN_ID;
      await saveConfigFile({ chainId: 80002 });
      r = await resolveCliConfigDetailed();
      expect(r.chainId).toEqual({ value: 80002, source: 'config' });

      await saveConfigFile({});
      r = await resolveCliConfigDetailed();
      expect(r.chainId).toEqual({ value: 137, source: 'default' });
    });

    it('empty-string env values are treated as unset', async () => {
      process.env.OSPEX_API_URL = '';
      process.env.OSPEX_RPC_URL = '';
      await saveConfigFile({ apiUrl: 'https://from-file' });
      const r = await resolveCliConfigDetailed();
      expect(r.apiUrl.source).toBe('config'); // falls through env=''
      expect(r.rpcUrl.source).toBe('unset');  // no config either
    });

    // Hermes PR 54 blocker #3: both resolvers must agree on what
    // counts as "set". An empty-string `OSPEX_RPC_URL` was treated
    // as set by `resolveCliConfig` (via `??`) but as unset by
    // `resolveCliConfigDetailed`. Result was a split-brain doctor
    // report where `config.rpc_url: ok` and `connectivity.rpc: ok`
    // but the eventual `getClient()` failed with "No rpcUrl
    // configured". Aligning to "empty = unset" everywhere.
    it('resolveCliConfig + resolveCliConfigDetailed agree: empty env falls through to config', async () => {
      process.env.OSPEX_RPC_URL = '';
      process.env.OSPEX_API_URL = '';
      await saveConfigFile({
        rpcUrl: 'https://from-file/rpc',
        apiUrl: 'https://from-file/api',
      });

      const valuesOnly = await resolveCliConfig();
      const detailed = await resolveCliConfigDetailed();

      expect(valuesOnly.rpcUrl).toBe('https://from-file/rpc');
      expect(detailed.rpcUrl.value).toBe('https://from-file/rpc');
      expect(detailed.rpcUrl.source).toBe('config');

      expect(valuesOnly.apiUrl).toBe('https://from-file/api');
      expect(detailed.apiUrl.value).toBe('https://from-file/api');
      expect(detailed.apiUrl.source).toBe('config');
    });

    it('resolveCliConfig + resolveCliConfigDetailed agree: no env + no config → rpc unset', async () => {
      // Empty string for env, no file entry, no default for rpc.
      process.env.OSPEX_RPC_URL = '';
      const valuesOnly = await resolveCliConfig();
      const detailed = await resolveCliConfigDetailed();
      expect(valuesOnly.rpcUrl).toBeUndefined();
      expect(detailed.rpcUrl.value).toBeNull();
      expect(detailed.rpcUrl.source).toBe('unset');
    });
  });
});
