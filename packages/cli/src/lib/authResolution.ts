/**
 * Shared signer-resolution walker.
 *
 * Walks the same precedence ladder a real write command would
 * (flag > env > config > default) and reports exactly which source
 * resolved each field. Originally lived inside
 * `commands/auth/check.ts`; PR 4 of the doctor expansion lifts it
 * here so `ospex doctor` can surface the same provenance in its
 * `config.signer` envelope block without re-implementing the ladder.
 *
 * **Must stay in lockstep with `loadSigner`'s `materializeIntent` +
 * `mergeIntentFromConfig` + `resolveSignerByPrecedence`** — the
 * provenance enums and reachability rules are an agent contract
 * (see `docs/AGENT_CONTRACT.md` §4). Three locked-in regression
 * subtleties Hermes caught on the original PR 50 reviews:
 *
 *   1. Session-cache password provenance applies ONLY when the
 *      keystore came from a legacy source. Explicit sources skip
 *      the session cache (matches `loadSigner` path-1 explicit).
 *   2. Config-pinned `expectedAddress` lifts apply only when the
 *      resolved keystore source corresponds to the configured one.
 *   3. In the legacy-keystore branch, flag/env/config password
 *      sources are reported as 'none' — not as their configured
 *      value — because `loadSigner`'s path-3 is interactive and
 *      ignores any lifted `intent.passwordFile`.
 *
 * The walker is pure-ish: it touches the file system (existence
 * checks, permission mode) but the inputs (`intent`, `env`,
 * `config`) are all passed in, so tests can drive it with synthetic
 * fixtures.
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { checkPasswordFilePermissions } from '@ospex/sdk/signers/keystore';
import { readSession } from './client.js';
import { expandTilde, getKeystorePath, type CliConfigFile } from './config.js';
import type { SignerIntent } from './signer-options.js';

// ── Provenance enums (stable agent contract) ────────────────────────

export type KeystoreProvenance =
  | 'flag-account'
  | 'flag-keystore-path'
  | 'env-OSPEX_KEYSTORE_PATH'
  | 'config-foundryAccount'
  | 'config-foundryKeystorePath'
  | 'config-keystorePath-legacy'
  | 'default-legacy';

export type PasswordProvenance =
  | 'flag-password-file'
  | 'flag-password-stdin'
  | 'env-OSPEX_PASSWORD_FILE'
  | 'config-passwordFile'
  | 'session-cache'
  | 'none';

export type ExpectedAddressProvenance = 'flag' | 'config' | 'none';

export type FoundryKeystoresDirProvenance =
  | 'flag'
  | 'env-OSPEX_FOUNDRY_KEYSTORES_DIR'
  | 'env-FOUNDRY_DIR'
  | 'config'
  | 'default';

// ── Resolution result types ──────────────────────────────────────────

export interface ResolvedKeystoreField {
  provenance: KeystoreProvenance;
  path: string;
  account: string | null;
  exists: boolean;
}

export interface ResolvedPasswordField {
  provenance: PasswordProvenance;
  path: string | null;
  exists: boolean | null;
}

export interface ResolvedExpectedAddressField {
  provenance: ExpectedAddressProvenance;
  value: `0x${string}` | null;
}

export interface ResolvedFoundryKeystoresDirField {
  provenance: FoundryKeystoresDirProvenance;
  value: string;
}

export interface AuthSourceResolution {
  keystore: ResolvedKeystoreField;
  password: ResolvedPasswordField;
  expectedAddress: ResolvedExpectedAddressField;
  foundryKeystoresDir: ResolvedFoundryKeystoresDirField;
}

export interface PasswordFilePermissions {
  checked: boolean;
  platformSkipped: boolean;
  mode: number | null;
  octal: string | null;
  loose: boolean | null;
}

// ── Top-level walker ─────────────────────────────────────────────────

/**
 * Resolve every signer source field and report its provenance. The
 * single entry point both `auth check` and `doctor` use; per-field
 * resolvers below are also exported for tests that want to drill in.
 */
