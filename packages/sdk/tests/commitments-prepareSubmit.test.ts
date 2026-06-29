/**
 * Unit tests for the high-level `prepareSubmit` orchestrator. Mocks
 * the API (contests / speculations endpoints), the chain client
 * (USDC.allowance + MatchingModule.s_minNonces), the signer (maker
 * derivation), and the Teams cache.
 *
 * Covers:
 *   - --speculation happy path (moneyline)
 *   - --contest + moneyline auto-resolves to existing speculation
 *   - --contest + spread + home-side selection → protocol lineTicks
 *     is the negation of the user-supplied line (away-perspective)
 *   - --contest + spread without --line + multiple speculations →
 *     fails closed with candidates listed
 *   - --line on --speculation → rejected
 *   - --line on moneyline → rejected
 *   - submitPrepared chainId mismatch / verifyingContract mismatch →
 *     refuses to sign
 */

import { describe, expect, it, vi } from 'vitest';
import { prepareSubmit } from '../src/commitments/prepareSubmit.js';
import { submitPrepared } from '../src/commitments/submitPrepared.js';
import { MAX_LINE_TICKS } from '../src/commitments/validation.js';
import { deriveSpeculationKey } from '../src/chain/eip712.js';
import { NonceCounter } from '../src/commitments/context.js';
import { OspexAPIError, OspexValidationError } from '../src/errors.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { Hex, Signer } from '../src/types/signer.js';
import type { Contest, SpeculationDetail } from '../src/types/contest.js';
import type { TeamAlias } from '../src/commitments/resolveSide.js';
import type { SubmitPreview, HighLevelSubmitArgs } from '../src/types/preview.js';

// Match time used in test fixtures — 30 days from now, so it's always
// within the protocol's 1-year-from-now cap regardless of when the test
// suite runs. Avoids fixtures rotting (the previous "2026-05-08" string
// was written when 2026 was the future). 30 days is comfortably past
// "now + 1d" so explicit-duration --expiry tests can verify they DON'T
// equal the default match-time path.
const FIXTURE_MATCH_TIME_ISO = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const MAKER = '0x'.padEnd(42, 'a') as Hex;
const ADDRESSES = {
  matchingModule: '0x'.padEnd(42, '1') as Hex,
  positionModule: '0x'.padEnd(42, '2') as Hex,
  usdc: '0x'.padEnd(42, '3') as Hex,
  ospexCore: '0x'.padEnd(42, '5') as Hex,
  speculationModule: '0x'.padEnd(42, '6') as Hex,
  contestModule: '0x'.padEnd(42, '7') as Hex,
  leaderboardModule: '0x'.padEnd(42, '8') as Hex,
  rulesModule: '0x'.padEnd(42, '9') as Hex,
  treasuryModule: '0x'.padEnd(42, 'b') as Hex,
  secondaryMarketModule: '0x'.padEnd(42, 'c') as Hex,
  creOracleReceiver: '0x'.padEnd(42, 'd') as Hex,
  scorers: {
    moneyline: '0x'.padEnd(42, 'e') as Hex,
    spread: '0x'.padEnd(42, 'f') as Hex,
    total: '0x'.padEnd(42, '0') as Hex,
  },
};

function buildSigner(): Signer {
  return {
    getAddress: vi.fn(async () => MAKER),
    signTypedData: vi.fn(async () => '0x'.padEnd(132, 's') as Hex),
    signTransaction: vi.fn(),
  } as unknown as Signer;
}

function buildPublicClient(
  opts: {
    allowance?: bigint;
    /**
     * Optional override for TreasuryModule USDC allowance.
     * When unspecified, every `allowance(...)` read returns `allowance`
     * (back-compat with tests written before the lazy-creation-fee
     * preflight added a 2nd spender). When set, the mock dispatches
     * by `args[1]` (the spender) so PositionModule and TreasuryModule
     * return distinct values. The dispatching arm matches against the
     * test fixture's ADDRESSES.treasuryModule (last byte `b` per the
     * padEnd, all-lower-case for case-insensitive comparison).
     */
    treasuryAllowance?: bigint;
    nonceFloor?: bigint;
  } = {},
): unknown {
  const allowance = opts.allowance ?? 0n;
  const treasuryAllowance = opts.treasuryAllowance;
  const nonceFloor = opts.nonceFloor ?? 0n;
  const treasuryAddress = ADDRESSES.treasuryModule.toLowerCase();
  return {
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === 'allowance') {
        if (treasuryAllowance !== undefined && typeof args[1] === 'string') {
          const spender = (args[1] as string).toLowerCase();
          return spender === treasuryAddress ? treasuryAllowance : allowance;
        }
        return allowance;
      }
      if (functionName === 's_minNonces') return nonceFloor;
      throw new Error(`unexpected readContract: ${functionName}`);
    }),
  };
}

function buildSpec(overrides: Partial<SpeculationDetail> = {}): SpeculationDetail {
  return {
    speculationId: '100',
    contestId: '42',
    type: 'moneyline',
    lineTicks: 0,
    line: 0,
    speculationStatus: 0,
    orderbook: [],
    contest: {
      contestId: '42',
      awayTeam: 'Los Angeles Lakers',
      homeTeam: 'Denver Nuggets',
      awayTeamId: 'lakers-uuid',
      homeTeamId: 'nuggets-uuid',
      sport: 'nba',
      matchTime: FIXTURE_MATCH_TIME_ISO,
      status: 'verified',
    },
    ...overrides,
  };
}

