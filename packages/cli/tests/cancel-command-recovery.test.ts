/**
 * Command-level tests for the cancel-recovery wiring — they drive the REAL
 * `.action()` handlers of `commitments cancel --also-onchain` and
 * `commitments cancel-onchain` via `parseAsync`, with `getClient` mocked so we
 * control the off-chain DELETE / on-chain leg and SPY on the arguments the
 * command passes to the SDK.
 *
 * These pin the two load-bearing one-line seams of the fix that the pure
 * transform tests (lifecycle-cancel-v2-transforms.test.ts) cannot reach:
 *   1. the dual on-chain leg is invoked with `{ commitment }` (the in-hand
 *      resolved row), NOT `{ hash }` — so it never re-fetches a row its own
 *      off-chain DELETE just hid (bug-1);
 *   2. ANY on-chain-leg error (not just OspexChainError) is captured and routed
 *      through the dual envelope, preserving the completed off-chain DELETE
 *      (M6) — a regression restoring `else { throw err }` would otherwise pass
 *      every transform test;
 *   3. `cancel-onchain` resolves with `cancelled` in scope + `recoverHidden:true`
 *      so a book-hidden row is recoverable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the client factory so the action gets a stub we control + spy on.
vi.mock('../src/lib/client.js', () => ({ getClient: vi.fn() }));

import { getClient } from '../src/lib/client.js';
import { makeProgram } from '../src/index.js';
import type { Command } from '@commander-js/extra-typings';

const getClientMock = vi.mocked(getClient);

const SIGNER = '0xaabbccddeeff00112233445566778899aabbccdd';
const HASH = '0x' + 'ab'.repeat(32);

function visibleCommitment(): Record<string, unknown> {
  return {
    commitmentHash: HASH,
    maker: SIGNER,
    contestId: '42',
    scorer: '0x' + '11'.repeat(20),
    lineTicks: 0,
    positionType: 0,
    oddsTick: 250,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '17000000001',
    expiry: '2099-05-08T02:00:00Z',
    speculationKey: '0x' + 'cd'.repeat(32),
    signature: '0xsig',
    status: 'open',
    storedStatus: 'open',
    source: 'submit',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    visibility: 'visible',
    redacted: false,
    createdAt: '2026-05-09T00:00:00Z',
  };
}

function onchainResult(): Record<string, unknown> {
  return {
    txHash: '0x' + 'aa'.repeat(32),
    commitmentHash: HASH,
    receipt: { status: 'success', blockNumber: 1000n },
  };
}

interface StubCommitments {
  resolveByPrefix: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  cancelOnchain: ReturnType<typeof vi.fn>;
}

function stubClient(commitments: Partial<StubCommitments> = {}): {
  client: unknown;
  commitments: StubCommitments;
} {
  const c: StubCommitments = {
    resolveByPrefix: vi.fn(async () => visibleCommitment()),
    cancel: vi.fn(async () => ({ ok: true })),
    cancelOnchain: vi.fn(async () => onchainResult()),
    ...commitments,
  };
  const client = {
    chainId: () => 137,
    signer: () => ({ getAddress: async () => SIGNER }),
    commitments: c,
  };
  return { client, commitments: c };
}

let stdout = '';
let origWrite: typeof process.stdout.write;
let origExitCode: number | string | null | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdout = '';
  origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  origExitCode = process.exitCode;
  // Defensive: if a path hits the outer catch (emitJsonFailure + process.exit),
  // surface it as a throw rather than killing the test runner.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
});

afterEach(() => {
  process.stdout.write = origWrite;
  process.exitCode = origExitCode;
  exitSpy.mockRestore();
  getClientMock.mockReset();
});

function parseEnvelope(): Record<string, unknown> {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

async function run(argv: string[]): Promise<void> {
  const program = makeProgram() as unknown as Command;
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  await program.parseAsync(['node', 'ospex', ...argv]);
}

describe('commitments cancel --also-onchain — on-chain leg uses { commitment }, not { hash } (bug-1)', () => {
  it('passes the already-resolved commitment to cancelOnchain (never re-fetches by hash)', async () => {
    const { client, commitments } = stubClient();
    getClientMock.mockResolvedValue(client as never);

    await run(['commitments', 'cancel', HASH, '--also-onchain', '--json']);

    // Off-chain DELETE ran first.
    expect(commitments.cancel).toHaveBeenCalledWith(HASH);
    // On-chain leg got the in-hand resolved row, NOT { hash } — the whole point
    // of bug-1: re-fetching by hash would return the now-redacted body.
    expect(commitments.cancelOnchain).toHaveBeenCalledTimes(1);
    const arg = commitments.cancelOnchain.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toHaveProperty('commitment');
    expect(arg).not.toHaveProperty('hash');
    expect((arg.commitment as { commitmentHash: string }).commitmentHash).toBe(HASH);

    const env = parseEnvelope();
    expect(env.ok).toBe(true);
    expect((env.effects as unknown[]).length).toBe(3);
  });
});

describe('commitments cancel --also-onchain — M6: a NON-chain on-chain-leg error never drops the off-chain DELETE', () => {
  it('preserves both off-chain effects + emits the cancel-onchain recovery nextCommand (does not re-throw to the bare failure path)', async () => {
    const { client, commitments } = stubClient({
      // A non-OspexChainError from the on-chain leg — exactly what the removed
      // `else { throw err }` would have re-thrown into the generic failure path
      // (dropping the completed off-chain DELETE).
      cancelOnchain: vi.fn(async () => {
        throw new Error('owner-auth recovery unavailable');
      }),
    });
    getClientMock.mockResolvedValue(client as never);

    await run(['commitments', 'cancel', HASH, '--also-onchain', '--json']);

    // The off-chain DELETE landed and MUST survive in the envelope.
    expect(commitments.cancel).toHaveBeenCalledWith(HASH);
    const env = parseEnvelope();
    expect(env.ok).toBe(false);
    const effects = env.effects as Array<Record<string, unknown>>;
    expect(effects[0]?.type).toBe('eip712-signature');
    expect(effects[0]?.ok).toBe(true);
    expect(effects[1]?.type).toBe('offchain-write');
    expect(effects[1]?.ok).toBe(true);
    expect(effects[2]?.type).toBe('transaction');
    expect(effects[2]?.ok).toBe(false);
    expect(effects[2]?.errorCode).toBe('UNKNOWN_ERROR');
    const errors = env.errors as Array<Record<string, unknown>>;
    expect(errors[0]?.code).toBe('UNKNOWN_ERROR');
    // Recovery: complete the authoritative cancel via the standalone command.
    const nextCommands = env.nextCommands as Array<{ argv?: string[] }> | undefined;
    expect(
      nextCommands?.some((nc) => nc.argv?.[0] === 'commitments' && nc.argv?.[1] === 'cancel-onchain'),
    ).toBe(true);
    // §6: ok:false → non-zero exit (emitJsonSuccess sets process.exitCode).
    expect(process.exitCode).toBe(1);
  });
});

describe('commitments cancel-onchain — recovery wiring (status widening + recoverHidden)', () => {
  it('resolves with cancelled in scope and passes { commitment, recoverHidden: true }', async () => {
    const { client, commitments } = stubClient();
    getClientMock.mockResolvedValue(client as never);

    await run(['commitments', 'cancel-onchain', HASH, '--json']);

    // Status scope MUST include 'cancelled' (an off-chain-cancelled row reads
    // effective 'cancelled' but is still matchable on chain — the recovery
    // precondition). A regression narrowing this back would re-break recovery.
    expect(commitments.resolveByPrefix).toHaveBeenCalledTimes(1);
    const resolveOpts = commitments.resolveByPrefix.mock.calls[0]![1] as { status?: string[] };
    expect(resolveOpts.status).toContain('cancelled');
    expect(resolveOpts.status).toEqual(
      expect.arrayContaining(['open', 'partially_filled', 'cancelled']),
    );

    // On-chain cancel opts into owner-auth recovery for a hidden row.
    const arg = commitments.cancelOnchain.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({ recoverHidden: true });
    expect(arg).toHaveProperty('commitment');

    const env = parseEnvelope();
    expect(env.action).toBe('commitments.cancel-onchain');
    expect(env.ok).toBe(true);
  });
});
