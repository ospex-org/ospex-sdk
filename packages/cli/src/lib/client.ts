/**
 * `getClient({ requiresSigner, signerIntent? })` — the single entry
 * point every command uses to obtain a configured `OspexClient`.
 * Layers config sources (env > file > SDK defaults) and resolves a
 * signer when one is required.
 *
 * Two signer paths:
 *
 *   - **Non-interactive** (Foundry-first): when `signerIntent` carries
 *     an explicit `--account` / `--keystore-path` and a passphrase
 *     source (`--password-file` / `--password-stdin` / env), the
 *     loader delegates to `KeystoreSigner.fromFoundryAccount` /
 *     `fromKeystoreFile`. No session-cache write. Decrypted key lives
 *     in memory for the command only.
 *
 *   - **Legacy session-cache** (`ospex wallet unlock`): when no
 *     non-interactive source is configured, the loader reads
 *     `~/.ospex/session` if a fresh entry exists, otherwise prompts
 *     for the passphrase interactively and unlocks the keystore at
 *     `OSPEX_KEYSTORE_PATH` / config `keystorePath` / the legacy
 *     default. Soft-deprecated for agents but kept for compatibility.
 *
 * Session-cache trade-off (legacy path): when the user runs
 * `ospex wallet unlock`, we cache the *decrypted* private key in
 * `~/.ospex/session` plain JSON, with file mode 0600 on POSIX,
 * expiry 15 minutes from write.
 *
 * 0600 keeps the file unreadable by *other* users on the host, but
 * does NOT defend against any process running as the same user — that
 * threat surface is unavoidable without an OS-keychain integration
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux), which is
 * out of scope for v1. If higher assurance is required, run write
 * commands without `wallet unlock` — pass `--account` + `--password-file`
 * (the Foundry-first path) which never persists the decrypted key.
 *
 * Both the legacy file and its parent directory are written via
 * secure-fs.ts (atomic temp + rename + defensive chmod) so an
 * existing-file overwrite tightens permissions back to 0600 / 0700
 * instead of inheriting the prior mode.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { OspexClient, OspexSignerResolutionError, type Signer } from '@ospex/sdk';
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';
import type { FromFoundryAccountArgs, FromKeystoreFileArgs } from '@ospex/sdk/signers/keystore';
import {
  expandTilde,
  getKeystorePath,
  getOspexHome,
  getSessionPath,
  isFileNotFound,
  loadConfigFile,
  resolveCliConfig,
} from './config.js';
import { promptHidden } from './prompt.js';
import { secureMkdirP, secureWriteFile } from './secure-fs.js';
import {
  hasExplicitKeystoreSource,
  hasNonInteractivePassphrase,
  type SignerIntent,
} from './signer-options.js';

const SESSION_TTL_MS = 15 * 60 * 1000;

export interface GetClientOptions {
  /**
   * When true, ensures a Signer is attached. Resolution path depends on
   * `signerIntent`: if it carries non-interactive sources the loader
   * uses the SDK's Foundry helpers; otherwise it falls back to the
   * legacy session-cache + interactive prompt flow.
   */
  requiresSigner?: boolean;
  /**
   * When true, ensures `rpcUrl` is configured. The error message points
   * the user at `ospex init` so they don't have to dig through the
   * config file. Required for any commitments write (`submit`, `match`,
   * `approve`, `cancel`).
   */
  requiresChain?: boolean;
  /**
   * Per-invocation signer intent parsed from `--account` / etc. If
   * omitted, the loader treats this as "use the legacy path".
   */
  signerIntent?: SignerIntent;
}

export async function getClient(options: GetClientOptions = {}): Promise<OspexClient> {
  const config = await resolveCliConfig();
  if (options.requiresChain && !config.rpcUrl) {
    throw new Error(
      'No rpcUrl configured. Run `ospex init` to set one (Alchemy / Infura / QuickNode strongly recommended over public RPCs).',
    );
  }

  const clientOptions: Record<string, unknown> = {};
  if (config.apiUrl !== undefined) clientOptions.apiUrl = config.apiUrl;
  if (config.rpcUrl !== undefined) clientOptions.rpcUrl = config.rpcUrl;
  if (config.chainId !== undefined) clientOptions.chainId = config.chainId;

  if (options.requiresSigner) {
    clientOptions.signer = await loadSigner(options.signerIntent);
  }

  return new OspexClient(clientOptions);
}