function buildContest(overrides: Partial<Contest> = {}): Contest {
  return {
    contestId: '42',
    awayTeam: 'Los Angeles Lakers',
    homeTeam: 'Denver Nuggets',
    sport: 'nba',
    sportId: 1,
    matchTime: FIXTURE_MATCH_TIME_ISO,
    status: 'verified',
    awayTeamId: 'lakers-uuid',
    homeTeamId: 'nuggets-uuid',
    speculations: [],
    ...overrides,
  };
}

const ALIASES: TeamAlias[] = [
  { teamId: 'lakers-uuid', alias: 'LAL', aliasType: 'abbreviation' },
  { teamId: 'nuggets-uuid', alias: 'DEN', aliasType: 'abbreviation' },
];

function buildContext({
  spec,
  contest,
  allowance,
  treasuryAllowance,
  nonceFloor,
  aliases,
}: {
  spec?: SpeculationDetail;
  contest?: Contest;
  allowance?: bigint;
  treasuryAllowance?: bigint;
  nonceFloor?: bigint;
  aliases?: TeamAlias[];
}): CommitmentsContext {
  const contestsApi = {
    get: vi.fn(async () => contest ?? buildContest()),
    list: vi.fn(),
  } as unknown as CommitmentsContext['getContestsApi'] extends () => infer T ? T : never;
  const speculationsApi = {
    get: vi.fn(async () => spec ?? buildSpec()),
    list: vi.fn(),
  } as unknown as CommitmentsContext['getSpeculationsApi'] extends () => infer T ? T : never;
  const teams = {
    aliases: vi.fn(async () => aliases ?? ALIASES),
    invalidateCache: vi.fn(),
  } as unknown as CommitmentsContext['getTeams'] extends () => infer T ? T : never;

  return {
    api: {} as CommitmentsContext['api'],
    requireSigner: () => buildSigner(),
    getChainId: () => 137,
    getAddresses: () => ADDRESSES,
    requireChainClient: () =>
      buildPublicClient({
        allowance,
        ...(treasuryAllowance !== undefined ? { treasuryAllowance } : {}),
        nonceFloor,
      }) as ReturnType<CommitmentsContext['requireChainClient']>,
    nonceCounter: new NonceCounter(),
    getContestsApi: () => contestsApi,
    getSpeculationsApi: () => speculationsApi,
    getTeams: () => teams,
  };
}

function speculationArgs(overrides: Partial<HighLevelSubmitArgs> = {}): HighLevelSubmitArgs {
  return {
    parent: { kind: 'speculation', speculationId: '100' },
    side: 'lakers',
    odds: '2.50',
    riskUsdc: '1',
    ...overrides,
  };
}

