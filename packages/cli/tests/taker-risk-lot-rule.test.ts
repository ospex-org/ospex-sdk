/**
 * Command-level tests for the taker-risk / allowance parser relaxation.
 *
 * The 100-wei6 lot rule constrains a maker's SIGNED `commitment.riskAmount`.
 * It was also being applied to two kinds of value that carry no such rule:
 *
 *   1. `--risk-usdc` on `commitments match` / `commitments fillability` — the
 *      TAKER's desired risk. `MatchingModule.matchCommitment`'s only direct
 *      guard on it is a zero check; the maker leg it derives is floored to
 *      the lot by the contract itself.
 *   2. The amount typed at a USDC allowance prompt — an ERC-20 approve
 *      value, which has no protocol grid at all.
 *
 * These assert the CLI ARTIFACT — what reaches the SDK, and what the
 * interactive approval flow actually does — rather than the parser in
 * isolation. The parser is unit-tested in the SDK's `commitments-decimals`
 * suite; the maker-side negative control lives in `commitments-prepareSubmit`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/client.js')>();
  return { ...actual, getClient: vi.fn() };
});
vi.mock('../src/lib/prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/prompt.js')>();
  return { ...actual, promptYesNo: vi.fn(), promptValue: vi.fn() };
});

import { buildMatchPreview } from '@ospex/sdk';
import { getClient } from '../src/lib/client.js';
import { promptYesNo, promptValue } from '../src/lib/prompt.js';
import { commitmentsFillabilityCommand } from '../src/commands/commitments/fillability.js';
import { commitmentsMatchCommand } from '../src/commands/commitments/match.js';

const HASH = `0x${'b'.repeat(64)}`;
const TAKER = `0x${'c'.repeat(40)}`;
// Real Polygon-mainnet module addresses: the agent-envelope builder resolves
// spender labels from the deployed address book and refuses unknown ones.
const PM = '0x3C71fdB8ABF41487a512440e5ce6490158C26e56';
const TM = '0x07f357e67cc9B48D029b1E4C9B7F45569a2eB85C';
const MM = '0x46Af20B6307Aa0Ec13de10EF58a02c5F1b5C9559';
const FAR_FUTURE_ISO = '2099-05-08T02:00:00Z';

class ProcessExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function asStr(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

async function run(
  command: { parseAsync: (argv: string[], opts: { from: 'user' }) => Promise<unknown> },
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number; error?: unknown }> {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => ((stdout += asStr(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((stderr += asStr(c)), true)) as typeof process.stderr.write;
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  let exitViaCall: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitViaCall = code ?? 0;
    throw new ProcessExitSignal(exitViaCall);
  }) as never);
  let error: unknown;
  try {
    await command.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (!(err instanceof ProcessExitSignal)) error = err;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    exitSpy.mockRestore();
  }
  const exitCode = exitViaCall ?? Number(process.exitCode ?? 0);
  process.exitCode = origExitCode;
  return { stdout, stderr, exitCode, error };
}

function commitment(oddsTick = 250) {
  return {
    visibility: 'visible',
    redacted: false,
    commitmentHash: HASH,
    maker: `0x${'a'.repeat(40)}`,
    contestId: '42',
    scorer: `0x${'4'.repeat(40)}`,
    lineTicks: 0,
    positionType: 0,
    oddsTick,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '17000000001',
    expiry: FAR_FUTURE_ISO,
    speculationKey: `0x${'a'.repeat(64)}`,
    signature: '0xsig',
    status: 'open',
    storedStatus: 'open',
    source: 'submit',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2026-05-09T00:00:00Z',
  };
}

/**
 * A REAL preview from the SDK's own builder, so `approvals[].required` is
 * whatever the live lot math produces — not a number chosen to make the
 * test pass.
 */
