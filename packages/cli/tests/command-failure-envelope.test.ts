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
import { commitmentsListCommand } from '../src/commands/commitments/list.js';
import { commitmentsFillabilityCommand } from '../src/commands/commitments/fillability.js';
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

/* ------------------------------------------------------------------ */
/* Read commands — the shoulder shapes the sweep cannot reach          */
/* ------------------------------------------------------------------ */

/**
 * `class-a-failure-envelope-sweep.test.ts` drives one argv per command, so a
 * command whose shoulder block DEPENDS on its arguments has exactly one of its
 * shapes covered there. These are the others.
 *
 * They are not extra credit. `commitments list` and `commitments fillability`
 * are the only two reads whose `walletRole` is computed rather than constant,
 * which makes them the two most likely to be wrong — and each is covered by
 * the sweep in the shape where the computation returns its DEFAULT, i.e. the
 * shape a broken computation would also produce.
 */
describe('read commands — argument-dependent shoulder shapes', () => {
  const MAKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const MAKER_LC = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
  const HASH = ('0x' + 'ab'.repeat(32)) as Hex;

  interface ReadEnvelope {
    ok: boolean;
    action: string;
    stage: string;
    wallet: string | null;
    walletRole: string;
    signer: string | null;
    requiresSignature: boolean;
    requiresTransaction: boolean;
    payload: unknown;
    errors: Array<{ code: string }>;
  }

  // The sweep runs `commitments list` with no flags, where `walletRole` is
  // 'none' — which is also what a build that ignored `--maker` entirely would
  // report. Only this case distinguishes the two.
  it('commitments list --maker: the address is a filter, not a subject', async () => {
    const { stdout, exitCode } = await runActionAndCaptureFailure(() =>
      commitmentsListCommand.parseAsync(['--maker', MAKER, '--json'], { from: 'user' }),
    );

    expect(exitCode).toBe(1);
    const env = JSON.parse(stdout.trim()) as ReadEnvelope;
    expect(env.ok).toBe(false);
    expect(env.action).toBe('commitments.list');
    expect(env.stage).toBe('read');
    expect(env.wallet).toBe(MAKER_LC);
    // 'filter', NOT 'subject' — §3.2: `--maker` selects rows, it does not make
    // that wallet the thing being read about. The success envelope of this
    // same invocation says 'filter'; a failure envelope that said 'subject'
    // would describe a different query than the one that was run.
    expect(env.walletRole).toBe('filter');
    expect(env.signer).toBeNull();
    expect(env.requiresSignature).toBe(false);
    expect(env.requiresTransaction).toBe(false);
    expect(env.payload).toBeNull();
  });

  // The sweep's `commitments fillability` row passes no --taker and configures
  // no signer, so it fails at `resolvePreviewAddress` with the subject still
  // unresolved and reports `wallet: null`. That is the DEFAULT branch. This
  // case takes the other one: the taker is known before the read, so a failure
  // of the read must still name it.
  it('commitments fillability --taker: names the resolved taker as the subject', async () => {
    const { stdout, exitCode } = await runActionAndCaptureFailure(() =>
      commitmentsFillabilityCommand.parseAsync([HASH, '--taker', MAKER, '--json'], {
        from: 'user',
      }),
    );

    expect(exitCode).toBe(1);
    const env = JSON.parse(stdout.trim()) as ReadEnvelope;
    expect(env.action).toBe('commitments.fillability');
    expect(env.wallet).toBe(MAKER_LC);
    expect(env.walletRole).toBe('subject');
    // The read is what failed, so the error is the dead endpoint rather than
    // the signer resolution the sweep's row hits.
    expect(env.errors[0]?.code).toBe('API_ERROR');
  });

  // A DELIBERATE behaviour change, pinned so it stays deliberate. `--taker`'s
  // shape is validated after `getClient()` — an accident of ordering, but it
  // puts the refusal inside §6's window, so it now arrives as an envelope
  // instead of a bare stderr line. The subject stays null because the taker
  // never resolved: a role without an address would claim a subject the
  // envelope does not name.
  it('commitments fillability --taker <malformed>: enveloped, and still subject-less', async () => {
    const { stdout, exitCode } = await runActionAndCaptureFailure(() =>
      commitmentsFillabilityCommand.parseAsync([HASH, '--taker', 'not-an-address', '--json'], {
        from: 'user',
      }),
    );

    expect(exitCode).toBe(1);
    const env = JSON.parse(stdout.trim()) as ReadEnvelope;
    expect(env.action).toBe('commitments.fillability');
    expect(env.errors[0]?.code).toBe('VALIDATION_ERROR');
    expect(env.wallet).toBeNull();
    expect(env.walletRole).toBe('none');
  });
});