interface SessionFile {
  address: string;
  privateKey: string;
  expiresAt: number;
}

/**
 * Load a signer following the safety-ordered precedence:
 *
 *   0. Materialize env-only sources into intent. `OSPEX_KEYSTORE_PATH`
 *      becomes `intent.keystorePath` so downstream resolution works.
 *      Config `keystorePath` is intentionally NOT materialized — it's
 *      an implicit default that shouldn't override the legacy session
 *      cache.
 *
 *   1. **Explicit keystore source** (intent.account or
 *      intent.keystorePath, including env-materialized OSPEX_KEYSTORE_PATH).
 *      Never consults the legacy session cache — the user / agent
 *      asked for THIS specific keystore. Resolution within this path:
 *        a. Non-interactive passphrase source available → silent SDK
 *           helper unlock.
 *        b. No non-interactive source → SDK helper unlock with an
 *           interactive passphrase prompt.
 *
 *   2. **Legacy session cache** (no explicit intent). `~/.ospex/session`
 *      if a fresh entry exists.
 *
 *   3. **Legacy default** (no intent, no session). Read keystore from
 *      `~/.ospex/keystore.json` or `config.keystorePath`, prompt
 *      interactively for the passphrase.
 *
 *   4. Final `expectedAddress` guard. If the intent carries an
 *      expected address, compare it against the unlocked signer's
 *      address. The SDK-helper path also validates internally; this
 *      guard catches paths 2 and 3 where the SDK helper isn't on the
 *      critical line. Throws `OspexSignerResolutionError({ reason:
 *      'address_mismatch' })` on mismatch — agent guardrail against
 *      signing with the wrong wallet.
 *
 * `intent` is optional. When omitted, only paths 2-3 apply.
 */
export async function loadSigner(intent?: SignerIntent): Promise<Signer> {
  const envMaterialized = materializeIntent(intent ?? {});
  const resolvedIntent = await mergeIntentFromConfig(envMaterialized);
  const signer = await resolveSignerByPrecedence(resolvedIntent);

  // Final address guard (covers paths 2 and 3). The SDK-helper paths
  // (path 1) already enforce expectedAddress internally and throw
  // before reaching this check, but the legacy session-cache and
  // default-keystore paths don't — without this guard, expectedAddress
  // is silently ignored on those paths.
  if (resolvedIntent.expectedAddress !== undefined) {
    const actual = (await signer.getAddress()).toLowerCase() as `0x${string}`;
    const expected = resolvedIntent.expectedAddress.toLowerCase() as `0x${string}`;
    if (actual !== expected) {
      throw new OspexSignerResolutionError(
        `Resolved wallet ${actual} does not match --expected-address ${resolvedIntent.expectedAddress}. ` +
          'For agent safety, the unlock was rejected — re-run with the correct keystore source or remove --expected-address.',
        {
          reason: 'address_mismatch',
          expectedAddress: resolvedIntent.expectedAddress,
          actualAddress: actual,
        },
      );
    }
  }

  return signer;
}

/**
 * Walk the precedence ladder (paths 1-3 of `loadSigner`). Pulled out
 * from `loadSigner` so the final `expectedAddress` guard runs against
 * every branch uniformly.
 */
async function resolveSignerByPrecedence(intent: SignerIntent): Promise<Signer> {
  // Path 1: Explicit keystore source. Skips session cache.
  if (intent.account !== undefined || intent.keystorePath !== undefined) {
    return loadSignerNonInteractive(intent, !hasNonInteractivePassphrase(intent));
  }

  // Path 2: Legacy session cache.
  const session = await readSession();
  if (session) {
    return KeystoreSigner.fromPrivateKey(session.privateKey as `0x${string}`);
  }

  // Path 3: Legacy default keystore + interactive prompt.
  const json = await readKeystore();
  const passphrase = await promptHidden('Keystore passphrase: ');
  return KeystoreSigner.unlock(json, passphrase);
}