describe('prepareSubmit — --speculation happy path', () => {
  it('returns a SubmitPreview with existing-mode speculation and resolved side', async () => {
    const ctx = buildContext({ allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs());

    expect(preview.market.speculation).toMatchObject({ mode: 'existing', speculationId: '100' });
    expect(preview.market.type).toBe('moneyline');
    expect(preview.side.role).toBe('away');
    expect(preview.side.positionType).toBe(0);
    expect(preview.side.resolutionSource).toBe('nickname');
    expect(preview.economics.riskUSDC).toBe('1.000000');
    expect(preview.economics.profitUSDC).toBe('1.500000');
    expect(preview.raw.maker).toBe(MAKER);
    expect(preview.raw.chainId).toBe(137);
    expect(preview.raw.contestId).toBe('42');
    expect(preview.approvals[0]?.needsApproval).toBe(false); // allowance covers it
  });

  it('flags needsApproval when allowance is short', async () => {
    const ctx = buildContext({ allowance: 0n });
    const preview = await prepareSubmit(ctx, speculationArgs());
    expect(preview.approvals[0]?.needsApproval).toBe(true);
  });
});

describe('prepareSubmit — line magnitude chokepoint', () => {
  it('refuses a pinned speculation whose lineTicks is out of range (the path lineDecimalToTicks never screens)', async () => {
    // A poisoned line can enter prepareSubmit from an existing/pinned
    // speculation row — never through `lineDecimalToTicks` (no user --line).
    // The chokepoint on the final protocol-side lineTicks must still catch it.
    const poisonedLine = MAX_LINE_TICKS + 1;
    const spec = buildSpec({
      type: 'spread',
      lineTicks: poisonedLine,
      line: poisonedLine / 10,
    });
    const ctx = buildContext({ spec, allowance: 1_000_000n });
    await expect(
      prepareSubmit(ctx, {
        parent: { kind: 'speculation', speculationId: '100' },
        side: 'lakers',
        odds: '1.91',
        riskUsdc: '1',
      }),
    ).rejects.toMatchObject({ field: 'lineTicks' });
  });
});

describe('prepareSubmit — --contest mode', () => {
  it('moneyline + matching speculation → existing mode', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '100',
          contestId: '42',
          type: 'moneyline',
          lineTicks: 0,
          line: 0,
          speculationStatus: 0,
        },
      ],
    });
    const ctx = buildContext({ contest, allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'moneyline' },
      side: 'lakers',
      odds: '2.50',
      riskUsdc: '1',
    });
    expect(preview.market.speculation).toMatchObject({ mode: 'existing', speculationId: '100' });
    expect(preview.market.lineTicks).toBe(0);
  });

  it('moneyline + no existing speculation → lazy mode (line is implicitly 0)', async () => {
    const contest = buildContest({ speculations: [] });
    const ctx = buildContext({ contest, allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'moneyline' },
      side: 'lakers',
      odds: '2.50',
      riskUsdc: '1',
    });
    expect(preview.market.lineTicks).toBe(0);
    expect(preview.market.speculation.mode).toBe('lazy');
  });

  it('spread + no --line + zero existing speculations → throws (lazy needs an explicit line)', async () => {
    const contest = buildContest({ speculations: [] });
    const ctx = buildContext({ contest });
    await expect(
      prepareSubmit(ctx, {
        parent: { kind: 'contest', contestId: '42', market: 'spread' },
        side: 'lakers',
        odds: '1.91',
        riskUsdc: '25',
      }),
    ).rejects.toThrow(/No open spread speculation/);
  });

  it('rejects --line on moneyline market', async () => {
    const ctx = buildContext({});
    await expect(
      prepareSubmit(ctx, {
        parent: { kind: 'contest', contestId: '42', market: 'moneyline', line: '0' },
        side: 'lakers',
        odds: '2.50',
        riskUsdc: '1',
      }),
    ).rejects.toThrow(/--line is not valid for moneyline/);
  });

  it('spread + away side with --line -3.5 → protocol lineTicks = -35 (no inversion)', async () => {
    const contest = buildContest({ speculations: [] });
    const ctx = buildContext({ contest, allowance: 25_000_000n });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'spread', line: '-3.5' },
      side: 'lakers', // away
      odds: '1.91',
      riskUsdc: '25',
    });
    expect(preview.side.role).toBe('away');
    expect(preview.market.lineTicks).toBe(-35);
    expect(preview.market.speculation.mode).toBe('lazy');
  });

  it('spread + home side with --line -3.5 → protocol lineTicks = +35 (inverted)', async () => {
    const contest = buildContest({ speculations: [] });
    const ctx = buildContext({ contest, allowance: 25_000_000n });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'spread', line: '-3.5' },
      side: 'nuggets', // home
      odds: '1.91',
      riskUsdc: '25',
    });
    expect(preview.side.role).toBe('home');
    expect(preview.market.lineTicks).toBe(35);
    expect(preview.market.speculation.mode).toBe('lazy');
  });

  it('spread + no --line + multiple speculations → fails closed with candidates listed', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '100',
          contestId: '42',
          type: 'spread',
          lineTicks: -35,
          line: -3.5,
          speculationStatus: 0,
        },
        {
          speculationId: '101',
          contestId: '42',
          type: 'spread',
          lineTicks: -75,
          line: -7.5,
          speculationStatus: 0,
        },
      ],
    });
    const ctx = buildContext({ contest });
    await expect(
      prepareSubmit(ctx, {
        parent: { kind: 'contest', contestId: '42', market: 'spread' },
        side: 'lakers',
        odds: '1.91',
        riskUsdc: '25',
      }),
    ).rejects.toThrow(/Multiple open spread speculations/);
  });

  it('spread + no --line + exactly one speculation → existing mode', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '100',
          contestId: '42',
          type: 'spread',
          lineTicks: -35,
          line: -3.5,
          speculationStatus: 0,
        },
      ],
    });
    const ctx = buildContext({ contest, allowance: 25_000_000n });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'spread' },
      side: 'lakers',
      odds: '1.91',
      riskUsdc: '25',
    });
    expect(preview.market.speculation).toMatchObject({ mode: 'existing', speculationId: '100' });
    expect(preview.market.lineTicks).toBe(-35);
  });
});

