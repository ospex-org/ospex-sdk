/**
 * Persistent CLI config: file at `~/.ospex/config.json`, layered with
 * env-var overrides at read time. Order of precedence:
 *
 *   env var (OSPEX_API_URL, OSPEX_SUPABASE_*, OSPEX_KEYSTORE_PATH, ...)
 *     > config file
 *     > SDK built-in default (only for apiUrl, and `~/.ospex/keystore.json`
 *       for the keystore path)
 *
 * The keystore path is the recommended bring-your-own-wallet seam: point
 * Ospex at a Foundry-managed keystore (`cast wallet new ~/.foundry/keystores
 * <name>` for a fresh key or `cast wallet import <name>` for an existing
 * one) so Ospex never handles the raw private key. Configure once via
 * `ospex init` (saved into `~/.ospex/config.json`) so future shells don't
 * need to re-export anything; the env var stays available as a per-shell
 * override (handy for scripts and CI).
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
  /**
   * Foundry-managed keystore path (or any v3 JSON keystore). Leading
   * `~/` is expanded against the user's home directory at read time.
   *
   * Long-standing legacy field. Pinned-via-`auth use-foundry` clients
   * should prefer `foundryAccount`; `keystorePath` is still supported
   * for users with an arbitrary v3 keystore that isn't under
   * `~/.foundry/keystores`.
   */
  keystorePath?: string;
  // ── Foundry signer defaults (PR 3 of the agent-signer series) ─────
  /**
   * Foundry account name pinned by `ospex auth use-foundry`. Resolved
   * against `foundryKeystoresDir` (or `~/.foundry/keystores`) at
   * unlock time. Mutually exclusive with `keystorePath` at the
   * signer-resolution layer — `use-foundry` clears whichever is not
   * being set.
   */
  foundryAccount?: string;
  /**
   * Path to a passphrase file. Set by `ospex auth use-foundry` so
   * subsequent write commands can unlock non-interactively. The file
   * itself is the secret; only the path is persisted here.
   */
  passwordFile?: string;
  /**
   * Override the Foundry keystores directory. Only set when the user
   * passed `--foundry-keystores-dir` to `auth use-foundry` (or
   * configured a non-default home).
   */
  foundryKeystoresDir?: string;
  /**
   * Pinned address from the last successful `auth use-foundry`
   * validation. When set, every unlock compares the resolved signer's
   * address against this value; mismatches throw
   * `OspexSignerResolutionError({ reason: 'address_mismatch' })`. The
   * guardrail catches surprise key rotations (re-importing a
   * different PK under the same account name).
   */
  expectedAddress?: string;
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

/**
 * Resolve the keystore file path. Precedence:
 *   1. `OSPEX_KEYSTORE_PATH` env var (per-shell override)
 *   2. `keystorePath` field in `~/.ospex/config.json` (persistent — set
 *      via `ospex init`)
 *   3. default `~/.ospex/keystore.json` (legacy location)
 *
 * Leading `~/` in either env or config-file value is expanded against
 * the user's home directory.
 */
export async function getKeystorePath(): Promise<string> {
  const envOverride = process.env.OSPEX_KEYSTORE_PATH;
  if (envOverride !== undefined && envOverride !== '') {
    return expandTilde(envOverride);
  }
  const config = await loadConfigFile();
  if (config.keystorePath !== undefined && config.keystorePath !== '') {
    return expandTilde(config.keystorePath);
  }
  return path.join(getOspexHome(), 'keystore.json');
}

export function getSessionPath(): string {
  return path.join(getOspexHome(), 'session');
}

/**
 * Expand a leading `~/` (or bare `~`) to the user's home directory. Only
 * the leading segment is touched — embedded `~` characters are kept.
 */
export function expandTilde(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
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
    if (typeof obj.keystorePath === 'string') out.keystorePath = obj.keystorePath;
    if (typeof obj.foundryAccount === 'string') out.foundryAccount = obj.foundryAccount;
    if (typeof obj.passwordFile === 'string') out.passwordFile = obj.passwordFile;
    if (typeof obj.foundryKeystoresDir === 'string') {
      out.foundryKeystoresDir = obj.foundryKeystoresDir;
    }
    if (typeof obj.expectedAddress === 'string') out.expectedAddress = obj.expectedAddress;
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
