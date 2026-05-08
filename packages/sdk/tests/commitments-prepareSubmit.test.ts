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
import { NonceCounter } from '../src/commitments/context.js';
import { OspexAPIError, OspexValidationError } from '../src/errors.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { Hex, Signer } from '../src/types/signer.js';
import type { Contest, SpeculationDetail } from '../src/types/contest.js';
import type { TeamAlias } from '../src/commitments/resolveSide.js';
import type { SubmitPreview, HighLevelSubmitArgs } from '../src/types/preview.js';

const MAKER = '0x'.padEnd(42, 'a') as Hex;
const ADDRESSES = {
  matchingModule: '0x'.padEnd(42, '1') as Hex,
  positionModule: '0x'.padEnd(42, '2') as Hex,
  usdc: '0x'.padEnd(42, '3') as Hex,
  linkToken: '0x'.padEnd(42, '4') as Hex,
  ospexCore: '0x'.padEnd(42, '5') as Hex,
  speculationModule: '0x'.padEnd(42, '6') as Hex,
  contestModule: '0x'.padEnd(42, '7') as Hex,
  leaderboardModule: '0x'.padEnd(42, '8') as Hex,
  rulesModule: '0x'.padEnd(42, '9') as Hex,
  treasuryModule: '0x'.padEnd(42, 'b') as Hex,
  secondaryMarketModule: '0x'.padEnd(42, 'c') as Hex,
  oracleModule: '0x'.padEnd(42, 'd') as Hex,
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

function buildPublicClient(opts: { allowance?: bigint; nonceFloor?: bigint } = {}): unknown {
  const allowance = opts.allowance ?? 0n;
  const nonceFloor = opts.nonceFloor ?? 0n;
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'allowance') return allowance;
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
      matchTime: '2026-05-08T02:00:00Z',
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
    matchTime: '2026-05-08T02:00:00Z',
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
  nonceFloor,
  aliases,
}: {
  spec?: SpeculationDetail;
  contest?: Contest;
  allowance?: bigint;
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
    requireChainClient: () => buildPublicClient({ allowance, nonceFloor }) as ReturnType<
      CommitmentsContext['requireChainClient']
    >,
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

    expect(preview.market.speculation).toEqual({ mode: 'existing', speculationId: '100' });
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
    expect(preview.market.speculation).toEqual({ mode: 'existing', speculationId: '100' });
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
    expect(preview.market.speculation).toEqual({ mode: 'existing', speculationId: '100' });
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
    expect(preview.market.speculation).toEqual({ mode: 'existing', speculationId: '100' });
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
    expect(preview.market.speculation).toEqual({ mode: 'existing', speculationId: '720' });
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

void {} as OspexValidationError; // keep the import live for future tests