export async function resolveAuthSources(
  intent: SignerIntent,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
): Promise<AuthSourceResolution> {
  const keystore = await resolveKeystoreField(intent, env, config);
  const foundryKeystoresDir = resolveFoundryDirField(intent, env, config);
  const password = await resolvePasswordField(intent, env, config, keystore);
  const expectedAddress = resolveExpectedAddressField(intent, config, keystore);
  return { keystore, password, expectedAddress, foundryKeystoresDir };
}

// ── Per-field walkers ────────────────────────────────────────────────

export async function resolveKeystoreField(
  intent: SignerIntent,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
): Promise<ResolvedKeystoreField> {
  let provenance: KeystoreProvenance;
  let resolvedPath: string;
  let account: string | null = null;

  if (intent.account !== undefined) {
    provenance = 'flag-account';
    account = intent.account;
    resolvedPath = path.join(
      resolveFoundryKeystoresDir(intent, env, config),
      intent.account,
    );
  } else if (intent.keystorePath !== undefined) {
    provenance = 'flag-keystore-path';
    resolvedPath = expandTilde(intent.keystorePath);
  } else if (
    typeof env.OSPEX_KEYSTORE_PATH === 'string' &&
    env.OSPEX_KEYSTORE_PATH.length > 0
  ) {
    provenance = 'env-OSPEX_KEYSTORE_PATH';
    resolvedPath = expandTilde(env.OSPEX_KEYSTORE_PATH);
  } else if (
    config.foundryAccount !== undefined &&
    config.foundryAccount.length > 0
  ) {
    provenance = 'config-foundryAccount';
    account = config.foundryAccount;
    resolvedPath = path.join(
      resolveFoundryKeystoresDir(intent, env, config),
      config.foundryAccount,
    );
  } else if (
    config.foundryKeystorePath !== undefined &&
    config.foundryKeystorePath.length > 0
  ) {
    provenance = 'config-foundryKeystorePath';
    resolvedPath = expandTilde(config.foundryKeystorePath);
  } else if (
    config.keystorePath !== undefined &&
    config.keystorePath.length > 0
  ) {
    provenance = 'config-keystorePath-legacy';
    resolvedPath = expandTilde(config.keystorePath);
  } else {
    provenance = 'default-legacy';
    resolvedPath = await getKeystorePath();
  }

  return {
    provenance,
    path: resolvedPath,
    account,
    exists: await fileExists(resolvedPath),
  };
}

export async function resolvePasswordField(
  intent: SignerIntent,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
  keystore: ResolvedKeystoreField,
): Promise<ResolvedPasswordField> {
  const isLegacyKeystore =
    keystore.provenance === 'config-keystorePath-legacy' ||
    keystore.provenance === 'default-legacy';

  if (isLegacyKeystore) {
    // In the legacy-keystore branch, only the session cache produces
    // a real non-interactive unlock — `loadSigner` path-3 prompts
    // and ignores any lifted `intent.passwordFile`. Mirror that.
    const session = await readSession();
    if (session) {
      return { provenance: 'session-cache', path: null, exists: null };
    }
    return { provenance: 'none', path: null, exists: null };
  }

  // Explicit keystore source: flag > env > config password ladder.
  if (intent.passwordFile !== undefined) {
    const p = expandTilde(intent.passwordFile);
    return {
      provenance: 'flag-password-file',
      path: p,
      exists: await fileExists(p),
    };
  }
  if (intent.fromStdin === true) {
    return { provenance: 'flag-password-stdin', path: null, exists: null };
  }
  if (
    typeof env.OSPEX_PASSWORD_FILE === 'string' &&
    env.OSPEX_PASSWORD_FILE.length > 0
  ) {
    const p = expandTilde(env.OSPEX_PASSWORD_FILE);
    return {
      provenance: 'env-OSPEX_PASSWORD_FILE',
      path: p,
      exists: await fileExists(p),
    };
  }
  if (config.passwordFile !== undefined && config.passwordFile.length > 0) {
    const p = expandTilde(config.passwordFile);
    return {
      provenance: 'config-passwordFile',
      path: p,
      exists: await fileExists(p),
    };
  }
  return { provenance: 'none', path: null, exists: null };
}

