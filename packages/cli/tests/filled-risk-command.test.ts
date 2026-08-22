/**
 * Command-level coverage for `ospex commitments filled-risk`.
 *
 * Drives the ACTION with a mocked `getClient` (the `contests-list-dated`
 * harness pattern) rather than matching help strings, because the properties
 * that matter here are what the command SENDS to the SDK and what it puts in
 * the envelope — neither of which a help-text assertion can see. It also
 * pins registration under `commitments` in the real program tree, since the
 * command file compiling is not the same as the command being reachable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from '@ospex/sdk';

vi.mock('../src/lib/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/client.js')>();
  return { ...actual, getClient: vi.fn() };
});

import { getClient } from '../src/lib/client.js';
import { commitmentsFilledRiskCommand } from '../src/commands/commitments/filled-risk.js';
import { makeProgram } from '../src/index.js';

// ── fixtures ────────────────────────────────────────────────────────────
// Three hashes with three DISTINCT values, one of them zero, none of them a
// round number: a positional swap between two rows has to disagree with the
// expected payload, and a build that answered the first value for every hash
// has to disagree too. A single hash would pass under both.

const H_PARTIAL = ('0x' + '3c'.repeat(32)) as Hex;
const H_UNFILLED = ('0x' + '0e'.repeat(32)) as Hex;
const H_LARGE = ('0x' + 'f2'.repeat(32)) as Hex;

const CHAIN = new Map<Hex, bigint>([
  [H_PARTIAL, 3_141_593n],
  [H_UNFILLED, 0n],
  [H_LARGE, 9_007_199_254_740_993n],
]);

const AT_BLOCK = 71_234_567n;

function fakeClient(): {
  client: unknown;
  getFilledRisk: ReturnType<typeof vi.fn>;
} {
  const getFilledRisk = vi.fn(async (args: { hashes: readonly Hex[] }) => ({
    atBlock: AT_BLOCK,
    filledRisk: new Map(args.hashes.map((h) => [h, CHAIN.get(h) ?? 0n])),
  }));
  return { client: { chainId: () => 137, commitments: { getFilledRisk } }, getFilledRisk };
}

async function run(argv: string[]): Promise<string> {
  let stdout = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await commitmentsFilledRiskCommand.parseAsync(argv, { from: 'user' });
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

describe('commitments filled-risk — what it sends', () => {
  it('forwards every hash, in order, with no block when --block is omitted', async () => {
    const { client, getFilledRisk } = fakeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);

    await run([H_PARTIAL, H_UNFILLED, H_LARGE, '--json']);

    expect(getFilledRisk).toHaveBeenCalledTimes(1);
    expect(getFilledRisk.mock.calls[0]![0]).toStrictEqual({
      hashes: [H_PARTIAL, H_UNFILLED, H_LARGE],
    });
  });

  it('forwards --block as a bigint blockNumber', async () => {
    const { client, getFilledRisk } = fakeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);

    await run([H_PARTIAL, H_LARGE, '--block', '71234501', '--json']);

    expect(getFilledRisk.mock.calls[0]![0]).toStrictEqual({
      hashes: [H_PARTIAL, H_LARGE],
      blockNumber: 71_234_501n,
    });
  });

  it('refuses a malformed hash before any client work', async () => {
    vi.mocked(getClient).mockResolvedValue(fakeClient().client as never);
    // 63 nibbles: refused by the length rule specifically, not by a prefix
    // or alphabet rule that a wholly different string would also trip.
    await expect(run([('0x' + '3c'.repeat(31) + '3') as Hex, '--json'])).rejects.toThrow();
    expect(vi.mocked(getClient)).not.toHaveBeenCalled();
  });
});

describe('commitments filled-risk — what it prints', () => {
  it('emits atBlock and one payload row per hash, each with its OWN value', async () => {
    const { client } = fakeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);

    const stdout = await run([H_PARTIAL, H_UNFILLED, H_LARGE, '--json']);
    const envelope = JSON.parse(stdout) as {
      action: string;
      stage: string;
      payload: { atBlock: string; filledRisk: Array<Record<string, string>> };
    };

    expect(envelope.action).toBe('commitments.filled-risk');
    expect(envelope.stage).toBe('read');
    expect(envelope.payload.atBlock).toBe('71234567');
    // Whole mapping, not a sampled row.
    expect(envelope.payload.filledRisk).toStrictEqual([
      { hash: H_PARTIAL, filledRiskWei6: '3141593', filledRiskUsdc: '3.141593' },
      { hash: H_UNFILLED, filledRiskWei6: '0', filledRiskUsdc: '0.000000' },
      {
        hash: H_LARGE,
        filledRiskWei6: '9007199254740993',
        filledRiskUsdc: '9007199254.740993',
      },
    ]);
  });

  it('renders atBlock and a row per hash in the human table', async () => {
    const { client } = fakeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);

    const stdout = await run([H_PARTIAL, H_UNFILLED]);

    expect(stdout).toContain('71234567');
    expect(stdout).toContain('3.141593');
    expect(stdout).toContain(H_PARTIAL);
    expect(stdout).toContain(H_UNFILLED);
  });
});

describe('commitments filled-risk — registration', () => {
  it('is reachable as `ospex commitments filled-risk`', () => {
    const program = makeProgram();
    const commitments = program.commands.find((c) => c.name() === 'commitments');
    expect(commitments).toBeDefined();
    expect(commitments?.commands.map((c) => c.name())).toContain('filled-risk');
  });
});
