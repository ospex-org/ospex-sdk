/**
 * Command-level failure-envelope tests — execute the REAL catch paths
 * via `parseAsync`, with a dead API URL forcing the SDK's first
 * network call to throw. The captured stdout is the v2 failure
 * envelope the command's catch emitted; assertions check the actual
 * runtime contract, not just hand-picked `emitJsonFailure(...)` args.
 *
 * Scope (per review round 2 ask):
 *   1. `commitments submit --json --expected-address <addr>` against
 *      a dead API.
 *      Expect: stage='preview', requiresSignature=true,
 *      requiresTransaction=false (no approval was attempted in the
 *      preview path).
 *   2. `claim-all --dry-run --address <addr> --json` against a dead
 *      API.
 *      Expect: stage='dry-run', requiresSignature=true,
 *      requiresTransaction=true (dry-run plan describes a write),
 *      wallet=<addr> (subject context), walletRole='subject',
 *      signer=null.
 *
 * Mechanism: write a tmp config + env override pointing apiUrl at the
 * IPv4 discard port (127.0.0.1:9), stub `process.exit` (action calls
 * it after emitting), and capture stdout via a stream-write override.
 * No mocks of `getClient` or `@ospex/sdk` — the actual SDK runs, just
 * against an unreachable endpoint, exercising the same code path a
 * real network outage would.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hex } from '@ospex/sdk';
import { commitmentsSubmitCommand } from '../src/commands/commitments/submit.js';
import { commitmentsMatchCommand } from '../src/commands/commitments/match.js';
import { positionsClaimAllCommand } from '../src/commands/positions/claim-all.js';

const DEAD_API_URL = 'http://127.0.0.1:9';

let tmpDir: string;
const envSnapshot: Record<string, string | undefined> = {};

function snapshotEnv(...keys: string[]): void {
  for (const k of keys) envSnapshot[k] = process.env[k];
}

function restoreEnv(...keys: string[]): void {
  for (const k of keys) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-cmd-failure-'));
  snapshotEnv('OSPEX_HOME', 'OSPEX_API_URL', 'OSPEX_RPC_URL', 'OSPEX_CHAIN_ID');
  process.env.OSPEX_HOME = tmpDir;
  process.env.OSPEX_API_URL = DEAD_API_URL;
  process.env.OSPEX_RPC_URL = 'http://127.0.0.1:9';
  process.env.OSPEX_CHAIN_ID = '137';
  await fs.writeFile(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({ apiUrl: DEAD_API_URL, rpcUrl: 'http://127.0.0.1:9', chainId: 137 }, null, 2),
  );
});

afterEach(async () => {
  restoreEnv('OSPEX_HOME', 'OSPEX_API_URL', 'OSPEX_RPC_URL', 'OSPEX_CHAIN_ID');
  await fs.rm(tmpDir, { recursive: true, force: true });
});

interface CapturedRun {
  stdout: string;
  exitCode: number;
}

class ProcessExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

/**
 * Invoke a command's `parseAsync` while:
 *   - capturing every stdout write into a string
 *   - intercepting `process.exit` so the action's
 *     `emitJsonFailure(...); process.exit(1)` doesn't kill the test
 *     process
 *
 * Returns the captured stdout + the exit code the action requested.
 */
async function runActionAndCaptureFailure(
  fn: () => Promise<unknown>,
): Promise<CapturedRun> {
  let stdout = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;

  let exitCode = 0;
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new ProcessExitSignal(exitCode);
    }) as never);

  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ProcessExitSignal)) {
      process.stdout.write = origWrite;
      exitSpy.mockRestore();
      throw err;
    }
  } finally {
    process.stdout.write = origWrite;
    exitSpy.mockRestore();
  }

  return { stdout, exitCode };
}