describe('prepareSubmit — closed-speculation guards (review #4 blocker 1)', () => {
  it('rejects --speculation when speculationStatus !== 0 (closed/scored)', async () => {
    const ctx = buildContext({
      spec: buildSpec({ speculationStatus: 1 }),
    });
    await expect(prepareSubmit(ctx, speculationArgs())).rejects.toThrow(
      /closed \(settled or scored\)/,
    );
  });

  it('--contest spread no-line: closed specs are filtered out before uniqueness check', async () => {
    // One open + one closed at different lines — should resolve to the
    // single open one, not throw "multiple speculations".
    const contest = buildContest({
      speculations: [
        {
          speculationId: '100',
          contestId: '42',
          type: 'spread',
          lineTicks: -35,
          line: -3.5,
          speculationStatus: 0,
        },
        {
          speculationId: '101',
          contestId: '42',
          type: 'spread',
          lineTicks: -75,
          line: -7.5,
          speculationStatus: 1, // closed
        },
      ],
    });
    const ctx = buildContext({ contest, allowance: 25_000_000n });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'spread' },
      side: 'lakers',
      odds: '1.91',
      riskUsdc: '25',
    });
    expect(preview.market.speculation).toMatchObject({ mode: 'existing', speculationId: '100' });
    expect(preview.market.lineTicks).toBe(-35);
  });

  it('--contest spread + --line matches a CLOSED exact spec → reject (cannot lazy-create at same tuple)', async () => {
    // The SpeculationModule reverse lookup keeps the (contestId,
    // scorer, lineTicks) → speculationId mapping permanently. Once
    // a closed spec exists at that tuple, PositionModule.recordFill
    // returns the closed id rather than creating a new one — any
    // commitment we post here would revert with
    // PositionModule__SpeculationNotOpen at match time.
    const contest = buildContest({
      speculations: [
        {
          speculationId: '101',
          contestId: '42',
          type: 'spread',
          lineTicks: -35,
          line: -3.5,
          speculationStatus: 1, // closed at the line we want
        },
      ],
    });
    const ctx = buildContext({ contest, allowance: 25_000_000n });
    await expect(
      prepareSubmit(ctx, {
        parent: { kind: 'contest', contestId: '42', market: 'spread', line: '-3.5' },
        side: 'lakers',
        odds: '1.91',
        riskUsdc: '25',
      }),
    ).rejects.toThrow(/closed \(settled or scored\)/);
  });

  it('--contest moneyline + only existing moneyline spec is closed → reject', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '100',
          contestId: '42',
          type: 'moneyline',
          lineTicks: 0,
          line: 0,
          speculationStatus: 1, // closed
        },
      ],
    });
    const ctx = buildContext({ contest, allowance: 1_000_000n });
    await expect(
      prepareSubmit(ctx, {
        parent: { kind: 'contest', contestId: '42', market: 'moneyline' },
        side: 'lakers',
        odds: '2.50',
        riskUsdc: '1',
      }),
    ).rejects.toThrow(/closed \(settled or scored\)/);
  });

  it('--contest total + --line matches a CLOSED exact spec → reject', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '102',
          contestId: '42',
          type: 'total',
          lineTicks: 85,
          line: 8.5,
          speculationStatus: 1, // closed
        },
      ],
    });
    const ctx = buildContext({ contest, allowance: 10_000_000n });
    await expect(
      prepareSubmit(ctx, {
        parent: { kind: 'contest', contestId: '42', market: 'total', line: '8.5' },
        side: 'over',
        odds: '1.95',
        riskUsdc: '10',
      }),
    ).rejects.toThrow(/closed \(settled or scored\)/);
  });

  it('--contest with --line that has no existing spec at all → lazy still works', async () => {
    // Closed spec at a DIFFERENT line shouldn't block lazy creation
    // at a fresh line.
    const contest = buildContest({
      speculations: [
        {
          speculationId: '101',
          contestId: '42',
          type: 'spread',
          lineTicks: -75,
          line: -7.5,
          speculationStatus: 1, // closed at -7.5
        },
      ],
    });
    const ctx = buildContext({ contest, allowance: 25_000_000n });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'spread', line: '-3.5' },
      side: 'lakers',
      odds: '1.91',
      riskUsdc: '25',
    });
    // -3.5 has no spec (open or closed) → lazy is correct.
    expect(preview.market.speculation.mode).toBe('lazy');
    expect(preview.market.lineTicks).toBe(-35);
  });

  it('home-side spread selection → canonical-tuple closed-spec check still catches it (inversion-safe)', async () => {
    // User says "home -3.5"; canonical lineTicks = +35 (away
    // perspective). A closed spec at +35 must still trigger the reject.
    const contest = buildContest({
      speculations: [
        {
          speculationId: '103',
          contestId: '42',
          type: 'spread',
          lineTicks: 35, // away +3.5 = home -3.5
          line: 3.5,
          speculationStatus: 1, // closed
        },
      ],
    });
    const ctx = buildContext({ contest, allowance: 25_000_000n });
    await expect(
      prepareSubmit(ctx, {
        parent: { kind: 'contest', contestId: '42', market: 'spread', line: '-3.5' },
        side: 'nuggets', // home
        odds: '1.91',
        riskUsdc: '25',
      }),
    ).rejects.toThrow(/closed/);
  });
});

describe('prepareSubmit — total negative-line guard (review #4 blocker 2)', () => {
  it('rejects negative --line on total markets (binds wrong speculationKey otherwise)', async () => {
    const contest = buildContest({ speculations: [] });
    const ctx = buildContext({ contest });
    await expect(
      prepareSubmit(ctx, {
        parent: { kind: 'contest', contestId: '42', market: 'total', line: '-8.5' },
        side: 'over',
        odds: '1.95',
        riskUsdc: '10',
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it('accepts positive --line on total without inversion', async () => {
    const contest = buildContest({ speculations: [] });
    const ctx = buildContext({ contest, allowance: 10_000_000n });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'total', line: '8.5' },
      side: 'over',
      odds: '1.95',
      riskUsdc: '10',
    });
    expect(preview.market.lineTicks).toBe(85);
    expect(preview.market.displayLine).toBe('Over 8.5');
  });

  it('rejects pinned total speculation whose lineTicks is negative (existing-spec invariant)', async () => {
    // The raw escape hatch + permissionless lazy creation mean we
    // could in principle encounter a negative-line total spec on
    // chain. The high-level resolver must fail closed rather than
    // sign a commitment whose preview ("Over X") disagrees with the
    // raw tuple (lineTicks=-X).
    const ctx = buildContext({
      spec: buildSpec({
        speculationId: '700',
        type: 'total',
        lineTicks: -85,
        line: -8.5,
      }),
      allowance: 10_000_000n,
    });
    await expect(
      prepareSubmit(ctx, {
        parent: { kind: 'speculation', speculationId: '700' },
        side: 'over',
        odds: '1.95',
        riskUsdc: '10',
      }),
    ).rejects.toThrow(/non-negative.*display semantics.*raw tuple/i);
  });

  it('rejects --contest --market total no-line when the unique open total has negative lineTicks', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '710',
          contestId: '42',
          type: 'total',
          lineTicks: -85,
          line: -8.5,
          speculationStatus: 0, // open, but negative — bad data
        },
      ],
    });
    const ctx = buildContext({ contest, allowance: 10_000_000n });
    await expect(
      prepareSubmit(ctx, {
        parent: { kind: 'contest', contestId: '42', market: 'total' },
        side: 'over',
        odds: '1.95',
        riskUsdc: '10',
      }),
    ).rejects.toThrow(/non-negative/i);
  });

  it('positive existing total speculation still works (regression for the new invariant)', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '720',
          contestId: '42',
          type: 'total',
          lineTicks: 85,
          line: 8.5,
          speculationStatus: 0,
        },
      ],
    });
    const ctx = buildContext({ contest, allowance: 10_000_000n });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'total' },
      side: 'over',
      odds: '1.95',
      riskUsdc: '10',
    });
    expect(preview.market.lineTicks).toBe(85);
    expect(preview.market.speculation).toMatchObject({ mode: 'existing', speculationId: '720' });
  });
});