/**
 * Materialize env-only signer sources into the intent so downstream
 * code can treat env-set values the same as flag-set ones. Without
 * this, `OSPEX_KEYSTORE_PATH` was a "ghost source" —
 * `hasExplicitKeystoreSource` saw it but `loadSignerNonInteractive`
 * passed `undefined` to the SDK helper, which then threw
 * `keystore_not_found` (review blocker #3).
 *
 * Also materializes `OSPEX_PASSWORD_FILE` so the precedence ladder
 * (flag > env > config) is enforceable in one place. The SDK helper
 * still has its own env fallback for direct programmatic consumers,
 * but the CLI layer short-circuits before that fires.
 *
 * Config keystorePath / passwordFile are NOT materialized here.
 * Config-pinned values flow through `mergeIntentFromConfig` below;
 * the split keeps env-precedence-over-config explicit (this function
 * runs first, the config merge fills only what's still empty).
 */
function materializeIntent(intent: SignerIntent): SignerIntent {
  const result: SignerIntent = { ...intent };
  if (result.account === undefined && result.keystorePath === undefined) {
    const envPath = process.env.OSPEX_KEYSTORE_PATH;
    if (envPath !== undefined && envPath !== '') {
      result.keystorePath = expandTilde(envPath);
    }
  }
  if (result.passwordFile === undefined && result.fromStdin !== true) {
    const envPwFile = process.env.OSPEX_PASSWORD_FILE;
    if (envPwFile !== undefined && envPwFile !== '') {
      result.passwordFile = expandTilde(envPwFile);
    }
  }
  // Foundry keystores dir env precedence: OSPEX_FOUNDRY_KEYSTORES_DIR
  // > FOUNDRY_DIR/keystores. Lifting here means env beats
  // `mergeIntentFromConfig`'s lift of `config.foundryKeystoresDir` —
  // matching the documented flag > env > config ordering.
  // Review blocker #3.
  if (result.foundryKeystoresDir === undefined) {
    const envOspex = process.env.OSPEX_FOUNDRY_KEYSTORES_DIR;
    if (envOspex !== undefined && envOspex !== '') {
      result.foundryKeystoresDir = expandTilde(envOspex);
    } else {
      const foundryDir = process.env.FOUNDRY_DIR;
      if (foundryDir !== undefined && foundryDir !== '') {
        result.foundryKeystoresDir = path.join(expandTilde(foundryDir), 'keystores');
      }
    }
  }
  return result;
}

/**
 * Merge `auth use-foundry`-pinned config defaults into the intent.
 * Runs after `materializeIntent` so env beats config (env-materialized
 * intent fields already populated; this function only fills what's
 * still empty).
 *
 * Precedence end-to-end:
 *
 *   flag       → highest, set in `parseSignerIntent`
 *   env var    → next, populated by `materializeIntent`
 *   config     → next, populated by this function
 *   default    → lowest, hard-coded in the helpers
 *
 * `expectedAddress` from config is always lowercased (the config
 * writer also normalizes) so the final `loadSigner` guard compares
 * cleanly.
 */