describe('commitments submit — command-level failure envelope (preview mode, dead API)', () => {
  it('preview path with --expected-address: stage=preview, sig:true, tx:false, walletRole=signer', async () => {
    const ADDRESS = ('0x' + 'ab'.repeat(20)) as Hex;
    const { stdout, exitCode } = await runActionAndCaptureFailure(() =>
      commitmentsSubmitCommand.parseAsync(
        [
          '--contest',
          '42',
          '--market',
          'moneyline',
          '--side',
          'home',
          '--odds',
          '2.0',
          '--risk-usdc',
          '5',
          '--expected-address',
          ADDRESS,
          '--json',
        ],
        { from: 'user' },
      ),
    );

    expect(exitCode).toBe(1);
    const env = JSON.parse(stdout.trim()) as {
      ok: boolean;
      action: string;
      stage: string;
      wallet: string | null;
      walletRole: string;
      signer: string | null;
      requiresSignature: boolean;
      requiresTransaction: boolean;
      effects: unknown[];
      errors: Array<{ code: string }>;
    };

    expect(env.ok).toBe(false);
    expect(env.action).toBe('commitments.submit');
    expect(env.stage).toBe('preview');
    // Spec §3.2: preview-only sign envelopes are signer-intent
    // envelopes — the resolved-no-unlock address is the would-be
    // signer if `--yes` were passed. Failure envelopes mirror the
    // success-path contract here (see toSubmitPreviewEnvelope).
    expect(env.wallet).toBe(ADDRESS);
    expect(env.walletRole).toBe('signer');
    expect(env.signer).toBe(ADDRESS);
    // Preview path can't sign or send. requiresSignature reflects what
    // the command WOULD sign (true — submit's intent is to sign).
    // requiresTransaction reflects whether this run attempted a tx:
    // it didn't, so false.
    expect(env.requiresSignature).toBe(true);
    expect(env.requiresTransaction).toBe(false);
    expect(env.effects).toEqual([]);
    expect(env.errors.length).toBeGreaterThan(0);
  });
});

describe('commitments match — command-level failure envelope (preview mode, dead API)', () => {
  it('preview path with --expected-address: stage=preview, sig:true, tx:true, walletRole=signer', async () => {
    const ADDRESS = ('0x' + 'ef'.repeat(20)) as Hex;
    // A 32-byte hex string for the prefix-resolver argument. Match's
    // preview path runs `resolveByPrefix` against the API first, which
    // is the call that should fail against the dead host. The exact
    // hash bytes don't need to correspond to a real commitment — they
    // just need to be syntactically valid so commander accepts the
    // positional.
    const HASH = '0x' + 'a'.repeat(64);
    const { stdout, exitCode } = await runActionAndCaptureFailure(() =>
      commitmentsMatchCommand.parseAsync(
        [HASH, '--expected-address', ADDRESS, '--json'],
        { from: 'user' },
      ),
    );

    expect(exitCode).toBe(1);
    const env = JSON.parse(stdout.trim()) as {
      ok: boolean;
      action: string;
      stage: string;
      wallet: string | null;
      walletRole: string;
      signer: string | null;
      requiresSignature: boolean;
      requiresTransaction: boolean;
      effects: unknown[];
      errors: Array<{ code: string }>;
    };

    expect(env.ok).toBe(false);
    expect(env.action).toBe('commitments.match');
    expect(env.stage).toBe('preview');
    // Same signer-intent contract as submit — preview-only sign
    // envelopes carry walletRole='signer', signer=wallet.
    expect(env.wallet).toBe(ADDRESS);
    expect(env.walletRole).toBe('signer');
    expect(env.signer).toBe(ADDRESS);
    // Match's execute path dispatches a tx; per spec §3.1 the
    // preview-stage signals "what would execute do", so both flags
    // are true even in preview mode (unlike submit, which is
    // fundamentally off-chain).
    expect(env.requiresSignature).toBe(true);
    expect(env.requiresTransaction).toBe(true);
    expect(env.effects).toEqual([]);
    expect(env.errors.length).toBeGreaterThan(0);
  });
});

describe('positions claim-all — command-level failure envelope (--dry-run --address, dead API)', () => {
  it('signer-free dry-run failure: stage=dry-run, sig:true, tx:true, wallet=address, role=subject', async () => {
    const ADDRESS = ('0x' + 'cd'.repeat(20)) as Hex;
    const { stdout, exitCode } = await runActionAndCaptureFailure(() =>
      positionsClaimAllCommand.parseAsync(
        ['--dry-run', '--address', ADDRESS, '--json'],
        { from: 'user' },
      ),
    );

    expect(exitCode).toBe(1);
    const env = JSON.parse(stdout.trim()) as {
      ok: boolean;
      action: string;
      stage: string;
      wallet: string | null;
      walletRole: string;
      signer: string | null;
      requiresSignature: boolean;
      requiresTransaction: boolean;
      errors: Array<{ code: string }>;
    };

    expect(env.ok).toBe(false);
    expect(env.action).toBe('claim-all');
    expect(env.stage).toBe('dry-run');
    // Dry-run plan describes a write — both flags MUST be true, even
    // though no signer is loaded for the explicit-address path.
    expect(env.requiresSignature).toBe(true);
    expect(env.requiresTransaction).toBe(true);
    // Subject context — the explicit address is the inspected wallet,
    // not the signer. Lower-cased per the envelope convention.
    expect(env.wallet).toBe(ADDRESS.toLowerCase());
    expect(env.walletRole).toBe('subject');
    expect(env.signer).toBeNull();
    expect(env.errors.length).toBeGreaterThan(0);
  });
});
