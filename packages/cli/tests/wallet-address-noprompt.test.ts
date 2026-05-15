/**
 * Tests for the `noPrompt` option on `resolveWalletAddress` — the
 * doctor's safety guarantee that `--json` / non-TTY mode never blocks
 * on hidden-input read. When the cheap address-resolution paths fail
 * under `noPrompt: true`, the function throws `WalletAddressUnresolvedError`
 * with a stable reason code instead of prompting.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWalletAddress,
  WalletAddressUnresolvedError,
} from '../src/lib/walletAddress.js';

let tmpDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-walletaddr-noprompt-'));
  prevHome = process.env.OSPEX_HOME;
  process.env.OSPEX_HOME = tmpDir;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OSPEX_HOME;
  else process.env.OSPEX_HOME = prevHome;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('resolveWalletAddress with noPrompt', () => {
  it('returns the --address override without touching the keystore', async () => {
    const addr = '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd';
    const resolved = await resolveWalletAddress(addr, { noPrompt: true });
    expect(resolved).toBe(addr.toLowerCase());
  });

  it('throws keystore_not_found when no keystore exists and noPrompt=true', async () => {
    let caught: unknown;
    try {
      await resolveWalletAddress(undefined, { noPrompt: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WalletAddressUnresolvedError);
    expect((caught as WalletAddressUnresolvedError).reason).toBe('keystore_not_found');
  });

  it('throws password_source_missing when keystore exists without an address field and no session', async () => {
    // Write a Foundry-style keystore (no top-level `address` field).
    // No session cache exists in the fresh tmpdir, so the cheap paths
    // fall through and the no-prompt guard fires.
    const keystorePath = path.join(tmpDir, 'keystore.json');
    await fs.writeFile(
      keystorePath,
      JSON.stringify({
        id: 'placeholder',
        version: 3,
        // intentionally no top-level address field
        crypto: {
          cipher: 'aes-128-ctr',
          ciphertext: '00',
          cipherparams: { iv: '00' },
          kdf: 'scrypt',
          kdfparams: { dklen: 32, n: 8, p: 1, r: 8, salt: '00' },
          mac: '00',
        },
      }),
    );

    let caught: unknown;
    try {
      await resolveWalletAddress(undefined, { noPrompt: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WalletAddressUnresolvedError);
    expect((caught as WalletAddressUnresolvedError).reason).toBe('password_source_missing');
  });

  it('returns the in-keystore address field without prompting (legacy keystore)', async () => {
    const known = '0x1234567890abcdef1234567890abcdef12345678';
    const keystorePath = path.join(tmpDir, 'keystore.json');
    await fs.writeFile(
      keystorePath,
      JSON.stringify({
        id: 'placeholder',
        version: 3,
        address: known.replace(/^0x/, ''),
        crypto: {
          cipher: 'aes-128-ctr',
          ciphertext: '00',
          cipherparams: { iv: '00' },
          kdf: 'scrypt',
          kdfparams: { dklen: 32, n: 8, p: 1, r: 8, salt: '00' },
          mac: '00',
        },
      }),
    );

    const resolved = await resolveWalletAddress(undefined, { noPrompt: true });
    expect(resolved).toBe(known);
  });

  it('rejects malformed --address with a clear error', async () => {
    await expect(resolveWalletAddress('not-an-address', { noPrompt: true })).rejects.toThrow(
      /must be a 0x-prefixed/,
    );
  });
});
