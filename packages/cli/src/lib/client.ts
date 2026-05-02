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
 * Why plain on disk: an OS-keychain integration (DPAPI on Windows,
 * Keychain on macOS, libsecret on Linux) is the right answer but
 * cross-platform glue is heavyweight for a v1. We documented the
 * tradeoff in the README and rely on the user-profile directory's
 * ACL plus 0600 permissions to limit exposure. If a higher-assurance
 * model is required, run write commands without `wallet unlock` —
 * each one prompts for the passphrase inline and never writes the
 * decrypted key to disk.
 */

import { promises as fs } from 'node:fs';
import { OspexClient, type Signer } from '@ospex/sdk';
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';
import { getKeystorePath, getSessionPath, isFileNotFound, resolveCliConfig } from './config.js';
import { promptHidden } from './prompt.js';

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
  const file = getSessionPath();
  await fs.mkdir(getOspexDir(), { recursive: true });
  const body: SessionFile = {
    address,
    privateKey,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  await fs.writeFile(file, JSON.stringify(body) + '\n', { mode: 0o600 });
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

function getOspexDir(): string {
  // Defer to config.ts for the directory selection; recomputing here
  // avoids a cycle with the side-effect-free getter.
  const sessionFile = getSessionPath();
  return sessionFile.slice(0, sessionFile.length - '/session'.length);
}
