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
import { DEFAULT_API_URL } from '@ospex/sdk';
import { secureMkdirP, secureWriteFile } from './secure-fs.js';

export interface CliConfigFile {
  apiUrl?: string;
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
   * unlock time. Mutually exclusive with `foundryKeystorePath` —
   * `use-foundry` clears whichever is not being set.
   */
  foundryAccount?: string;
  /**
   * Explicit v3 keystore path pinned by `ospex auth use-foundry
   * --keystore-path`. Distinct from the legacy `keystorePath` field
   * (which is set by `ospex init` and consulted only by the legacy
   * default-keystore path 3 of `loadSigner`). The split is critical:
   * `mergeIntentFromConfig` lifts `foundryKeystorePath` into explicit
   * signer intent (skipping the legacy session cache, pairing with
   * the pinned `passwordFile` for non-interactive unlock), but
   * intentionally leaves the legacy `keystorePath` alone so users
   * who only ran `ospex init` keep today's behavior.
   *
   * Mutually exclusive with `foundryAccount` — `use-foundry` clears
   * whichever isn't being set.
   */
  foundryKeystorePath?: string;
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
    if (typeof obj.rpcUrl === 'string') out.rpcUrl = obj.rpcUrl;
    if (obj.chainId === 137 || obj.chainId === 80002) out.chainId = obj.chainId;
    if (typeof obj.keystorePath === 'string') out.keystorePath = obj.keystorePath;
    if (typeof obj.foundryAccount === 'string') out.foundryAccount = obj.foundryAccount;
    if (typeof obj.foundryKeystorePath === 'string') {
      out.foundryKeystorePath = obj.foundryKeystorePath;
    }
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
  // Treat empty-string env vars as unset. `??` alone preserves `''`,
  // which produces a split-brain with `resolveCliConfigDetailed`
  // (which treats `''` as unset) AND breaks `getClient()` downstream:
  // it short-circuits on falsy `rpcUrl` but the bare string `''` is
  // falsy already, so the bug only surfaced for fields the SDK
  // happened to forward verbatim. Hermes PR 54 blocker #3 — every
  // env var is normalised the same way both resolvers do.
  return {
    apiUrl: nonEmpty(process.env.OSPEX_API_URL) ?? file.apiUrl,
    rpcUrl: nonEmpty(process.env.OSPEX_RPC_URL) ?? file.rpcUrl,
    chainId: envChainId ?? file.chainId,
  };
}

function parseEnvChainId(raw: string | undefined): 137 | 80002 | undefined {
  if (raw === '137') return 137;
  if (raw === '80002') return 80002;
  return undefined;
}

/** Treat empty strings as unset. Exported so tests can grok the rule. */
export function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

/**
 * Expected chain ID for the SDK + its provenance. Mirrors
 * `resolveCliConfig`'s precedence ladder but returns the *source* too,
 * so `ospex doctor` can surface whether the user explicitly chose a
 * chain or fell through to the mainnet default. Default is 137 —
 * matching the SDK's runtime default — so a wallet pointed at Amoy
 * without `OSPEX_CHAIN_ID` set will fail `network.chain_id_match`
 * loudly rather than silently accept the wrong chain.
 *
 * `source` is stable enum the JSON envelope exposes. New values may
 * be added (forward-compatible).
 */
export type ExpectedChainIdSource = 'env-OSPEX_CHAIN_ID' | 'config' | 'default';

export interface ResolvedExpectedChainId {
  value: 137 | 80002;
  source: ExpectedChainIdSource;
}

export async function resolveExpectedChainId(): Promise<ResolvedExpectedChainId> {
  const envValue = parseEnvChainId(process.env.OSPEX_CHAIN_ID);
  if (envValue !== undefined) return { value: envValue, source: 'env-OSPEX_CHAIN_ID' };
  const file = await loadConfigFile();
  if (file.chainId !== undefined) return { value: file.chainId, source: 'config' };
  return { value: 137, source: 'default' };
}

// ── Per-field provenance resolvers ────────────────────────────────────
//
// The doctor's `config` envelope block needs to surface WHICH source
// supplied each value (env vs config file vs hard-coded default) so
// agents can diagnose "wait, why is my chain id 137?" without guessing.
// `resolveCliConfig` above returns values only — kept for `getClient`
// and other callers that don't care about provenance.
//
// `resolveCliConfigDetailed` is the doctor-flavored sibling. One config
// file read services every field for the request.

export type ApiUrlSource = 'env-OSPEX_API_URL' | 'config' | 'default';
export type RpcUrlSource = 'env-OSPEX_RPC_URL' | 'config' | 'unset';

export interface ResolvedApiUrl {
  value: string;
  source: ApiUrlSource;
}

export interface ResolvedRpcUrl {
  /** `null` when no rpcUrl is configured anywhere. */
  value: string | null;
  source: RpcUrlSource;
}

export interface ResolvedCliConfigDetailed {
  apiUrl: ResolvedApiUrl;
  rpcUrl: ResolvedRpcUrl;
  chainId: ResolvedExpectedChainId;
}

export async function resolveCliConfigDetailed(): Promise<ResolvedCliConfigDetailed> {
  const file = await loadConfigFile();

  // `nonEmpty` matches `resolveCliConfig`'s empty-string normalisation
  // exactly. Both must agree or the doctor's `config.*` provenance
  // diverges from what `getClient()` actually uses downstream.
  const envApi = nonEmpty(process.env.OSPEX_API_URL);
  const fileApi = nonEmpty(file.apiUrl);
  const apiUrl: ResolvedApiUrl =
    envApi !== undefined
      ? { value: envApi, source: 'env-OSPEX_API_URL' }
      : fileApi !== undefined
        ? { value: fileApi, source: 'config' }
        : { value: DEFAULT_API_URL, source: 'default' };

  const envRpc = nonEmpty(process.env.OSPEX_RPC_URL);
  const fileRpc = nonEmpty(file.rpcUrl);
  const rpcUrl: ResolvedRpcUrl =
    envRpc !== undefined
      ? { value: envRpc, source: 'env-OSPEX_RPC_URL' }
      : fileRpc !== undefined
        ? { value: fileRpc, source: 'config' }
        : { value: null, source: 'unset' };

  const envChain = parseEnvChainId(process.env.OSPEX_CHAIN_ID);
  const chainId: ResolvedExpectedChainId =
    envChain !== undefined
      ? { value: envChain, source: 'env-OSPEX_CHAIN_ID' }
      : file.chainId !== undefined
        ? { value: file.chainId, source: 'config' }
        : { value: 137, source: 'default' };

  return { apiUrl, rpcUrl, chainId };
}

export function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
