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
 * subtleties caught in review:
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
import {
  KeystoreSigner,
  checkPasswordFilePermissions,
} from '@ospex/sdk/signers/keystore';
import { readSession } from './client.js';
import { expandTilde, getKeystorePath, type CliConfigFile } from './config.js';
import { getKeystoreAddressIfPresent } from './keystore.js';
import { promptHidden } from './prompt.js';
import type { SignerIntent } from './signer-options.js';
import {
  isValidAddress,
  WalletAddressUnresolvedError,
  type Hex,
} from './walletAddress.js';

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

// ── Walker-aware address derivation ─────────────────────────────────

/**
 * Stable enum recording WHICH source produced the resolved wallet
 * address. The doctor's `signer.address_known.data.derivedFrom`
 * surfaces this so agents can distinguish a flag override from a
 * keystore unlock without re-doing the work.
 */
export type WalletAddressSource =
  | 'flag-address'
  | 'keystore-field'
  | 'session-cache'
  | 'non-interactive-unlock'
  | 'expected-address-pin'
  | 'interactive-prompt';

export interface DeriveSignerAddressArgs {
  /** `--address <0x...>` override. Wins everything; zero I/O. */
  override: string | undefined;
  /** Output of `resolveAuthSources` — the walker's view of which
   *  keystore + password + pin would resolve. */
  resolution: AuthSourceResolution;
  /** When true, never trigger a passphrase prompt. Suppresses the
   *  interactive-prompt fallback; throws instead. */
  noPrompt: boolean;
}

/**
 * Derive the configured wallet's address using the walker's
 * resolution data — closes the review blocker where the
 * doctor's legacy `resolveWalletAddress(...)` only consulted
 * `getKeystorePath()` and never saw a config-pinned `foundryAccount`.
 *
 * Resolution order (cheapest → heaviest, never prompts under
 * `noPrompt: true`):
 *
 *   1. `override` (--address flag). Zero I/O.
 *   2. In-keystore `address` field — ethers-produced keystores carry
 *      one. Foundry-produced ones don't; the rest of the ladder picks
 *      up the slack.
 *   3. Active session cache (`ospex wallet unlock`). Returns
 *      `session.address` without a decrypt.
 *   4. Non-interactive unlock via the SDK helpers — uses the
 *      configured `passwordFile` or `--password-stdin`. Same code
 *      path `auth check --json` uses; matches `loadSigner` for
 *      live writes.
 *   5. Configured `expectedAddress` pin. Declaration-only — used as
 *      a last cheap signal when no credentials are available to
 *      verify. The pin is a stated invariant; we surface it so
 *      bettors who set it via `auth use-foundry --expected-address`
 *      see their address even without a password file present.
 *   6. Interactive prompt (only when `noPrompt: false`). Throws
 *      `WalletAddressUnresolvedError` under `noPrompt`.
 */
