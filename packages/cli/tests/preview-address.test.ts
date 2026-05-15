/**
 * Tests for `resolvePreviewAddress` in `lib/client.ts` — the helper
 * that `commitments submit --json` / `commitments match --json` use
 * to derive a maker/taker address WITHOUT triggering a keystore
 * unlock. Spec §17.2.
 *
 * Branches verified:
 *   - `--expected-address` set → return it as-is. Zero I/O.
 *   - Legacy session cache (`~/.ospex/session`) present → use cached
 *     address, no decrypt.
 *   - Nothing supplied → throw `non_interactive_password_required`.
 *
 * The non-interactive-credentials branch (`--account` + `--password-file`)
 * is covered by the SDK-helper integration tests in
 * `packages/sdk/tests/signers-foundry.test.ts` and the prepareMatch
 * override tests; this file focuses on the CLI's specific routing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OspexSignerResolutionError } from '@ospex/sdk';
import { resolvePreviewAddress } from '../src/lib/client.js';

const EXPECTED: `0x${string}` = '0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34';
const SESSION_ADDR: `0x${string}` = '0xcd34ef56cd34ef56cd34ef56cd34ef56cd34ef56';

let tmpDir: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-preview-address-'));
  prevHome = process.env.OSPEX_HOME;
  process.env.OSPEX_HOME = tmpDir;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OSPEX_HOME;
  else process.env.OSPEX_HOME = prevHome;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSession(payload: {
  address: string;
  privateKey: string;
  expiresAt: number;
}): Promise<void> {
  const sessionPath = path.join(tmpDir, 'session');
  await fs.writeFile(sessionPath, JSON.stringify(payload) + '\n');
}

describe('resolvePreviewAddress — expected-address branch', () => {
  it('returns intent.expectedAddress as-is when set (zero I/O)', async () => {
    const result = await resolvePreviewAddress({ expectedAddress: EXPECTED });
    expect(result).toBe(EXPECTED);
  });

  it('returns expectedAddress even when conflicting non-interactive intent is present', async () => {
    // Precedence: --expected-address wins over any credential source.
    // This lets agents pin the address even when they have credentials
    // configured (e.g. for multi-wallet flows).
    const result = await resolvePreviewAddress({
      expectedAddress: EXPECTED,
      account: 'maker-a',
      passwordFile: '/nope',
    });
    expect(result).toBe(EXPECTED);
  });
});

describe('resolvePreviewAddress — cached-session branch', () => {
  it('returns the session address when a fresh session is on disk', async () => {
    await writeSession({
      address: SESSION_ADDR,
      privateKey: '0x'.padEnd(66, '1'),
      expiresAt: Date.now() + 60_000,
    });
    const result = await resolvePreviewAddress({});
    expect(result.toLowerCase()).toBe(SESSION_ADDR);
  });

  it('falls through (throws) when the session has expired', async () => {
    await writeSession({
      address: SESSION_ADDR,
      privateKey: '0x'.padEnd(66, '1'),
      expiresAt: Date.now() - 60_000,
    });
    await expect(resolvePreviewAddress({})).rejects.toMatchObject({
      name: 'OspexSignerResolutionError',
      reason: 'non_interactive_password_required',
    });
  });
});

describe('resolvePreviewAddress — empty-intent branch', () => {
  it('throws non_interactive_password_required when nothing is configured', async () => {
    await expect(resolvePreviewAddress({})).rejects.toBeInstanceOf(
      OspexSignerResolutionError,
    );
    await expect(resolvePreviewAddress({})).rejects.toMatchObject({
      reason: 'non_interactive_password_required',
    });
  });

  it("error message hints at the three actionable next steps", async () => {
    try {
      await resolvePreviewAddress({});
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OspexSignerResolutionError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/--expected-address/);
      expect(msg).toMatch(/--account/);
      expect(msg).toMatch(/--password-file/);
      expect(msg).toMatch(/wallet unlock/);
    }
  });
});
