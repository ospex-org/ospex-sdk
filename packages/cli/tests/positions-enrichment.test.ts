/**
 * Command-level tests for the Team Identity enrichment on `settle` / `claim`
 * (PR3-B). Drives the real command actions with a mocked `getClient` whose
 * settle/claim succeeds but whose enrichment reads (`speculations.get` /
 * `odds.snapshot`) either succeed or fail.
 *
 * The load-bearing case is Hermes's acceptance criterion: **an enrichment
 * fetch failure must NOT block the tx result emission** — the command still
 * emits an ok:true envelope (exit 0) with a degraded context + a warning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex, OspexClient } from '@ospex/sdk';

vi.mock('../src/lib/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/client.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { getClient } from '../src/lib/client.js';
import { positionsSettleCommand } from '../src/commands/positions/settle.js';
import { positionsClaimCommand } from '../src/commands/positions/claim.js';

const SIGNER: Hex = '0xaabbccddeeff00112233445566778899aabbccdd';

const MONEYLINE_SPEC = {
  type: 'moneyline',
  contestId: '42',
  contest: { awayTeam: 'New York Yankees', homeTeam: 'Toronto Blue Jays' },
  line: null,
};
const MONEYLINE_ODDS = {
  contestId: '42',
  odds: { moneyline: { awayOddsAmerican: -150, homeOddsAmerican: 130 }, spread: null, total: null },
};

interface ClientCfg {
  settleResult?: unknown;
  claimResult?: unknown;
  specGet?: () => Promise<unknown>;
  oddsSnapshot?: () => Promise<unknown>;
}

function fakeClient(cfg: ClientCfg): OspexClient {
  return {
    chainId: () => 137,
    signer: () => ({ getAddress: async () => SIGNER }),
    positions: {
      ensureSpeculationSettled: async () => cfg.settleResult,
      ensurePositionClaimed: async () => cfg.claimResult,
    },
    speculations: { get: cfg.specGet ?? (async () => MONEYLINE_SPEC) },
    odds: { snapshot: cfg.oddsSnapshot ?? (async () => MONEYLINE_ODDS) },
  } as unknown as OspexClient;
}

class ProcessExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

async function run(
  command: { parseAsync: (argv: string[], opts: { from: 'user' }) => Promise<unknown> },
  argv: string[],
): Promise<{ stdout: string; exitCode: number }> {
  let stdout = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  let exitViaCall: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitViaCall = code ?? 0;
    throw new ProcessExitSignal(exitViaCall);
  }) as never);
  try {
    await command.parseAsync(argv, { from: 'user' });
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
  const exitCode = exitViaCall ?? (typeof process.exitCode === 'number' ? process.exitCode : 0);
  process.exitCode = origExitCode;
  return { stdout, exitCode };
}

interface Env {
  ok: boolean;
  warnings: Array<{ code: string; severity: string }>;
  payload: {
    winSide?: string;
    winSideContext?: { side?: string; team?: unknown; role?: string; status?: string; display?: string } | null;
    positionType?: number;
    positionSideContext?: { side?: string; status?: string } | null;
  };
}

beforeEach(() => vi.mocked(getClient).mockReset());
afterEach(() => vi.restoreAllMocks());

describe('settle — Team Identity enrichment', () => {
  it('complete: moneyline winSide → full team + role context, ok, exit 0', async () => {
    vi.mocked(getClient).mockResolvedValue(
      fakeClient({ settleResult: { outcome: 'settled', winSide: 'away', txHash: '0xtx', blockNumber: 1n } }) as never,
    );
    const { stdout, exitCode } = await run(positionsSettleCommand, ['101', '--json']);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout.trim()) as Env;
    expect(env.ok).toBe(true);
    expect(env.payload.winSide).toBe('away'); // bare field retained
    expect(env.payload.winSideContext).toMatchObject({
      side: 'away',
      team: { name: 'New York Yankees', alignment: 'away' },
      role: 'favorite',
      status: 'complete',
      display: 'away (New York Yankees, favorite)',
    });
  });

  it('NON-BLOCKING: enrichment fetch failure → still ok, degraded context + warning, exit 0', async () => {
    vi.mocked(getClient).mockResolvedValue(
      fakeClient({
        settleResult: { outcome: 'settled', winSide: 'away', txHash: '0xtx', blockNumber: 1n },
        specGet: async () => {
          throw new Error('core-api unreachable');
        },
      }) as never,
    );
    const { stdout, exitCode } = await run(positionsSettleCommand, ['101', '--json']);
    // The settle SUCCEEDED — a metadata fetch failure must not flip this.
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout.trim()) as Env;
    expect(env.ok).toBe(true);
    expect(env.payload.winSide).toBe('away'); // bare field retained
    expect(env.payload.winSideContext?.status).toBe('unavailable');
    expect(env.payload.winSideContext?.team).toBeNull(); // never fabricated
    expect(env.warnings.some((w) => w.code === 'side-context-unavailable' && w.severity === 'warning')).toBe(true);
  });
});

describe('claim — Team Identity enrichment', () => {
  it('complete: positionType 0 + moneyline → side away, full context, ok, exit 0', async () => {
    vi.mocked(getClient).mockResolvedValue(
      fakeClient({
        claimResult: { outcome: 'claimed', txHash: '0xtx', blockNumber: 1n, payoutWei6: 5_000_000n, payoutUSDC: 5 },
      }) as never,
    );
    const { stdout, exitCode } = await run(positionsClaimCommand, ['101', '--type', 'upper', '--json']);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout.trim()) as Env;
    expect(env.ok).toBe(true);
    expect(env.payload.positionType).toBe(0); // bare field retained (upper)
    expect(env.payload.positionSideContext).toMatchObject({ side: 'away', status: 'complete' });
  });

  it('NON-BLOCKING: enrichment fetch failure → still ok, positionSideContext null + warning, exit 0', async () => {
    vi.mocked(getClient).mockResolvedValue(
      fakeClient({
        claimResult: { outcome: 'claimed', txHash: '0xtx', blockNumber: 1n, payoutWei6: 5_000_000n, payoutUSDC: 5 },
        specGet: async () => {
          throw new Error('core-api unreachable');
        },
      }) as never,
    );
    const { stdout, exitCode } = await run(positionsClaimCommand, ['101', '--type', 'upper', '--json']);
    expect(exitCode).toBe(0);
    const env = JSON.parse(stdout.trim()) as Env;
    expect(env.ok).toBe(true);
    expect(env.payload.positionType).toBe(0); // bare field retained
    expect(env.payload.positionSideContext).toBeNull(); // side underivable without the market
    expect(env.warnings.some((w) => w.code === 'side-context-unavailable')).toBe(true);
  });
});
