/**
 * Foundry-keystore resolver and passphrase reader for non-interactive
 * signing. Underpins `KeystoreSigner.fromFoundryAccount` and
 * `KeystoreSigner.fromKeystoreFile` (in `keystore.ts`) and is exposed
 * directly so programmatic agents that want fine-grained control can
 * compose the pieces themselves.
 *
 * Design boundaries:
 *
 *   - This module does file I/O. The base `KeystoreSigner` is pure
 *     in-memory; the helpers here add disk + env reads layered on top
 *     so consumers can stay agent-friendly without re-implementing
 *     the same boilerplate.
 *
 *   - No interactive prompts here. The CLI's `loadSigner` wraps these
 *     helpers and adds an interactive `promptHidden` fallback when
 *     non-interactive sources are absent. Direct SDK consumers get an
 *     `OspexSignerResolutionError({ reason: 'non_interactive_password_required' })`
 *     in the same situation.
 *
 *   - The decrypted private key never crosses a function boundary in
 *     this file. Decryption happens in `KeystoreSigner.unlock` (called
 *     by the static methods in `keystore.ts`), and the resulting
 *     signer keeps the key inside its closure.
 *
 *   - Env vars are read here as a fallback for SDK direct consumers
 *     (`OSPEX_FOUNDRY_KEYSTORES_DIR`, `FOUNDRY_DIR`,
 *     `OSPEX_PASSWORD_FILE`). The CLI passes explicit options it
 *     resolved from its own env+config layer; explicit options always
 *     win over env here.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OspexSignerResolutionError } from '../errors.js';

const DEFAULT_FOUNDRY_KEYSTORES_DIR = path.join(
  os.homedir(),
  '.foundry',
  'keystores',
);

/** Resolved keystore source — used by `fromFoundryAccount` / `fromKeystoreFile`. */
export interface KeystoreSource {
  /** Absolute (or resolved-from-cwd) path to the v3 keystore JSON. */
  keystorePath: string;
  /** Where the path came from — helps render meaningful diagnostics. */
  origin: 'account' | 'keystorePath';
  /** The Foundry account name when `origin === 'account'`. */
  account?: string;
}