function realPreview(takerDesiredRiskWei6: bigint, oddsTick = 250) {
  return buildMatchPreview({
    commitment: commitment(oddsTick),
    chainId: 137,
    matchingModuleAddress: MM,
    taker: TAKER,
    awayTeam: 'Los Angeles Lakers',
    homeTeam: 'Denver Nuggets',
    awayTeamId: 'lakers-uuid',
    homeTeamId: 'nuggets-uuid',
    sport: 'nba',
    matchTime: FAR_FUTURE_ISO,
    speculation: { mode: 'existing', speculationId: '101' },
    speculationKey: `0x${'a'.repeat(64)}`,
    speculationCreationTotalFeeWei6: 500_000n,
    takerTreasuryAllowanceWei6: 0n,
    makerTreasuryAllowanceWei6: 0n,
    treasuryModuleAddress: TM,
    positionModuleAddress: PM,
    takerPositionAllowanceWei6: 0n,
    nowUnixSec: 1_700_000_000n,
    takerDesiredRiskWei6,
  } as never);
}

function clientStub(over: Record<string, unknown> = {}, oddsTick = 250) {
  return {
    chainId: () => 137,
    signer: () => ({ getAddress: async () => TAKER }),
    commitments: {
      resolveByPrefix: vi.fn().mockResolvedValue(commitment(oddsTick)),
      ...over,
    },
  } as never;
}

