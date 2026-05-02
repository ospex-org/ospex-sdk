/**
 * `getClient({ requiresSigner })` — the single entry point every
 * command uses to obtain a configured `OspexClient`. Layers config
 * sources (env > file > SDK defaults) and unlocks the keystore on
 * demand.
 *
 * Session-cache trade-off: when the user runs `ospex wallet unlock`,
 * we cache the *decrypted* private key in `~/.ospex/session` plain
 * JSON, with file mode 0600 on POSIX, expiry 15 minutes from write.
 *
 * 0600 keeps the file unreadable by *other* users on the host, but
 * does NOT defend against any process running as the same user — that
 * threat surface is unavoidable without an OS-keychain integration
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux), which is
 * out of scope for v1. If higher assurance is required, run write
 * commands without `wallet unlock` — each one prompts for the
 * passphrase inline and never writes the decrypted key to disk.
 *
 * Both the file and its parent directory are written via secure-fs.ts
 * (atomic temp + rename + defensive chmod) so an existing-file
 * overwrite tightens permissions back to 0600 / 0700 instead of
 * inheriting the prior mode.
 */

import { promises as fs } from 'node:fs';
import { OspexClient, type Signer } from '@ospex/sdk';
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';
import {
  getKeystorePath,
  getOspexHome,
  getSessionPath,
  isFileNotFound,
  resolveCliConfig,
} from './config.js';
import { promptHidden } from './prompt.js';
import { secureMkdirP, secureWriteFile } from './secure-fs.js';

const SESSION_TTL_MS = 15 * 60 * 1000;

export interface GetClientOptions {
  /** When true, ensures a Signer is attached (unlocking via session or prompt). */
  requiresSigner?: boolean;
}

export async function getClient(options: GetClientOptions = {}): Promise<OspexClient> {
  const config = await resolveCliConfig();
  const clientOptions: Record<string, unknown> = {};
  if (config.apiUrl !== undefined) clientOptions.apiUrl = config.apiUrl;
  if (config.supabaseUrl !== undefined) clientOptions.supabaseUrl = config.supabaseUrl;
  if (config.supabaseAnonKey !== undefined) clientOptions.supabaseAnonKey = config.supabaseAnonKey;

  if (options.requiresSigner) {
    clientOptions.signer = await loadSigner();
  }

  return new OspexClient(clientOptions);
}

interface SessionFile {
  address: string;
  privateKey: string;
  expiresAt: number;
}

export async function loadSigner(): Promise<Signer> {
  const session = await readSession();
  if (session) {
    return KeystoreSigner.fromPrivateKey(session.privateKey as `0x${string}`);
  }
  const json = await readKeystore();
  const passphrase = await promptHidden('Keystore passphrase: ');
  return KeystoreSigner.unlock(json, passphrase);
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
  const file = getKeystorePath();
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isFileNotFound(err)) {
      throw new Error(
        `No keystore found at ${file}. Run \`ospex wallet import\` to create one.`,
      );
    }
    throw err;
  }
}