export interface ResolveKeystoreSourceArgs {
  /** Foundry account name. Resolves to `<foundryKeystoresDir>/<account>`. */
  account?: string;
  /** Absolute path to a v3 keystore JSON. Mutually exclusive with `account`. */
  keystorePath?: string;
  /**
   * Override the Foundry keystores directory. Default precedence (high
   * to low): this option, `OSPEX_FOUNDRY_KEYSTORES_DIR`,
   * `$FOUNDRY_DIR/keystores`, `~/.foundry/keystores`.
   */
  foundryKeystoresDir?: string;
  /** Test-injectable env. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve a keystore source from either a Foundry account name or an
 * explicit path. Validates the resulting file exists; throws otherwise.
 *
 * Throws:
 *   - `account_and_path_conflict` — both provided
 *   - `keystore_not_found`        — neither provided, or the resolved
 *                                    path doesn't exist on disk
 */
export async function resolveKeystoreSource(
  args: ResolveKeystoreSourceArgs,
): Promise<KeystoreSource> {
  const hasAccount = args.account !== undefined && args.account.length > 0;
  const hasPath = args.keystorePath !== undefined && args.keystorePath.length > 0;

  if (hasAccount && hasPath) {
    throw new OspexSignerResolutionError(
      "Both 'account' and 'keystorePath' were supplied — pass exactly one.",
      { reason: 'account_and_path_conflict' },
    );
  }

  if (hasPath) {
    const p = args.keystorePath as string;
    if (!(await fileExists(p))) {
      throw new OspexSignerResolutionError(
        `Keystore not found at ${p}.`,
        { reason: 'keystore_not_found', path: p },
      );
    }
    return { keystorePath: p, origin: 'keystorePath' };
  }

  if (hasAccount) {
    const account = args.account as string;
    const dir = resolveFoundryKeystoresDir(args);
    const p = path.join(dir, account);
    if (!(await fileExists(p))) {
      throw new OspexSignerResolutionError(
        `Foundry account '${account}' not found at ${p}. ` +
          `Verify the account name (try \`cast wallet list\`) and the keystores directory.`,
        { reason: 'keystore_not_found', path: p },
      );
    }
    return { keystorePath: p, origin: 'account', account };
  }

  throw new OspexSignerResolutionError(
    "Neither 'account' nor 'keystorePath' was supplied to resolveKeystoreSource.",
    { reason: 'keystore_not_found' },
  );
}

/** Resolved passphrase source. */
export interface PassphraseSource {
  /** The passphrase, with any trailing newline already trimmed. */
  passphrase: string;
  /**
   * Where it came from.
   *   - 'literal' — passed directly as a string (SDK programmatic only)
   *   - 'file'    — `passwordFile`
   *   - 'stdin'   — `fromStdin: true`
   *   - 'env'     — `OSPEX_PASSWORD_FILE` env fallback
   */
  origin: 'literal' | 'file' | 'stdin' | 'env';
  /** The file path when `origin === 'file' | 'env'`. */
  filePath?: string;
}

export interface ReadPassphraseArgs {
  /**
   * Literal passphrase. Available for SDK programmatic use (e.g. a
   * caller that just fetched the passphrase from a secrets manager).
   * Not exposed on the CLI — CLI consumers should use `passwordFile`
   * or `fromStdin` so secrets never land in shell history or process
   * listings.
   */
  passphrase?: string;
  /** Path to a file containing the passphrase. Trailing newline trimmed. */
  passwordFile?: string;
  /** Read the passphrase from stdin (first line, trailing newline trimmed). */
  fromStdin?: boolean;
  /**
   * Allow `OSPEX_PASSWORD_FILE` env fallback. Default `true`. Set to
   * `false` for hermetic tests or to enforce that the caller specified
   * a source explicitly.
   */
  readEnv?: boolean;
  /** Test-injectable env. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test-injectable stdin reader. Defaults to a single-line stdin read. */
  stdinReader?: () => Promise<string>;
}

/**
 * Read a passphrase from one of the supported sources. Exactly one
 * explicit source (`passphrase` / `passwordFile` / `fromStdin`) may be
 * supplied; when none is supplied and `readEnv` is enabled,
 * `OSPEX_PASSWORD_FILE` is consulted; otherwise a
 * `non_interactive_password_required` error is thrown so the caller
 * can decide whether to fall back to an interactive prompt (CLI) or
 * surface the error to the user (programmatic).
 *
 * Throws:
 *   - `password_source_conflict`          — multiple explicit sources
 *   - `password_file_not_found`           — file path doesn't exist
 *   - `non_interactive_password_required` — no source resolved
 */
export async function readPassphrase(
  args: ReadPassphraseArgs,
): Promise<PassphraseSource> {
  const explicit: Array<'literal' | 'file' | 'stdin'> = [];
  if (args.passphrase !== undefined) explicit.push('literal');
  if (args.passwordFile !== undefined) explicit.push('file');
  if (args.fromStdin === true) explicit.push('stdin');

  if (explicit.length > 1) {
    throw new OspexSignerResolutionError(
      `Multiple passphrase sources supplied (${explicit.join(', ')}). Pick one.`,
      { reason: 'password_source_conflict' },
    );
  }

  if (explicit.length === 1) {
    const which = explicit[0] as 'literal' | 'file' | 'stdin';
    if (which === 'literal') {
      return { passphrase: args.passphrase as string, origin: 'literal' };
    }
    if (which === 'file') {
      const filePath = args.passwordFile as string;
      const passphrase = await readPasswordFile(filePath);
      return { passphrase, origin: 'file', filePath };
    }
    const reader = args.stdinReader ?? readStdinLine;
    const passphrase = trimTrailingNewline(await reader());
    return { passphrase, origin: 'stdin' };
  }

  if (args.readEnv !== false) {
    const env = args.env ?? process.env;
    const envFile = env.OSPEX_PASSWORD_FILE;
    if (typeof envFile === 'string' && envFile.length > 0) {
      const passphrase = await readPasswordFile(envFile);
      return { passphrase, origin: 'env', filePath: envFile };
    }
  }

  throw new OspexSignerResolutionError(
    'No passphrase source supplied. Pass passwordFile, fromStdin, or set OSPEX_PASSWORD_FILE.',
    { reason: 'non_interactive_password_required' },
  );
}

/** Result of `checkPasswordFilePermissions`. */
export interface PermissionCheckResult {
  /** The file's POSIX mode bits, masked to the lower 9 (rwxrwxrwx). */
  mode: number;
  /**
   * `true` when group or other has any rwx bit set — i.e., `mode & 0o077`
   * is non-zero. `false` on Windows (see `platformSkipped`).
   */
  loose: boolean;
  /** `true` on Windows — POSIX permission semantics don't meaningfully apply. */
  platformSkipped: boolean;
}

/**
 * Inspect a password file's POSIX permissions. Returns a structured
 * result rather than throwing — the SDK is informational; consumers
 * (CLI default vs `--strict`) decide policy.
 *
 * On Windows, returns `{ mode: 0, loose: false, platformSkipped: true }`
 * — Windows file ACLs don't map cleanly onto POSIX bits and our agent
 * deployments are Linux-first.
 *
 * Use the result to drive a warning (default) or an
 * `OspexSignerResolutionError({ reason: 'password_file_permissions_loose' })`
 * (strict mode, in PR 4's `ospex auth check --strict`).
 */
export async function checkPasswordFilePermissions(
  filePath: string,
): Promise<PermissionCheckResult> {
  if (process.platform === 'win32') {
    return { mode: 0, loose: false, platformSkipped: true };
  }
  const st = await fs.stat(filePath);
  const mode = st.mode & 0o777;
  const loose = (mode & 0o077) !== 0;
  return { mode, loose, platformSkipped: false };
}

// ── internals ─────────────────────────────────────────────────────

function resolveFoundryKeystoresDir(
  args: { foundryKeystoresDir?: string; env?: NodeJS.ProcessEnv },
): string {
  if (args.foundryKeystoresDir !== undefined && args.foundryKeystoresDir.length > 0) {
    return args.foundryKeystoresDir;
  }
  const env = args.env ?? process.env;
  const explicitOspex = env.OSPEX_FOUNDRY_KEYSTORES_DIR;
  if (typeof explicitOspex === 'string' && explicitOspex.length > 0) {
    return explicitOspex;
  }
  const foundryDir = env.FOUNDRY_DIR;
  if (typeof foundryDir === 'string' && foundryDir.length > 0) {
    return path.join(foundryDir, 'keystores');
  }
  return DEFAULT_FOUNDRY_KEYSTORES_DIR;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPasswordFile(filePath: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) {
      throw new OspexSignerResolutionError(
        `Password file not found at ${filePath}.`,
        { reason: 'password_file_not_found', path: filePath, cause: err },
      );
    }
    throw err;
  }
  return trimTrailingNewline(raw);
}

/**
 * Strip a single trailing line ending (`\r\n`, `\n`, or `\r`).
 * Preserves all other whitespace so unusual passphrases survive intact.
 * Matches `cast`'s `--password-file` behavior.
 */
function trimTrailingNewline(s: string): string {
  if (s.endsWith('\r\n')) return s.slice(0, -2);
  if (s.endsWith('\n') || s.endsWith('\r')) return s.slice(0, -1);
  return s;
}

function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Read a single line from stdin. Used by `readPassphrase` when
 * `fromStdin: true` and the caller didn't inject a custom reader.
 * Bare-bones — sufficient for `cat pw.pass | ospex submit … --password-stdin`.
 */
function readStdinLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const stream = process.stdin;
    stream.setEncoding('utf8');

    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };

    const onData = (chunk: string) => {
      const newlineIdx = chunk.indexOf('\n');
      if (newlineIdx >= 0) {
        buffer += chunk.slice(0, newlineIdx);
        cleanup();
        stream.pause();
        resolve(buffer);
      } else {
        buffer += chunk;
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(buffer);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    // If stdin was paused (e.g., previous reader), nudge it.
    stream.resume();
  });
}
