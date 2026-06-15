/**
 * Command-level exit-code coverage for `ospex claim-all` (review finding M4).
 *
 * claim-all is the one write whose SUCCESS-path envelope can be `ok: false`:
 * the SDK isolates per-entry failures into `result.entries[].success` rather
 * than throwing, so the command's catch-path `process.exit(1)` never fires for
 * them. AGENT_ENVELOPE_SPEC §6 ("exit code is non-zero when ok:false") was
 * therefore violated — a partial/total failed sweep emitted `ok: false` on
 * stdout but exited 0, so a shell-gating harness marked the sweep as swept.
 *
 * Unlike command-failure-envelope.test.ts (which forces the THROW/catch path
 * with a dead API), these drive the command to a CLEAN completion with a
 * mocked `getClient`, so `claimAll` returns a real result shape and the
 * success-path envelope + exit code are exercised directly. The
 * already-done / multi-wallet success cases (everything skipped/recovered by
 * peers) must stay exit 0 — that is the point of the idempotent postgame path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from '@ospex/sdk';

// Mock the client factory so the action resolves an in-memory fake client and
// never touches the network. Everything else (envelope builders, the SDK
// re-exports the command imports, redaction) runs for real.
vi.mock('../src/lib/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/client.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { getClient } from '../src/lib/client.js';
import { positionsClaimAllCommand } from '../src/commands/positions/claim-all.js';

const SIGNER: Hex = '0xaabbccddeeff00112233445566778899aabbccdd';

// ── result fixtures (the shape client.positions.claimAll returns) ──────────

type AnyResult = Record<string, unknown>;

function sentEntry(over: AnyResult = {}): AnyResult {
  return {
    positionId: '1',
    speculationId: '101',
    bucket: 'claimable',
    description: 'Lakers @ Nuggets / moneyline / Lakers (favorite)',
    success: true,
    txHashes: ['0xclaim1'],
    steps: [{ name: 'claimPosition', outcome: 'sent', txHash: '0xclaim1', payoutWei6: '5000000', payoutUSDC: 5 }],
    payoutUSDC: 5,
    payoutWei6: '5000000',
    winSide: 'away',
    error: undefined,
    ...over,
  };
}

function failedEntry(over: AnyResult = {}): AnyResult {
  return {
    positionId: '2',
    speculationId: '202',
    bucket: 'claimable',
    description: 'Heat @ Celtics / moneyline / Heat (underdog)',
    success: false,
    txHashes: [],
    steps: [
      {
        name: 'claimPosition',
        outcome: 'failed',
        errorCode: 'CHAIN_ERROR',
        txHash: '0xrevertedclaim',
        txStatus: 'reverted',
      },
    ],
    payoutUSDC: undefined,
    payoutWei6: undefined,
    winSide: undefined,
    error: { code: 'CHAIN_ERROR', message: 'claim reverted', txHash: '0xrevertedclaim' },
    ...over,
  };
}

function alreadyClaimedEntry(positionId: string, speculationId: string): AnyResult {
  return {
    positionId,
    speculationId,
    bucket: 'claimable',
    description: `already-claimed position ${positionId}`,
    success: true,
    txHashes: [],
    steps: [{ name: 'claimPosition', outcome: 'skippedAlreadyClaimed' }],
    payoutUSDC: undefined,
    payoutWei6: undefined,
    winSide: 'away',
    error: undefined,
  };
}

function result(entries: AnyResult[], over: AnyResult = {}): AnyResult {
  const claimed = entries.filter((e) => e.success).length;
  const failed = entries.length - claimed;
  return {
    address: SIGNER,
    success: failed === 0 && entries.length > 0,
    entries,
    totals: {
      claimed,
      failed,
      claimedFresh: 0,
      alreadyClaimed: 0,
      recoveredAlreadyClaimed: 0,
      totalPayoutWei6: '0',
      totalPayoutUSDC: 0,
    },
    ...over,
  };
}

function fakeClient(claimAllResult: AnyResult): unknown {
  return {
    chainId: () => 137,
    signer: () => ({ getAddress: async () => SIGNER }),
    positions: { claimAll: async () => claimAllResult },
  };
}

// ── harness: run the action, capture stdout + the effective exit code ───────

class ProcessExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

interface Captured {
  stdout: string;
  /** Effective exit code: a `process.exit(n)` call wins; otherwise the
   * `process.exitCode` the action left set (defaulting to 0). */
  exitCode: number;
}

async function runClaimAll(argv: string[]): Promise<Captured> {
  let stdout = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;

  // The success path sets process.exitCode (not process.exit); reset it so a
  // prior test can't leak a 1, and restore it after so vitest's own exit code
  // is untouched.
  const origExitCode = process.exitCode;
  process.exitCode = 0;

  // Safety net: if the action ever hits its catch path it calls process.exit(1)
  // — intercept it so it can't kill the test runner, and so an unexpected catch
  // surfaces as a captured non-zero code rather than a silent pass.
  let exitViaCall: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitViaCall = code ?? 0;
    throw new ProcessExitSignal(exitViaCall);
  }) as never);

  try {
    await positionsClaimAllCommand.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (!(err instanceof ProcessExitSignal)) {
      process.stdout.write = origWrite;
      exitSpy.mockRestore();
      process.exitCode = origExitCode;
      throw err;
    }
  } finally {
    process.stdout.write = origWrite;
    exitSpy.mockRestore();
  }

  const fromExitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  const exitCode = exitViaCall ?? fromExitCode;
  process.exitCode = origExitCode;
  return { stdout, exitCode };
}