async function mergeIntentFromConfig(intent: SignerIntent): Promise<SignerIntent> {
  const result: SignerIntent = { ...intent };
  const config = await loadConfigFile();

  // Keystore source: lift `config.foundryAccount` OR
  // `config.foundryKeystorePath` (both set only by `ospex auth
  // use-foundry`). NOT the legacy `config.keystorePath` from
  // `ospex init` — that field stays the path-3 fallback consumed
  // by `readKeystore`, preserving today's `wallet unlock` UX for
  // users with only `init`-pinned values.
  //
  // Track whether we lifted from config — this determines whether
  // the config-pinned `expectedAddress` applies further down.
  let accountLiftedFromConfig = false;
  if (result.account === undefined && result.keystorePath === undefined) {
    if (config.foundryAccount !== undefined && config.foundryAccount !== '') {
      result.account = config.foundryAccount;
      accountLiftedFromConfig = true;
    } else if (
      config.foundryKeystorePath !== undefined &&
      config.foundryKeystorePath !== ''
    ) {
      result.keystorePath = expandTilde(config.foundryKeystorePath);
      accountLiftedFromConfig = true;
    }
  }

  // Passphrase source: only if intent has no file/stdin.
  if (result.passwordFile === undefined && result.fromStdin !== true) {
    if (config.passwordFile !== undefined && config.passwordFile !== '') {
      result.passwordFile = expandTilde(config.passwordFile);
    }
  }

  // Foundry keystores dir.
  if (result.foundryKeystoresDir === undefined) {
    if (
      config.foundryKeystoresDir !== undefined &&
      config.foundryKeystoresDir !== ''
    ) {
      result.foundryKeystoresDir = expandTilde(config.foundryKeystoresDir);
    }
  }

  // Expected-address pin (review blocker #4):
  //
  // The config-pinned address is a guardrail for "the configured
  // account always resolves here." It applies only when the result's
  // signer source actually corresponds to the configured one:
  //
  //   - We lifted the source from config (caller inherited it), OR
  //   - The caller's flag/env source equals the configured value
  //     (caller re-stated the same account — pin still relevant), OR
  //   - No explicit source was supplied at all (legacy default path
  //     uses the configured / default keystore).
  //
  // If a flag/env supplied a DIFFERENT account or keystore path, the
  // pinned address is for a different wallet and must NOT apply.
  if (result.expectedAddress === undefined) {
    if (config.expectedAddress !== undefined && config.expectedAddress !== '') {
      const noExplicitSource =
        result.account === undefined && result.keystorePath === undefined;
      const explicitMatchesConfigAccount =
        config.foundryAccount !== undefined &&
        config.foundryAccount !== '' &&
        result.account === config.foundryAccount;
      const explicitMatchesConfigKeystorePath =
        config.foundryKeystorePath !== undefined &&
        config.foundryKeystorePath !== '' &&
        result.keystorePath === expandTilde(config.foundryKeystorePath);
      if (
        accountLiftedFromConfig ||
        noExplicitSource ||
        explicitMatchesConfigAccount ||
        explicitMatchesConfigKeystorePath
      ) {
        result.expectedAddress = config.expectedAddress.toLowerCase() as `0x${string}`;
      }
    }
  }

  return result;
}

/**
 * Build the SDK-helper args from a `SignerIntent` and invoke
 * `KeystoreSigner.fromFoundryAccount` or `.fromKeystoreFile`. When
 * `interactiveFallback` is true and no non-interactive passphrase
 * source is configured, the function prompts for a passphrase and
 * passes it as `passphrase` (literal) to the helper.
 */
async function loadSignerNonInteractive(
  intent: SignerIntent,
  interactiveFallback = false,
): Promise<Signer> {
  let passphraseArg: { passphrase?: string; passwordFile?: string; fromStdin?: boolean } = {};
  if (intent.passwordFile !== undefined) {
    passphraseArg = { passwordFile: intent.passwordFile };
  } else if (intent.fromStdin === true) {
    passphraseArg = { fromStdin: true };
  } else if (interactiveFallback) {
    const passphrase = await promptHidden('Keystore passphrase: ');
    passphraseArg = { passphrase };
  }
  // else: no source supplied — let the SDK helper throw
  // `non_interactive_password_required` (the env-fallback path inside
  // the helper handles OSPEX_PASSWORD_FILE).

  const commonArgs: { expectedAddress?: `0x${string}` } = {};
  if (intent.expectedAddress !== undefined) commonArgs.expectedAddress = intent.expectedAddress;

  if (intent.account !== undefined) {
    const args: FromFoundryAccountArgs = {
      account: intent.account,
      ...passphraseArg,
      ...commonArgs,
    };
    if (intent.foundryKeystoresDir !== undefined) {
      args.foundryKeystoresDir = intent.foundryKeystoresDir;
    }
    return KeystoreSigner.fromFoundryAccount(args);
  }

  // intent.keystorePath is set — direct file path.
  const args: FromKeystoreFileArgs = {
    keystorePath: intent.keystorePath as string,
    ...passphraseArg,
    ...commonArgs,
  };
  return KeystoreSigner.fromKeystoreFile(args);
}

export async function readSession(): Promise<SessionFile | undefined> {
  const file = getSessionPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.address !== 'string' ||
    typeof obj.privateKey !== 'string' ||
    typeof obj.expiresAt !== 'number'
  ) {
    return undefined;
  }
  if (Date.now() >= obj.expiresAt) {
    await deleteSession();
    return undefined;
  }
  return obj as unknown as SessionFile;
}

