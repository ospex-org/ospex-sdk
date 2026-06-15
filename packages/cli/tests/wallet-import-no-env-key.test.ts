/**
 * Regression guard: `ospex wallet import` must NEVER read a raw private key
 * from an env var. The undocumented `OSPEX_IMPORT_PRIVATE_KEY` intake was
 * removed — it contradicted docs/AGENT_CONTRACT.md §4 ("The CLI never accepts
 * a raw passphrase or a raw private key as a CLI argument or env var").
 *
 * The test sets `OSPEX_IMPORT_PRIVATE_KEY` to a syntactically-valid key and
 * asserts the command STILL prompts for the key interactively (i.e. the env
 * var is ignored, not used as a first-precedence shortcut). `promptHidden` is
 * mocked to throw on first call so execution stops before any passphrase
 * prompt or keystore write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/lib/prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/prompt.js')>();
  return { ...actual, promptHidden: vi.fn() };
});

import { promptHidden } from '../src/lib/prompt.js';
import { walletImportCommand } from '../src/commands/wallet/import.js';

const KEY_PROMPT = 'Private key (0x…64 hex chars): ';
const ENV_KEY = `0x${'a'.repeat(64)}`;

let tmpDir: string;
let prevHome: string | undefined;
let prevImportKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-wallet-import-'));
  prevHome = process.env.OSPEX_HOME;
  prevImportKey = process.env.OSPEX_IMPORT_PRIVATE_KEY;
  process.env.OSPEX_HOME = tmpDir;
  vi.mocked(promptHidden).mockReset();
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OSPEX_HOME;
  else process.env.OSPEX_HOME = prevHome;
  if (prevImportKey === undefined) delete process.env.OSPEX_IMPORT_PRIVATE_KEY;
  else process.env.OSPEX_IMPORT_PRIVATE_KEY = prevImportKey;
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('wallet import — no raw-key env var', () => {
  it('ignores OSPEX_IMPORT_PRIVATE_KEY and always prompts for the key', async () => {
    process.env.OSPEX_IMPORT_PRIVATE_KEY = ENV_KEY;
    vi.mocked(promptHidden).mockRejectedValue(new Error('PROMPT_REACHED'));

    // --force skips the "keystore already exists" check so the action reaches
    // the key prompt regardless of host state; the mocked prompt then throws.
    await expect(
      walletImportCommand.parseAsync(['--force'], { from: 'user' }),
    ).rejects.toThrow('PROMPT_REACHED');

    // The proof: the key was requested interactively. On the old (removed)
    // code the env var short-circuited this call entirely.
    expect(promptHidden).toHaveBeenCalledWith(KEY_PROMPT);
  });
});