interface ParsedEnvelope {
  ok: boolean;
  action: string;
  stage: string;
  warnings: Array<{ code: string; severity: string }>;
  payload: { totals: { failed: number; alreadyClaimed: number; claimedFresh: number } };
}

function parse(stdout: string): ParsedEnvelope {
  return JSON.parse(stdout.trim()) as ParsedEnvelope;
}

beforeEach(() => {
  vi.mocked(getClient).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ospex claim-all — exit code follows envelope.ok (M4)', () => {
  it('--json: partial per-entry failure → exit 1, envelope ok:false, single envelope', async () => {
    vi.mocked(getClient).mockResolvedValue(
      fakeClient(result([sentEntry(), failedEntry()])) as never,
    );

    const { stdout, exitCode } = await runClaimAll(['--json']);

    expect(exitCode).toBe(1);
    const env = parse(stdout);
    expect(env.ok).toBe(false);
    expect(env.action).toBe('claim-all');
    expect(env.payload.totals.failed).toBe(1);
    // One envelope only — no second (failure) envelope appended.
    expect(stdout.trim().match(/\}\s*\{/)).toBeNull();
  });

  it('--json: total per-entry failure → exit 1, envelope ok:false', async () => {
    vi.mocked(getClient).mockResolvedValue(
      fakeClient(result([failedEntry()])) as never,
    );

    const { stdout, exitCode } = await runClaimAll(['--json']);

    expect(exitCode).toBe(1);
    expect(parse(stdout).ok).toBe(false);
  });

  it('--json: all entries fresh-claimed → exit 0, envelope ok:true', async () => {
    vi.mocked(getClient).mockResolvedValue(
      fakeClient(
        result([sentEntry()], {
          totals: {
            claimed: 1,
            failed: 0,
            claimedFresh: 1,
            alreadyClaimed: 0,
            recoveredAlreadyClaimed: 0,
            totalPayoutWei6: '5000000',
            totalPayoutUSDC: 5,
          },
        }),
      ) as never,
    );

    const { stdout, exitCode } = await runClaimAll(['--json']);

    expect(exitCode).toBe(0);
    expect(parse(stdout).ok).toBe(true);
  });

  it('--json: multi-wallet sweep where peers already did everything → exit 0, ok:true, info warnings', async () => {
    // The core repeated-multi-wallet-postgame case: a second wallet sweeps a
    // book another wallet already cleared. Every entry is skippedAlreadyClaimed
    // → totals.failed === 0 → ok:true → exit 0 (NOT a failure), with the
    // structured already-done evidence intact.
    vi.mocked(getClient).mockResolvedValue(
      fakeClient(
        result([alreadyClaimedEntry('1', '101'), alreadyClaimedEntry('2', '102')], {
          totals: {
            claimed: 2,
            failed: 0,
            claimedFresh: 0,
            alreadyClaimed: 2,
            recoveredAlreadyClaimed: 0,
            totalPayoutWei6: '0',
            totalPayoutUSDC: 0,
          },
        }),
      ) as never,
    );

    const { stdout, exitCode } = await runClaimAll(['--json']);

    expect(exitCode).toBe(0);
    const env = parse(stdout);
    expect(env.ok).toBe(true);
    expect(env.payload.totals.alreadyClaimed).toBe(2);
    expect(env.payload.totals.claimedFresh).toBe(0);
    // The machine-readable "already done by someone else" evidence survives.
    const codes = env.warnings.map((w) => w.code);
    expect(codes).toContain('claim-skipped-already-claimed');
    expect(env.warnings.every((w) => w.severity === 'info')).toBe(true);
  });

  it('--json: live no-op (no positions) → exit 0, ok:true', async () => {
    vi.mocked(getClient).mockResolvedValue(fakeClient(result([])) as never);

    const { stdout, exitCode } = await runClaimAll(['--json']);

    expect(exitCode).toBe(0);
    expect(parse(stdout).ok).toBe(true);
  });

  it('human mode: partial failure → exit 1 and the summary reports it', async () => {
    vi.mocked(getClient).mockResolvedValue(
      fakeClient(result([sentEntry(), failedEntry()])) as never,
    );

    const { stdout, exitCode } = await runClaimAll([]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain('1 failed');
  });

  it('human mode: all success → exit 0', async () => {
    vi.mocked(getClient).mockResolvedValue(
      fakeClient(
        result([sentEntry()], {
          totals: {
            claimed: 1,
            failed: 0,
            claimedFresh: 1,
            alreadyClaimed: 0,
            recoveredAlreadyClaimed: 0,
            totalPayoutWei6: '5000000',
            totalPayoutUSDC: 5,
          },
        }),
      ) as never,
    );

    const { exitCode } = await runClaimAll([]);

    expect(exitCode).toBe(0);
  });
});