export function resolveExpectedAddressField(
  intent: SignerIntent,
  config: CliConfigFile,
  keystore: ResolvedKeystoreField,
): ResolvedExpectedAddressField {
  if (intent.expectedAddress !== undefined) {
    return { provenance: 'flag', value: intent.expectedAddress };
  }
  if (config.expectedAddress === undefined || config.expectedAddress.length === 0) {
    return { provenance: 'none', value: null };
  }

  // "Explicit" mirrors what `materializeIntent` + the path-1 check
  // in `resolveSignerByPrecedence` consider explicit: flag account,
  // flag keystore-path, OR env `OSPEX_KEYSTORE_PATH`. Pin applies
  // only when the resolved source matches the configured one.
  const cameFromExplicitSource =
    keystore.provenance === 'flag-account' ||
    keystore.provenance === 'flag-keystore-path' ||
    keystore.provenance === 'env-OSPEX_KEYSTORE_PATH';

  if (!cameFromExplicitSource) {
    return {
      provenance: 'config',
      value: config.expectedAddress.toLowerCase() as `0x${string}`,
    };
  }

  const flagAccountMatchesConfig =
    keystore.provenance === 'flag-account' &&
    config.foundryAccount !== undefined &&
    config.foundryAccount.length > 0 &&
    intent.account === config.foundryAccount;

  const explicitPathMatchesConfigPath =
    (keystore.provenance === 'flag-keystore-path' ||
      keystore.provenance === 'env-OSPEX_KEYSTORE_PATH') &&
    config.foundryKeystorePath !== undefined &&
    config.foundryKeystorePath.length > 0 &&
    keystore.path === expandTilde(config.foundryKeystorePath);

  if (flagAccountMatchesConfig || explicitPathMatchesConfigPath) {
    return {
      provenance: 'config',
      value: config.expectedAddress.toLowerCase() as `0x${string}`,
    };
  }
  return { provenance: 'none', value: null };
}

export function resolveFoundryDirField(
  intent: SignerIntent,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
): ResolvedFoundryKeystoresDirField {
  if (intent.foundryKeystoresDir !== undefined) {
    return { provenance: 'flag', value: expandTilde(intent.foundryKeystoresDir) };
  }
  if (
    typeof env.OSPEX_FOUNDRY_KEYSTORES_DIR === 'string' &&
    env.OSPEX_FOUNDRY_KEYSTORES_DIR.length > 0
  ) {
    return {
      provenance: 'env-OSPEX_FOUNDRY_KEYSTORES_DIR',
      value: expandTilde(env.OSPEX_FOUNDRY_KEYSTORES_DIR),
    };
  }
  if (typeof env.FOUNDRY_DIR === 'string' && env.FOUNDRY_DIR.length > 0) {
    return {
      provenance: 'env-FOUNDRY_DIR',
      value: path.join(expandTilde(env.FOUNDRY_DIR), 'keystores'),
    };
  }
  if (
    config.foundryKeystoresDir !== undefined &&
    config.foundryKeystoresDir.length > 0
  ) {
    return {
      provenance: 'config',
      value: expandTilde(config.foundryKeystoresDir),
    };
  }
  return {
    provenance: 'default',
    value: path.join(os.homedir(), '.foundry', 'keystores'),
  };
}

/** Same selection logic as `resolveFoundryDirField`, returns only the path. */
export function resolveFoundryKeystoresDir(
  intent: SignerIntent,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
): string {
  return resolveFoundryDirField(intent, env, config).value;
}

// ── Permission check ────────────────────────────────────────────────

/**
 * Inspect the resolved password file's POSIX permissions. Only
 * meaningful for file-backed password sources — stdin / session /
 * none have nothing to check.
 */
export async function checkPasswordFilePerms(
  password: ResolvedPasswordField,
): Promise<PasswordFilePermissions> {
  if (password.path === null || password.exists === false) {
    return {
      checked: false,
      platformSkipped: false,
      mode: null,
      octal: null,
      loose: null,
    };
  }
  const result = await checkPasswordFilePermissions(password.path);
  if (result.platformSkipped) {
    return {
      checked: false,
      platformSkipped: true,
      mode: null,
      octal: null,
      loose: null,
    };
  }
  return {
    checked: true,
    platformSkipped: false,
    mode: result.mode,
    octal: result.mode.toString(8).padStart(3, '0'),
    loose: result.loose,
  };
}

// ── small helpers ───────────────────────────────────────────────────

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
