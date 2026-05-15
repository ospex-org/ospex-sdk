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
import { OspexClient, OspexSignerResolutionError, type Signer } from '@ospex/sdk';
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';
import type { FromFoundryAccountArgs, FromKeystoreFileArgs } from '@ospex/sdk/signers/keystore';
import {
  getKeystorePath,
  getOspexHome,
  getSessionPath,
  isFileNotFound,
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
  if (config.supabaseUrl !== undefined) clientOptions.supabaseUrl = config.supabaseUrl;
  if (config.supabaseAnonKey !== undefined) clientOptions.supabaseAnonKey = config.supabaseAnonKey;
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
 * Load a signer following the precedence:
 *   1. Non-interactive Foundry path — when `intent` carries an
 *      explicit `--account` / `--keystore-path` AND a passphrase
 *      source (`--password-file` / `--password-stdin` / `OSPEX_PASSWORD_FILE`).
 *      Uses the SDK helpers; never writes to the session cache.
 *   2. Legacy session cache — `~/.ospex/session` if a fresh entry
 *      exists.
 *   3. Legacy interactive — read keystore from `OSPEX_KEYSTORE_PATH`
 *      / config `keystorePath` / `~/.ospex/keystore.json`, prompt
 *      for the passphrase.
 *
 * `intent` is optional. When omitted, paths 2-3 apply.
 */
export async function loadSigner(intent?: SignerIntent): Promise<Signer> {
  // 1. Non-interactive Foundry path.
  if (intent !== undefined && canResolveNonInteractive(intent)) {
    return loadSignerNonInteractive(intent);
  }

  // 2. Legacy session cache.
  const session = await readSession();
  if (session) {
    return KeystoreSigner.fromPrivateKey(session.privateKey as `0x${string}`);
  }

  // 3. Legacy interactive — keystore path may come from intent's
  //    explicit override (account / keystorePath) or from the
  //    config/env fallback.
  if (intent !== undefined && (intent.account !== undefined || intent.keystorePath !== undefined)) {
    // No non-interactive passphrase source was supplied, but the
    // caller pointed at a specific keystore — use the SDK helpers
    // with an interactive prompt. This keeps `--account foo` working
    // even when the user didn't pass `--password-file`.
    const intentNoPwSource: SignerIntent = {};
    if (intent.account !== undefined) intentNoPwSource.account = intent.account;
    if (intent.keystorePath !== undefined) intentNoPwSource.keystorePath = intent.keystorePath;
    if (intent.expectedAddress !== undefined) intentNoPwSource.expectedAddress = intent.expectedAddress;
    if (intent.foundryKeystoresDir !== undefined) {
      intentNoPwSource.foundryKeystoresDir = intent.foundryKeystoresDir;
    }
    return loadSignerNonInteractive(intentNoPwSource, true);
  }

  const json = await readKeystore();
  const passphrase = await promptHidden('Keystore passphrase: ');
  return KeystoreSigner.unlock(json, passphrase);
}

/**
 * Returns true when `intent` carries enough information for a fully
 * non-interactive unlock — both a keystore source and a passphrase
 * source. The passphrase source can be the env var
 * `OSPEX_PASSWORD_FILE`; that's why this isn't a simple field check.
 */
function canResolveNonInteractive(intent: SignerIntent): boolean {
  return hasExplicitKeystoreSource(intent) && hasNonInteractivePassphrase(intent);
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
 *   2. Non-interactive credentials (`--account` + `--password-file`,
 *      or `OSPEX_PASSWORD_FILE` env, etc.) — silent unlock, derive
 *      the address from the resulting signer.
 *   3. Legacy session cache (`ospex wallet unlock` was already run).
 *   4. Else throw `OspexSignerResolutionError({ reason:
 *      'non_interactive_password_required' })`. The CLI command
 *      surfaces this with an actionable message — "pass
 *      --expected-address, or configure --account + --password-file".
 *
 * Used by `commitments submit` / `commitments match` in their
 * `--json` (preview-only) branches. Sign-mode flows take the regular
 * `loadSigner` path instead.
 */
export async function resolvePreviewAddress(intent: SignerIntent): Promise<`0x${string}`> {
  if (intent.expectedAddress !== undefined) {
    return intent.expectedAddress;
  }

  if (canResolveNonInteractive(intent)) {
    const signer = await loadSignerNonInteractive(intent);
    return (await signer.getAddress()).toLowerCase() as `0x${string}`;
  }

  const session = await readSession();
  if (session) {
    return session.address.toLowerCase() as `0x${string}`;
  }

  throw new OspexSignerResolutionError(
    'Preview-only `--json` mode needs a non-interactive signer source. ' +
      'Pass --expected-address <0x...>, or --account <name> --password-file <path>, ' +
      'or run `ospex wallet unlock` first.',
    { reason: 'non_interactive_password_required' },
  );
}
