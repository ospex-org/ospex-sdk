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
 *     `gameFinalType` through untouched;
 *   - the envelope payload carries the game identity keys
 *     (`gameId` / `jsonoddsId`, incl. null) through untouched, and the
 *     human table deliberately does NOT gain identity columns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OspexValidationError } from '@ospex/sdk';
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
  it('--date with --hours fails loudly before any client work, as the typed validation error', async () => {
    // Typed, like every sibling mutual-exclusion site — agents classify on
    // the (VALIDATION_ERROR) code the CLI's error surface prints for it.
    await expect(runList(['--date', '2026-08-14', '--hours', '24'])).rejects.toThrow(
      OspexValidationError,
    );
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
    // The finality value is bound to its ROW, not just present somewhere
    // in the blob: contest 42's line carries 'Finished' beside its own
    // 'scored' status, and contest 43's line does not.
    expect(out).toContain('finality');
    const line42 = out.split('\n').find((l) => l.includes(' 42 '));
    const line43 = out.split('\n').find((l) => l.includes(' 43 '));
    expect(line42).toBeDefined();
    expect(line42).toContain('Finished');
    expect(line42).toContain('scored');
    expect(line43).toBeDefined();
    expect(line43).not.toContain('Finished');
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

// ── game identity in the envelope ───────────────────────────────────────

describe('ospex contests list — game identity passthrough', () => {
  const IDENTITY_CONTESTS: Contest[] = [
    contest({
      gameId: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
      jsonoddsId: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
    }),
    contest({
      contestId: '44',
      awayTeam: 'Sox',
      homeTeam: 'Yanks',
      status: 'verified',
      // No upstream linkage → the SDK surfaces both keys as null.
      gameId: null,
      jsonoddsId: null,
    }),
  ];

  it('--json envelope payload carries gameId / jsonoddsId through untouched, including null', async () => {
    // The CLI passes the decoded Contest[] verbatim as the payload — no
    // re-projection — so this pins that nothing CLI-side starts filtering
    // or renaming the identity keys.
    const { client } = fakeClient(IDENTITY_CONTESTS);
    vi.mocked(getClient).mockResolvedValue(client as never);

    const out = await runList(['--json']);
    const env = JSON.parse(out.trim()) as {
      ok: boolean;
      payload: Array<{ contestId: string; gameId?: string | null; jsonoddsId?: string | null }>;
    };
    expect(env.ok).toBe(true);
    expect(env.payload[0]!.gameId).toBe('a783e37e-4ce1-4f42-9dd6-615568f73044');
    expect(env.payload[0]!.jsonoddsId).toBe('a783e37e-4ce1-4f42-9dd6-615568f73044');
    // null must SURVIVE serialization as an explicit key, not vanish —
    // JSON.stringify drops undefined but keeps null, so this discriminates
    // a copy-through from a truthiness filter.
    expect('gameId' in env.payload[1]!).toBe(true);
    expect('jsonoddsId' in env.payload[1]!).toBe(true);
    expect(env.payload[1]!.gameId).toBeNull();
    expect(env.payload[1]!.jsonoddsId).toBeNull();
  });

  it('the human table deliberately gains no identity columns', async () => {
    const { client } = fakeClient(IDENTITY_CONTESTS);
    vi.mocked(getClient).mockResolvedValue(client as never);

    const out = await runList([]);
    expect(out).not.toContain('gameId');
    expect(out).not.toContain('jsonoddsId');
    // Also pin by VALUE, not just key name — a column added under a
    // renamed header ('game') would dodge the key-name checks while still
    // rendering the identity into the table.
    expect(out).not.toContain('a783e37e');
    // The rows themselves still render.
    expect(out).toContain('Cubs');
    expect(out).toContain('Sox');
  });
});