export async function writeSession(address: string, privateKey: string): Promise<void> {
  await secureMkdirP(getOspexHome());
  const body: SessionFile = {
    address,
    privateKey,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  await secureWriteFile(getSessionPath(), JSON.stringify(body) + '\n');
}

export async function deleteSession(): Promise<void> {
  const file = getSessionPath();
  try {
    await fs.unlink(file);
  } catch (err) {
    if (!isFileNotFound(err)) throw err;
  }
}

async function readKeystore(): Promise<string> {
  const file = await getKeystorePath();
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) {
      throw new Error(
        `No keystore found at ${file}. Create one with Foundry — ` +
          '`cast wallet new ~/.foundry/keystores <name>` for a fresh wallet, ' +
          'or `cast wallet import <name>` for an existing private key — then ' +
          'run `ospex init` and supply that path when prompted for Keystore ' +
          'path (persists in ~/.ospex/config.json). For a per-shell override, ' +
          'set OSPEX_KEYSTORE_PATH instead. See docs/QUICKSTART.md.',
      );
    }
    throw err;
  }
}

/**
 * Resolve an address for `--json` preview-only flows without prompting
 * for a passphrase. Precedence:
 *
 *   1. `intent.expectedAddress` — explicit override, zero I/O.
 *
 *   2. **Explicit keystore source** (intent.account or
 *      intent.keystorePath, including env-materialized OSPEX_KEYSTORE_PATH).
 *      - Has non-interactive passphrase source → silent unlock,
 *        derive address.
 *      - No non-interactive passphrase → throw. Preview-only mode
 *        can't prompt; the caller picked an explicit account so we
 *        must not fall back to a different one (the cached session
 *        signer).
 *
 *   3. Legacy session cache (`ospex wallet unlock` was already run).
 *
 *   4. Else throw `OspexSignerResolutionError({ reason:
 *      'non_interactive_password_required' })`. The CLI command
 *      surfaces this with an actionable message.
 *
 * Used by `commitments submit` / `commitments match` in their
 * `--json` (preview-only) branches. Sign-mode flows take the regular
 * `loadSigner` path instead.
 */
export async function resolvePreviewAddress(intent: SignerIntent): Promise<`0x${string}`> {
  // 1. Explicit expected-address wins. Zero I/O — preserves agent's
  //    "I told you who I am" assertion without unlocking. Note: this
  //    fires for the per-invocation flag only. Config-pinned
  //    `expectedAddress` is merged below; if no flag was passed, it
  //    becomes the override after `mergeIntentFromConfig` runs.
  if (intent.expectedAddress !== undefined) {
    return intent.expectedAddress;
  }

  const envMaterialized = materializeIntent(intent);
  const resolvedIntent = await mergeIntentFromConfig(envMaterialized);

  // After config merge: re-check expectedAddress. If `auth
  // use-foundry` pinned an address, it's now in resolvedIntent and
  // we can use it without unlocking.
  if (resolvedIntent.expectedAddress !== undefined) {
    return resolvedIntent.expectedAddress;
  }

  // 2. Explicit keystore source — must NOT fall through to the
  //    session cache (review blocker #1). If we can't unlock non-
  //    interactively, throw — preview-only can't prompt.
  if (resolvedIntent.account !== undefined || resolvedIntent.keystorePath !== undefined) {
    if (!hasNonInteractivePassphrase(resolvedIntent)) {
      throw new OspexSignerResolutionError(
        'Explicit --account / --keystore-path requires --password-file, --password-stdin, ' +
          'or OSPEX_PASSWORD_FILE for preview-only mode. Either supply a passphrase source, ' +
          'or pass --expected-address to skip the unlock entirely.',
        { reason: 'non_interactive_password_required' },
      );
    }
    const signer = await loadSignerNonInteractive(resolvedIntent);
    return (await signer.getAddress()).toLowerCase() as `0x${string}`;
  }

  // 3. Cached session — only when no explicit intent.
  const session = await readSession();
  if (session) {
    return session.address.toLowerCase() as `0x${string}`;
  }

  // 4. Nothing — error with a three-path remediation message.
  throw new OspexSignerResolutionError(
    'Preview-only `--json` mode needs a non-interactive signer source. ' +
      'Pass --expected-address <0x...>, or --account <name> --password-file <path>, ' +
      'or run `ospex wallet unlock` first.',
    { reason: 'non_interactive_password_required' },
  );
}