describe('submitPrepared — sanity guards', () => {
  it('refuses to sign if preview chainId differs from client', async () => {
    const ctx = buildContext({});
    const preview = await prepareSubmit(ctx, speculationArgs());
    // Mutate the preview to claim a different chain.
    const tampered: SubmitPreview = {
      ...preview,
      raw: { ...preview.raw, chainId: 80002 },
    };
    await expect(submitPrepared(ctx, tampered)).rejects.toThrow(/chainId/);
  });

  it('refuses to sign if preview verifyingContract differs from client MatchingModule', async () => {
    const ctx = buildContext({});
    const preview = await prepareSubmit(ctx, speculationArgs());
    const tampered: SubmitPreview = {
      ...preview,
      raw: { ...preview.raw, verifyingContract: '0x'.padEnd(42, 'd') },
    };
    await expect(submitPrepared(ctx, tampered)).rejects.toThrow(/verifyingContract/);
  });

  it('refuses to sign if preview.raw.speculationKey was tampered with (review #4 also-fix 2)', async () => {
    const ctx = buildContext({});
    const preview = await prepareSubmit(ctx, speculationArgs());
    // Tamper just the bundled key — leave contestId/scorer/lineTicks
    // intact. The defense-in-depth re-derivation must catch this.
    const tampered: SubmitPreview = {
      ...preview,
      raw: { ...preview.raw, speculationKey: '0x' + 'aa'.repeat(32) },
    };
    await expect(submitPrepared(ctx, tampered)).rejects.toThrow(/speculationKey/);
  });

  it('refuses to sign a hand-built preview whose line is out of the magnitude bound (backstop)', async () => {
    const ctx = buildContext({});
    const preview = await prepareSubmit(ctx, speculationArgs());
    const poisonedLine = MAX_LINE_TICKS + 1;
    // Re-derive a MATCHING speculationKey for the poisoned line so the key
    // cross-check passes — the magnitude guard must be the thing that rejects.
    const key = deriveSpeculationKey(
      BigInt(preview.raw.contestId),
      preview.raw.scorer as Hex,
      poisonedLine,
    );
    const tampered: SubmitPreview = {
      ...preview,
      raw: { ...preview.raw, lineTicks: poisonedLine, speculationKey: key },
    };
    await expect(submitPrepared(ctx, tampered)).rejects.toMatchObject({ field: 'lineTicks' });
  });
});

describe('submitPrepared — NONCE_TOO_LOW propagation', () => {
  it('does not silently retry; surfaces OspexAPIError so the caller re-prepares', async () => {
    const ctx = buildContext({});
    const preview = await prepareSubmit(ctx, speculationArgs());
    // Override the api to throw NONCE_TOO_LOW once.
    ctx.api = {
      request: vi.fn(async () => {
        throw new OspexAPIError('nonce too low', { apiCode: 'NONCE_TOO_LOW', status: 409 });
      }),
    } as unknown as CommitmentsContext['api'];
    await expect(submitPrepared(ctx, preview)).rejects.toThrow(OspexAPIError);
    await expect(submitPrepared(ctx, preview)).rejects.toMatchObject({
      apiCode: 'NONCE_TOO_LOW',
    });
  });
});