beforeEach(() => {
  vi.mocked(promptYesNo).mockReset().mockResolvedValue(true);
  vi.mocked(promptValue).mockReset();
  vi.mocked(getClient).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('taker desired risk accepts off-lot-grid --risk-usdc', () => {
  it('fillability: 0.000150 reaches checkCommitmentFillability as 150n', async () => {
    const checkCommitmentFillability = vi
      .fn()
      .mockResolvedValue({ commitmentHash: HASH, outcome: 'fillable', reasons: [] });
    vi.mocked(getClient).mockResolvedValue(clientStub({ checkCommitmentFillability }));

    const { error } = await run(commitmentsFillabilityCommand, [
      HASH,
      '--risk-usdc',
      '0.000150', // 150 wei6 — 50 off the lot grid
      '--taker',
      TAKER,
      '--json',
    ]);

    expect(error).toBeUndefined();
    expect(checkCommitmentFillability).toHaveBeenCalledWith(
      expect.objectContaining({ takerDesiredRiskWei6: 150n }),
    );
  });

  it('match --json preview: 0.000150 reaches prepareMatch as 150n and prices a real fill', async () => {
    // The mock ECHOES its argument — a static preview would make the
    // envelope assertion below independent of what the CLI actually parsed.
    const prepareMatch = vi.fn((args: { takerDesiredRiskWei6?: bigint }) =>
      Promise.resolve(realPreview(args.takerDesiredRiskWei6 ?? 1n)),
    );
    vi.mocked(getClient).mockResolvedValue(clientStub({ prepareMatch }));

    const { stdout, error } = await run(commitmentsMatchCommand, [
      HASH,
      '--risk-usdc',
      '0.000150',
      '--expected-address',
      TAKER,
      '--json',
    ]);

    expect(error).toBeUndefined();
    expect(prepareMatch).toHaveBeenCalledWith(
      expect.objectContaining({ takerDesiredRiskWei6: 150n }),
    );
    // And the emitted envelope carries the off-grid taker risk back out.
    expect(JSON.parse(stdout).payload.economics.takerRiskWei6).toBe('150');
  });

  it('accepts 1 wei6 — the only taker amount that fills the minimum lot at oddsTick 101', async () => {
    const prepareMatch = vi.fn((args: { takerDesiredRiskWei6?: bigint }) =>
      Promise.resolve(realPreview(args.takerDesiredRiskWei6 ?? 1n, 101)),
    );
    vi.mocked(getClient).mockResolvedValue(clientStub({ prepareMatch }, 101));

    const { stdout, error } = await run(commitmentsMatchCommand, [
      HASH,
      '--risk-usdc',
      '0.000001',
      '--expected-address',
      TAKER,
      '--json',
    ]);

    expect(error).toBeUndefined();
    expect(prepareMatch).toHaveBeenCalledWith(
      expect.objectContaining({ takerDesiredRiskWei6: 1n }),
    );
    expect(JSON.parse(stdout).payload.economics.fillMakerRiskWei6).toBe('100');
  });

  it('still refuses genuinely malformed --risk-usdc', async () => {
    // NEGATIVE CONTROL: the relaxation dropped the lot rule and nothing else.
    const prepareMatch = vi.fn().mockResolvedValue(realPreview(150n));
    vi.mocked(getClient).mockResolvedValue(clientStub({ prepareMatch }));

    for (const bad of ['0', '-1', '1e3', '1.0000001', 'abc']) {
      const r = await run(commitmentsMatchCommand, [
        HASH,
        '--risk-usdc',
        bad,
        '--expected-address',
        TAKER,
        '--json',
      ]);
      const refused = r.error !== undefined || r.exitCode !== 0;
      expect(refused, `--risk-usdc ${bad} must be refused (exit ${r.exitCode})`).toBe(true);
    }
    // The load-bearing half: a malformed value never reaches the SDK.
    expect(prepareMatch).not.toHaveBeenCalled();
  });

  it('a size the odds cannot express is refused by the SDK, with an accurate reason', async () => {
    // The refusal MOVES rather than disappearing: 123 wei6 at oddsTick 250
    // prices a maker leg that floors to zero. That is an interval bound the
    // contract really has — not the lot grid it does not — and the message
    // now says so instead of blaming a lot rule.
    const prepareMatch = vi.fn((args: { takerDesiredRiskWei6?: bigint }) =>
      Promise.resolve(realPreview(args.takerDesiredRiskWei6 ?? 1n)),
    );
    vi.mocked(getClient).mockResolvedValue(clientStub({ prepareMatch }));

    const r = await run(commitmentsMatchCommand, [
      HASH,
      '--risk-usdc',
      '0.000123',
      '--expected-address',
      TAKER,
      '--json',
    ]);

    expect(prepareMatch).toHaveBeenCalledWith(
      expect.objectContaining({ takerDesiredRiskWei6: 123n }),
    );
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(false);
    const messages = JSON.stringify(env.errors);
    expect(messages).toMatch(/fillMakerRisk=0/);
    expect(messages).not.toMatch(/lot size/);
  });
});

describe('match allowance prompt accepts its own suggested default', () => {
  it('an off-grid required amount can be approved by accepting the default', async () => {
    // The prompt default is `wei6ToDecimalUSDC(required)`, and on a match
    // `required` IS the taker's risk, which is lot-aligned only by coincidence. At oddsTick 250 a taker desiring 200 wei6 fills 100 and
    // owes 150. Bare Enter returns "0.000150"; under the lot rule that was
    // rejected and the command exited 1, reported as a parse failure.
    // 250 wei6 is OFF the lot grid (250 % 100 === 50). This is the only test
    // that walks the execute path, where `--risk-usdc` is parsed a SECOND
    // time for the fillability preflight; a lot-aligned value here would
    // leave that site unpinned.
    const preview = realPreview(250n);
    expect(preview.approvals[0]?.required).toBe('150'); // off-grid, from real math

    vi.mocked(promptValue).mockResolvedValue('0.000150');
    const approve = vi
      .fn()
      .mockResolvedValue({ txHash: '0xapprove', receipt: { status: 'success', blockNumber: 1n } });
    vi.mocked(getClient).mockResolvedValue(
      clientStub({
        prepareMatch: vi.fn().mockResolvedValue(preview),
        checkCommitmentFillability: vi
          .fn()
          .mockResolvedValue({ commitmentHash: HASH, outcome: 'fillable', reasons: [] }),
        approve,
        matchFromPreview: vi.fn().mockResolvedValue({
          txHash: '0xmatch',
          takerRisk: 150n,
          fillMakerRisk: 100n,
          receipt: { status: 'success', blockNumber: 2n },
        }),
      }),
    );

    // The prompt path is gated on a TTY; without one the command refuses up
    // front and the allowance prompt is never reached.
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(commitmentsMatchCommand, [HASH, '--risk-usdc', '0.000250']);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }

    expect(result.error).toBeUndefined();
    // The suggested default really is the off-grid value...
    expect(vi.mocked(promptValue).mock.calls[0]?.[1]).toBe('0.000150');
    // ...and accepting it now approves rather than exiting 1.
    expect(approve).toHaveBeenCalledWith(150n);
    expect(result.stderr).not.toMatch(/Could not parse/);
  });
});
