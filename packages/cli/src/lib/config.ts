/**
 * Persistent CLI config: file at `~/.ospex/config.json`, layered with
 * env-var overrides at read time. Order of precedence:
 *
 *   env var (OSPEX_API_URL, OSPEX_SUPABASE_*)
 *     > config file
 *     > SDK built-in default (only for apiUrl)
 *
 * Tested via the OSPEX_HOME env var, which overrides the home directory
 * lookup so tests can point at a tmp dir without monkey-patching `os`.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secureMkdirP, secureWriteFile } from './secure-fs.js';

export interface CliConfigFile {
  apiUrl?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  rpcUrl?: string;
  /** 137 (mainnet) or 80002 (amoy). */
  chainId?: 137 | 80002;
}

export interface ResolvedCliConfig {
  apiUrl: string | undefined;
  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  rpcUrl: string | undefined;
  chainId: 137 | 80002 | undefined;
}

const CONFIG_FILE_NAME = 'config.json';

export function getOspexHome(): string {
  const override = process.env.OSPEX_HOME;
  if (override !== undefined && override !== '') return override;
  return path.join(os.homedir(), '.ospex');
}

export function getConfigPath(): string {
  return path.join(getOspexHome(), CONFIG_FILE_NAME);
}

export function getKeystorePath(): string {
  return path.join(getOspexHome(), 'keystore.json');
}

export function getSessionPath(): string {
  return path.join(getOspexHome(), 'session');
}

export async function loadConfigFile(): Promise<CliConfigFile> {
  const file = getConfigPath();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    const obj = parsed as Record<string, unknown>;
    const out: CliConfigFile = {};
    if (typeof obj.apiUrl === 'string') out.apiUrl = obj.apiUrl;
    if (typeof obj.supabaseUrl === 'string') out.supabaseUrl = obj.supabaseUrl;
    if (typeof obj.supabaseAnonKey === 'string') out.supabaseAnonKey = obj.supabaseAnonKey;
    if (typeof obj.rpcUrl === 'string') out.rpcUrl = obj.rpcUrl;
    if (obj.chainId === 137 || obj.chainId === 80002) out.chainId = obj.chainId;
    return out;
  } catch (err) {
    if (isFileNotFound(err)) return {};
    throw err;
  }
}

export async function saveConfigFile(config: CliConfigFile): Promise<void> {
  await secureMkdirP(getOspexHome());
  await secureWriteFile(getConfigPath(), JSON.stringify(config, null, 2) + '\n');
}

export async function resolveCliConfig(): Promise<ResolvedCliConfig> {
  const file = await loadConfigFile();
  const envChainId = parseEnvChainId(process.env.OSPEX_CHAIN_ID);
  return {
    apiUrl: process.env.OSPEX_API_URL ?? file.apiUrl,
    supabaseUrl: process.env.OSPEX_SUPABASE_URL ?? file.supabaseUrl,
    supabaseAnonKey: process.env.OSPEX_SUPABASE_ANON_KEY ?? file.supabaseAnonKey,
    rpcUrl: process.env.OSPEX_RPC_URL ?? file.rpcUrl,
    chainId: envChainId ?? file.chainId,
  };
}

function parseEnvChainId(raw: string | undefined): 137 | 80002 | undefined {
  if (raw === '137') return 137;
  if (raw === '80002') return 80002;
  return undefined;
}

export function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
