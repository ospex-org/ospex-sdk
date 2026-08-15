/**
 * Command-level coverage for `ospex contests list --date` (dated discovery).
 *
 * `contests list` previously had only a registration smoke test; this file
 * drives the ACTION with a mocked `getClient` (the claim-all harness
 * pattern) and pins:
 *
 *   - `--date` + `--hours` fail loudly BEFORE any client work;
 *   - a malformed `--date` shape is refused client-side;
 *   - `--date` is forwarded to `client.contests.list` verbatim;
 *   - the human table gains a `finality` column in dated mode ONLY —
 *     the default (no `--date`) table is unchanged;
 *   - `--json` runs signer-free and its envelope payload carries
 *     `gameFinalType` through untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contest } from '@ospex/sdk';

vi.mock('../src/lib/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/client.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { getClient } from '../src/lib/client.js';
import { contestListCommand } from '../src/commands/contests/list.js';

// ── fixtures ────────────────────────────────────────────────────────────

function contest(over: Partial<Contest>): Contest {
  return {
    contestId: '42',
    awayTeam: 'Cubs',
    homeTeam: 'Reds',
    sport: 'mlb',
    sportId: 5,
    matchTime: '2026-08-14T18:10:00Z',
    status: 'scored',
    speculations: [],
    ...over,
  };
}

const DATED_CONTESTS: Contest[] = [
  contest({ gameFinalType: 'Finished' }),
  contest({
    contestId: '43',
    awayTeam: 'Mets',
    homeTeam: 'Braves',
    status: 'verified',
    gameFinalType: '',
  }),
];

function fakeClient(contests: Contest[]): { client: unknown; list: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async () => contests);
  return { client: { chainId: () => 137, contests: { list } }, list };
}

// ── harness ─────────────────────────────────────────────────────────────

async function runList(argv: string[]): Promise<string> {
  let stdout = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await contestListCommand.parseAsync(argv, { from: 'user' });
  } finally {
    process.stdout.write = origWrite;
  }
  return stdout;
}

beforeEach(() => {
  vi.mocked(getClient).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── flag validation ─────────────────────────────────────────────────────

describe('ospex contests list --date — flag validation', () => {
  it('--date with --hours fails loudly before any client work', async () => {
    await expect(runList(['--date', '2026-08-14', '--hours', '24'])).rejects.toThrow(
      /--date and --hours are mutually exclusive/,
    );
    expect(vi.mocked(getClient)).not.toHaveBeenCalled();
  });

  it('a malformed --date shape is refused client-side', async () => {
    await expect(runList(['--date', '2026-8-14'])).rejects.toThrow(/YYYY-MM-DD/);
    expect(vi.mocked(getClient)).not.toHaveBeenCalled();
  });
});

// ── dated mode ──────────────────────────────────────────────────────────

describe('ospex contests list --date — output', () => {
  it('forwards date (and composed filters) to contests.list and renders finality', async () => {
    const { client, list } = fakeClient(DATED_CONTESTS);
    vi.mocked(getClient).mockResolvedValue(client as never);

    const out = await runList(['--date', '2026-08-14', '--sport', 'mlb', '--status', 'scored']);

    // Signer-free read.
    expect(vi.mocked(getClient)).toHaveBeenCalledWith({ requiresSigner: false });
    expect(list).toHaveBeenCalledWith({ date: '2026-08-14', sport: 'mlb', status: 'scored' });
    // The human table carries the finality column, with the verbatim value
    // beside the contest's own scored status.
    expect(out).toContain('finality');
    expect(out).toContain('Finished');
    expect(out).toContain('scored');
  });

  it('--json envelope payload carries gameFinalType through untouched', async () => {
    const { client } = fakeClient(DATED_CONTESTS);
    vi.mocked(getClient).mockResolvedValue(client as never);

    const out = await runList(['--date', '2026-08-14', '--json']);
    const env = JSON.parse(out.trim()) as {
      ok: boolean;
      action: string;
      payload: Array<{ contestId: string; gameFinalType?: string }>;
    };
    expect(env.ok).toBe(true);
    expect(env.action).toBe('contests.list');
    expect(env.payload[0]!.gameFinalType).toBe('Finished');
    expect(env.payload[1]!.gameFinalType).toBe('');
  });

  it('negative control: without --date the table has no finality column', async () => {
    const { client, list } = fakeClient([contest({})]);
    vi.mocked(getClient).mockResolvedValue(client as never);

    const out = await runList(['--sport', 'mlb']);

    expect(list).toHaveBeenCalledWith({ sport: 'mlb' });
    expect(out).not.toContain('finality');
    // The ordinary columns are still there.
    expect(out).toContain('contestId');
    expect(out).toContain('Cubs');
  });
});