export async function deriveSignerAddress(
  args: DeriveSignerAddressArgs,
): Promise<{ address: Hex; source: WalletAddressSource }> {
  const { override, resolution, noPrompt } = args;

  // (1) Override — fast path that respects the agent's "I told you
  //     who I am" assertion without any keystore touch.
  if (override !== undefined) {
    if (!isValidAddress(override)) {
      throw new Error(
        `--address must be a 0x-prefixed 20-byte hex address, got "${override}".`,
      );
    }
    return { address: override.toLowerCase() as Hex, source: 'flag-address' };
  }

  // (2) In-keystore address field — only Ethers-style v3 keystores
  //     carry one; Foundry omits it. Cheap when present.
  if (resolution.keystore.exists) {
    try {
      const raw = await fs.readFile(resolution.keystore.path, 'utf8');
      const fromFile = getKeystoreAddressIfPresent(raw);
      if (fromFile !== null && isValidAddress(fromFile)) {
        return { address: fromFile.toLowerCase() as Hex, source: 'keystore-field' };
      }
    } catch {
      // Best-effort — keystore is read-broken or malformed; fall through.
    }
  }

  // (3) Session cache — ONLY when the walker's resolution says the
  //     legacy session path is the active one. Mirrors
  //     `loadSigner`'s "explicit sources skip session" precedence —
  //     same rule `resolvePasswordField` uses to compute
  //     `password.provenance`. Without this gate a fresh session for
  //     wallet B leaks past a config-pinned Foundry signer A, and
  //     the doctor reports B's address even though `config.signer`
  //     correctly says A was selected (review round 2 blocker).
  if (resolution.password.provenance === 'session-cache') {
    const session = await readSession();
    if (session && isValidAddress(session.address)) {
      return {
        address: session.address.toLowerCase() as Hex,
        source: 'session-cache',
      };
    }
  }

  // (4) Non-interactive unlock when the walker shows a credentialed
  //     password source. This is the path that fixes review
  //     blocker #1 — `auth use-foundry`-pinned setups land here.
  if (resolution.keystore.exists && hasNonInteractivePassword(resolution.password.provenance)) {
    try {
      const signer = await unlockNonInteractively(resolution);
      const addr = (await signer.getAddress()).toLowerCase() as Hex;
      return { address: addr, source: 'non-interactive-unlock' };
    } catch {
      // Decryption / passphrase mismatch — fall through to the pin
      // (if any) so the user at least sees their declared address.
    }
  }

  // (5) Expected-address pin (set via `auth use-foundry --expected-address`
  //     or the --expected-address flag). Declaration, not verification.
  if (resolution.expectedAddress.value !== null) {
    return {
      address: resolution.expectedAddress.value,
      source: 'expected-address-pin',
    };
  }

  // (6) No-prompt failure / interactive fallback.
  if (noPrompt) {
    if (!resolution.keystore.exists) {
      throw new WalletAddressUnresolvedError(
        'keystore_not_found',
        `no keystore at ${resolution.keystore.path}`,
      );
    }
    throw new WalletAddressUnresolvedError(
      'password_source_missing',
      'address could not be derived without unlocking the keystore',
    );
  }

  if (!resolution.keystore.exists) {
    throw new WalletAddressUnresolvedError(
      'keystore_not_found',
      `no keystore at ${resolution.keystore.path}`,
    );
  }
  const raw = await fs.readFile(resolution.keystore.path, 'utf8');
  const passphrase = await promptHidden('Keystore passphrase: ');
  const signer = await KeystoreSigner.unlock(raw, passphrase);
  const addr = (await signer.getAddress()).toLowerCase() as Hex;
  return { address: addr, source: 'interactive-prompt' };
}

function hasNonInteractivePassword(provenance: PasswordProvenance): boolean {
  return (
    provenance === 'flag-password-file' ||
    provenance === 'flag-password-stdin' ||
    provenance === 'env-OSPEX_PASSWORD_FILE' ||
    provenance === 'config-passwordFile'
  );
}

/**
 * Invoke the SDK keystore helper that matches the walker's keystore
 * + password provenance. Throws on decryption failure / mismatch —
 * the caller catches and falls through to the pin path.
 */
async function unlockNonInteractively(resolution: AuthSourceResolution) {
  const passphraseArg: { passwordFile?: string; fromStdin?: boolean } = {};
  if (resolution.password.provenance === 'flag-password-stdin') {
    passphraseArg.fromStdin = true;
  } else if (resolution.password.path !== null) {
    passphraseArg.passwordFile = resolution.password.path;
  }
  if (resolution.keystore.account !== null) {
    return KeystoreSigner.fromFoundryAccount({
      account: resolution.keystore.account,
      foundryKeystoresDir: resolution.foundryKeystoresDir.value,
      ...passphraseArg,
    });
  }
  return KeystoreSigner.fromKeystoreFile({
    keystorePath: resolution.keystore.path,
    ...passphraseArg,
  });
}