describe('submitPrepared — happy path returns signedPayload', () => {
  it('result carries SignedCommitmentPayload that round-trips to result.hash', async () => {
    const ctx = buildContext({ allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs());

    // Stub api.request to echo a minimum-viable CommitmentBody for the
    // preview's raw fields. `requireVisibleCommitment` only narrows on
    // discriminators; the body just needs to decode as visible (no
    // `bookVisible: false`).
    ctx.api = {
      request: vi.fn(async () => ({
        commitmentHash: preview.raw.speculationKey, // overwritten by toCommitment — placeholder
        maker: preview.raw.maker,
        contestId: preview.raw.contestId,
        scorer: preview.raw.scorer,
        lineTicks: preview.raw.lineTicks,
        positionType: preview.raw.positionType,
        oddsTick: preview.raw.oddsTick,
        marketType: 'moneyline',
        riskAmount: preview.raw.riskAmount,
        filledRiskAmount: '0',
        remainingRiskAmount: preview.raw.riskAmount,
        nonce: preview.raw.nonce,
        expiry: new Date(Number(preview.raw.expiry) * 1000).toISOString(),
        speculationKey: preview.raw.speculationKey,
        signature: '0x'.padEnd(132, 's'),
        status: 'open',
        source: 'agent',
        network: 'polygon',
        nonceInvalidated: false,
        createdAt: new Date().toISOString(),
      })),
    } as unknown as CommitmentsContext['api'];

    const result = await submitPrepared(ctx, preview);

    // The canonical typed payload is present on the happy path.
    expect(result.signedPayload).toBeDefined();
    // The hash on the payload is the same hash on the result envelope —
    // both are the SDK's locally-computed `hashCommitment(domain, message)`.
    expect(result.signedPayload.commitmentHash).toBe(result.hash);
    // The signature on the payload is what the test signer returned —
    // the SDK does NOT mutate it before persisting on the payload.
    expect(result.signedPayload.signature).toBe('0x'.padEnd(132, 's'));
    // The commitment struct on the payload matches the preview's `raw`
    // (in bigint form), so a caller can hand it straight to
    // `cancelOnchainSigned(payload)` without reconstruction.
    expect(result.signedPayload.commitment.maker.toLowerCase()).toBe(
      preview.raw.maker.toLowerCase(),
    );
    expect(result.signedPayload.commitment.contestId).toBe(BigInt(preview.raw.contestId));
    expect(result.signedPayload.commitment.scorer.toLowerCase()).toBe(
      preview.raw.scorer.toLowerCase(),
    );
    expect(result.signedPayload.commitment.lineTicks).toBe(preview.raw.lineTicks);
    expect(result.signedPayload.commitment.positionType).toBe(preview.raw.positionType);
    expect(result.signedPayload.commitment.oddsTick).toBe(preview.raw.oddsTick);
    expect(result.signedPayload.commitment.riskAmount).toBe(BigInt(preview.raw.riskAmount));
    expect(result.signedPayload.commitment.nonce).toBe(BigInt(preview.raw.nonce));
    expect(result.signedPayload.commitment.expiry).toBe(BigInt(preview.raw.expiry));
  });
});

// ── Expiry: defaults, durations, matchTime guard, source annotation ──

describe('prepareSubmit — expiry defaults (no --expiry passed)', () => {
  it('matchTime 3h away → expiry equals matchTime exactly (default-match-time source)', async () => {
    const matchTimeMs = Date.now() + 3 * 60 * 60 * 1000;
    const matchTimeIso = new Date(matchTimeMs).toISOString();
    const expectedSec = BigInt(Math.floor(matchTimeMs / 1000));
    const spec = buildSpec({ contest: { ...buildSpec().contest, matchTime: matchTimeIso } });
    const ctx = buildContext({ spec, allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs());
    expect(preview.expiry.unixSec).toBe(expectedSec.toString());
    expect(preview.expiry.source).toBe('default-match-time');
    expect(preview.expiry.afterMatchTime).toBe(false);
  });

  it('matchTime 20m away → expiry equals matchTime exactly, NOT now + 1h', async () => {
    // A "1h floor" would push expiry past match start for games that
    // tip off in <60 minutes. The default rule has NO floor — short
    // windows must stay short.
    const matchTimeMs = Date.now() + 20 * 60 * 1000; // 20 minutes from now
    const matchTimeIso = new Date(matchTimeMs).toISOString();
    const expectedSec = BigInt(Math.floor(matchTimeMs / 1000));
    const spec = buildSpec({ contest: { ...buildSpec().contest, matchTime: matchTimeIso } });
    const ctx = buildContext({ spec, allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs());
    expect(preview.expiry.unixSec).toBe(expectedSec.toString());
    expect(preview.expiry.source).toBe('default-match-time');
    // Sanity: the chosen expiry is well under 1h from now (proves no floor).
    const oneHourFromNowSec = BigInt(Math.floor(Date.now() / 1000) + 3600);
    expect(BigInt(preview.expiry.unixSec) < oneHourFromNowSec).toBe(true);
  });

  it('matchTime already past → throws and tells the user to pass --expiry explicitly', async () => {
    const matchTimePastIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const spec = buildSpec({ contest: { ...buildSpec().contest, matchTime: matchTimePastIso } });
    const ctx = buildContext({ spec, allowance: 1_000_000n });
    await expect(prepareSubmit(ctx, speculationArgs())).rejects.toThrow(
      /match time has already passed/,
    );
    await expect(prepareSubmit(ctx, speculationArgs())).rejects.toThrow(
      /Pass --expiry explicitly/,
    );
  });

  it('matchTime missing/empty → falls back to now + 1h with missing-match-time-fallback source', async () => {
    const spec = buildSpec({ contest: { ...buildSpec().contest, matchTime: '' } });
    const ctx = buildContext({ spec, allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs());
    expect(preview.expiry.source).toBe('missing-match-time-fallback');
    const expirySec = BigInt(preview.expiry.unixSec);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    // Within ±10s of now+1h (to absorb test-timing jitter).
    expect(expirySec - (nowSec + 3600n) >= -10n && expirySec - (nowSec + 3600n) <= 10n).toBe(true);
    // matchTimeUnixSec is null when matchTime was missing/invalid.
    expect(preview.expiry.matchTimeUnixSec).toBeNull();
  });

  it('matchTime invalid (not a parseable date) → falls back to now + 1h', async () => {
    const spec = buildSpec({ contest: { ...buildSpec().contest, matchTime: 'not-a-date' } });
    const ctx = buildContext({ spec, allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs());
    expect(preview.expiry.source).toBe('missing-match-time-fallback');
    expect(preview.expiry.matchTimeUnixSec).toBeNull();
  });
});

describe('prepareSubmit — explicit --expiry: durations', () => {
  it('30m → expiry equals now + 30 minutes, source=user-relative', async () => {
    const ctx = buildContext({ allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs({ expiry: '30m' }));
    const expirySec = BigInt(preview.expiry.unixSec);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    expect(expirySec - (nowSec + 1800n) >= -10n && expirySec - (nowSec + 1800n) <= 10n).toBe(true);
    expect(preview.expiry.source).toBe('user-relative');
  });

  it('accepts 4h, 1d, 1w as duration units', async () => {
    const cases: Array<[string, bigint]> = [
      ['4h', 4n * 3600n],
      ['1d', 86400n],
      ['1w', 604800n],
    ];
    for (const [input, expectedOffsetSec] of cases) {
      const ctx = buildContext({ allowance: 1_000_000n });
      const preview = await prepareSubmit(ctx, speculationArgs({ expiry: input }));
      const expirySec = BigInt(preview.expiry.unixSec);
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const drift = expirySec - (nowSec + expectedOffsetSec);
      expect(drift >= -10n && drift <= 10n).toBe(true);
      expect(preview.expiry.source).toBe('user-relative');
    }
  });

  it('rejects malformed durations (0m, 30x, 4hh)', async () => {
    const ctx = buildContext({ allowance: 1_000_000n });
    // Zero magnitude — the duration shape matches but value is invalid.
    await expect(prepareSubmit(ctx, speculationArgs({ expiry: '0m' }))).rejects.toThrow(
      /magnitude must be > 0/,
    );
    // Unknown unit — falls through to ISO parser, which rejects.
    await expect(prepareSubmit(ctx, speculationArgs({ expiry: '30x' }))).rejects.toThrow(
      /Invalid --expiry/,
    );
    // Repeated unit char — same fall-through.
    await expect(prepareSubmit(ctx, speculationArgs({ expiry: '4hh' }))).rejects.toThrow(
      /Invalid --expiry/,
    );
  });
});

describe('prepareSubmit — explicit --expiry: ISO + unix still work', () => {
  it('ISO-8601 with Z → source=user-iso, matches the parsed timestamp', async () => {
    // Pick something safely in the future and within 1y of now.
    const futureMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const futureIso = new Date(futureMs).toISOString();
    const expectedSec = BigInt(Math.floor(futureMs / 1000));
    const ctx = buildContext({ allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs({ expiry: futureIso }));
    expect(preview.expiry.unixSec).toBe(expectedSec.toString());
    expect(preview.expiry.source).toBe('user-iso');
  });

  it('ISO-8601 with explicit ±HH:MM offset → source=user-iso', async () => {
    // Same instant in -05:00 wall clock. To express the UTC instant
    // T as a -05:00 ISO string, the wall-clock value is T - 5h
    // (because "15:00 in a tz 5h behind UTC" = "20:00 UTC").
    const futureMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const expectedSec = BigInt(Math.floor(futureMs / 1000));
    const offsetIso = new Date(futureMs - 5 * 60 * 60 * 1000)
      .toISOString()
      .replace('Z', '-05:00');
    const ctx = buildContext({ allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs({ expiry: offsetIso }));
    expect(preview.expiry.source).toBe('user-iso');
    expect(preview.expiry.unixSec).toBe(expectedSec.toString());
  });

  it('unix-seconds string → source=user-unix', async () => {
    const expectedSec = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
    const ctx = buildContext({ allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs({ expiry: expectedSec.toString() }));
    expect(preview.expiry.unixSec).toBe(expectedSec.toString());
    expect(preview.expiry.source).toBe('user-unix');
  });
});

describe('prepareSubmit — afterMatchTime warning flag', () => {
  it('explicit --expiry past matchTime → afterMatchTime=true', async () => {
    // matchTime 1h from now, --expiry 1d → expiry well past match start.
    const matchTimeMs = Date.now() + 60 * 60 * 1000;
    const matchTimeIso = new Date(matchTimeMs).toISOString();
    const spec = buildSpec({ contest: { ...buildSpec().contest, matchTime: matchTimeIso } });
    const ctx = buildContext({ spec, allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs({ expiry: '1d' }));
    expect(preview.expiry.afterMatchTime).toBe(true);
    expect(preview.expiry.source).toBe('user-relative');
  });

  it('default (matchTime exactly) → afterMatchTime=false', async () => {
    const ctx = buildContext({ allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs());
    expect(preview.expiry.afterMatchTime).toBe(false);
    expect(preview.expiry.source).toBe('default-match-time');
  });
});

// ── TreasuryModule (lazy creation fee) allowance preflight ──────────

describe('prepareSubmit — TreasuryModule allowance preflight', () => {
  it('lazy commit + sufficient PositionModule + zero TreasuryModule → 2-row approvals[], lazy row needsApproval=true', async () => {
    // --contest path with no existing speculation → lazy mode. Maker
    // has covered the risk via PositionModule but never touched
    // TreasuryModule for this wallet, so the lazy creation fee row
    // is short and the preview tells the user.
    const contest = buildContest({ speculations: [] });
    const ctx = buildContext({
      contest,
      allowance: 1_000_000n, // PositionModule covers the 1 USDC risk
      treasuryAllowance: 0n,  // TreasuryModule has nothing
    });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'moneyline' },
      side: 'lakers',
      odds: '2.50',
      riskUsdc: '1',
    });
    expect(preview.market.speculation.mode).toBe('lazy');
    expect(preview.approvals).toHaveLength(2);
    expect(preview.approvals[0]).toMatchObject({
      purpose: 'commitment-risk',
      needsApproval: false,
    });
    expect(preview.approvals[1]).toMatchObject({
      purpose: 'lazy-creation-fee',
      required: '250000', // 0.25 USDC = canonical mainnet maker share
      current: '0',
      needsApproval: true,
    });
  });

  it('lazy commit + sufficient TreasuryModule allowance → lazy row present, needsApproval=false', async () => {
    const contest = buildContest({ speculations: [] });
    const ctx = buildContext({
      contest,
      allowance: 1_000_000n,
      treasuryAllowance: 250_000n, // exactly meets the lazy fee
    });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'moneyline' },
      side: 'lakers',
      odds: '2.50',
      riskUsdc: '1',
    });
    expect(preview.approvals).toHaveLength(2);
    expect(preview.approvals[1]?.needsApproval).toBe(false);
  });

  it('lazy commit with both allowances short → BOTH rows flagged needsApproval', async () => {
    const contest = buildContest({ speculations: [] });
    const ctx = buildContext({
      contest,
      allowance: 0n,
      treasuryAllowance: 0n,
    });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'moneyline' },
      side: 'lakers',
      odds: '2.50',
      riskUsdc: '1',
    });
    expect(preview.approvals).toHaveLength(2);
    expect(preview.approvals[0]?.needsApproval).toBe(true);
    expect(preview.approvals[1]?.needsApproval).toBe(true);
  });

  it('existing speculation → no TreasuryModule preflight, no lazy-creation-fee row', async () => {
    // The --speculation path always points at an existing speculation.
    // Once the speculation exists, no creation fee is charged on
    // future matches, so the SDK skips the TreasuryModule allowance
    // read entirely (preview.approvals is single-row).
    const ctx = buildContext({ allowance: 1_000_000n, treasuryAllowance: 0n });
    const preview = await prepareSubmit(ctx, speculationArgs());
    expect(preview.market.speculation.mode).toBe('existing');
    expect(preview.approvals).toHaveLength(1);
    expect(preview.approvals[0]?.purpose).toBe('commitment-risk');
  });

  it('--contest with matching existing speculation → no TreasuryModule preflight', async () => {
    // --contest can resolve to either lazy (no spec) or existing (spec
    // already created from a prior match). Existing → no fee → no
    // TreasuryModule row.
    const contest = buildContest({
      speculations: [
        {
          speculationId: '100',
          contestId: '42',
          type: 'moneyline',
          lineTicks: 0,
          line: 0,
          speculationStatus: 0,
        },
      ],
    });
    const ctx = buildContext({
      contest,
      allowance: 1_000_000n,
      treasuryAllowance: 0n,
    });
    const preview = await prepareSubmit(ctx, {
      parent: { kind: 'contest', contestId: '42', market: 'moneyline' },
      side: 'lakers',
      odds: '2.50',
      riskUsdc: '1',
    });
    expect(preview.market.speculation.mode).toBe('existing');
    expect(preview.approvals).toHaveLength(1);
    expect(preview.approvals[0]?.purpose).toBe('commitment-risk');
  });
});

describe('prepareSubmit — maker override (preview-only without signer unlock)', () => {
  // Mirrors prepareMatch's `taker` override. Spec §17.2: `--json`
  // preview-only paths must not trigger a passphrase prompt or
  // keystore decrypt. The SDK side of that contract is `args.maker`
  // — when set, prepareSubmit MUST NOT call signer.getAddress.

  const EXPLICIT_MAKER: Hex = '0x'.padEnd(42, 'e') as Hex;

  it('uses args.maker when provided', async () => {
    const ctx = buildContext({ allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, {
      ...speculationArgs(),
      maker: EXPLICIT_MAKER,
    });
    expect(preview.raw.maker.toLowerCase()).toBe(EXPLICIT_MAKER.toLowerCase());
  });

  it('does NOT call signer.getAddress when args.maker is provided', async () => {
    const signer = buildSigner();
    const contestsApi = {
      get: vi.fn(async () => buildContest()),
      list: vi.fn(),
    } as unknown as ReturnType<CommitmentsContext['getContestsApi']>;
    const speculationsApi = {
      get: vi.fn(async () => buildSpec()),
      list: vi.fn(),
    } as unknown as ReturnType<CommitmentsContext['getSpeculationsApi']>;
    const teams = {
      aliases: vi.fn(async () => ALIASES),
      invalidateCache: vi.fn(),
    } as unknown as ReturnType<CommitmentsContext['getTeams']>;
    const ctx: CommitmentsContext = {
      api: {} as CommitmentsContext['api'],
      requireSigner: () => signer,
      getChainId: () => 137,
      getAddresses: () => ADDRESSES,
      requireChainClient: () =>
        buildPublicClient({ allowance: 1_000_000n }) as ReturnType<CommitmentsContext['requireChainClient']>,
      nonceCounter: new NonceCounter(),
      getContestsApi: () => contestsApi,
      getSpeculationsApi: () => speculationsApi,
      getTeams: () => teams,
    };
    await prepareSubmit(ctx, { ...speculationArgs(), maker: EXPLICIT_MAKER });
    expect(signer.getAddress).not.toHaveBeenCalled();
  });

  it('works when no signer is configured at all (requireSigner would throw)', async () => {
    const contestsApi = {
      get: vi.fn(async () => buildContest()),
      list: vi.fn(),
    } as unknown as ReturnType<CommitmentsContext['getContestsApi']>;
    const speculationsApi = {
      get: vi.fn(async () => buildSpec()),
      list: vi.fn(),
    } as unknown as ReturnType<CommitmentsContext['getSpeculationsApi']>;
    const teams = {
      aliases: vi.fn(async () => ALIASES),
      invalidateCache: vi.fn(),
    } as unknown as ReturnType<CommitmentsContext['getTeams']>;
    const ctx: CommitmentsContext = {
      api: {} as CommitmentsContext['api'],
      requireSigner: () => {
        throw new Error('no signer configured — should never be called');
      },
      getChainId: () => 137,
      getAddresses: () => ADDRESSES,
      requireChainClient: () =>
        buildPublicClient({ allowance: 1_000_000n }) as ReturnType<CommitmentsContext['requireChainClient']>,
      nonceCounter: new NonceCounter(),
      getContestsApi: () => contestsApi,
      getSpeculationsApi: () => speculationsApi,
      getTeams: () => teams,
    };
    const preview = await prepareSubmit(ctx, {
      ...speculationArgs(),
      maker: EXPLICIT_MAKER,
    });
    expect(preview.raw.maker.toLowerCase()).toBe(EXPLICIT_MAKER.toLowerCase());
  });

  it('falls back to signer.getAddress when args.maker is unset (current behavior preserved)', async () => {
    const ctx = buildContext({ allowance: 1_000_000n });
    const preview = await prepareSubmit(ctx, speculationArgs());
    expect(preview.raw.maker.toLowerCase()).toBe(MAKER.toLowerCase());
  });
});
