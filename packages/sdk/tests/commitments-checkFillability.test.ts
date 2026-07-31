/**
 * Unit tests for `checkCommitmentFillability` — the advisory taker-side
 * preflight. Mocks the contest fetch (via `prepareMatch`) and the chain client
 * (USDC balanceOf + allowance + block number).
 *
 * Covers:
 *   - liveness short-circuit (expired / nonce-invalidated / no-capacity /
 *     not-live) returns before ANY chain read
 *   - happy path → fillable, with checkedAtBlock + fill populated
 *   - each funding shortfall, including the maker→PositionModule allowance the
 *     match flow never checks today
 *   - self-match COMBINED debit (the per-leg checks each pass; the sum fails)
 *   - lazy creation-fee Treasury legs
 *   - closed speculation → SPECULATION_CLOSED
 *   - degraded read (RPC failure) → unknown, never a false not-fillable
 *   - arg validation
 */

import { describe, expect, it, vi } from 'vitest';
import { checkCommitmentFillability } from '../src/commitments/checkFillability.js';
import { MAX_LINE_TICKS } from '../src/commitments/validation.js';
import { NonceCounter } from '../src/commitments/context.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { Hex, Signer } from '../src/types/signer.js';
import type { PublicVisibleCommitment } from '../src/types/commitment.js';
import type { Contest } from '../src/types/contest.js';

const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
const TAKER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const SCORER = '0x4444444444444444444444444444444444444444' as Hex;
const HASH = '0x'.padEnd(66, '5') as Hex;
const FAR_FUTURE_ISO = '2099-05-08T02:00:00Z';
const PAST_ISO = '2000-01-01T00:00:00Z';

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
  creOracleReceiver: '0x'.padEnd(42, 'a') as Hex,
  scorers: {
    moneyline: '0x'.padEnd(42, 'e') as Hex,
    spread: '0x'.padEnd(42, 'f') as Hex,
    total: '0x'.padEnd(42, '0') as Hex,
  },
};

const POSITION = ADDRESSES.positionModule.toLowerCase();
const TREASURY = ADDRESSES.treasuryModule.toLowerCase();

const allowKey = (owner: string, spender: string): string =>
  `${owner.toLowerCase()}|${spender.toLowerCase()}`;

// makeCommitment defaults: oddsTick 250, remaining 1 USDC →
//   makerRisk (fill)  = 1_000_000 (1 USDC)
//   takerRisk         = 1_500_000 (1.5 USDC)
const MAKER_RISK = 1_000_000n;
const TAKER_RISK = 1_500_000n;

function buildSigner(addr: Hex = TAKER): Signer {
  return {
    getAddress: vi.fn(async () => addr),
    signTypedData: vi.fn(),
    signTransaction: vi.fn(),
  } as unknown as Signer;
}

function makeCommitment(
  overrides: Partial<PublicVisibleCommitment> = {},
): PublicVisibleCommitment {
  return {
    visibility: 'visible',
    redacted: false,
    commitmentHash: HASH,
    maker: MAKER,
    contestId: '42',
    scorer: SCORER,
    lineTicks: 0,
    positionType: 0,
    oddsTick: 250,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '17000000001',
    expiry: FAR_FUTURE_ISO,
    speculationKey: '0x'.padEnd(66, 'a'),
    signature: '0x'.padEnd(132, 's'),
    status: 'open',
    storedStatus: 'open',
    source: 'submit',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2026-05-09T00:00:00Z',
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
    matchTime: FAR_FUTURE_ISO,
    status: 'verified',
    awayTeamId: 'lakers-uuid',
    homeTeamId: 'nuggets-uuid',
    speculations: [],
    ...overrides,
  };
}

/** An open speculation matching the makeCommitment tuple → existing mode. */
function openSpec(): Contest {
  return buildContest({
    speculations: [
      {
        speculationId: '101',
        contestId: '42',
        type: 'moneyline',
        lineTicks: 0,
        line: 0,
        speculationStatus: 0,
        winSide: null,
        settledAt: null,
        voided: false,
      },
    ],
  });
}

interface PCOpts {
  balances?: Record<string, bigint>;
  allowances?: Record<string, bigint>;
  defaultBalance?: bigint;
  defaultAllowance?: bigint;
  blockNumber?: bigint;
  failBalanceOf?: boolean;
  failBlockNumber?: boolean;
}

function buildPublicClient(
  opts: PCOpts,
  reads: Array<{ functionName: string; args: readonly unknown[] }>,
): unknown {
  const defBal = opts.defaultBalance ?? 1_000_000_000n;
  const defAllow = opts.defaultAllowance ?? 1_000_000_000n;
  return {
    readContract: vi.fn(
      async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        reads.push({ functionName, args });
        if (functionName === 'balanceOf') {
          if (opts.failBalanceOf) throw new Error('rpc balanceOf failed');
          const acc = (args[0] as string).toLowerCase();
          return opts.balances?.[acc] ?? defBal;
        }
        if (functionName === 'allowance') {
          const owner = (args[0] as string).toLowerCase();
          const spender = (args[1] as string).toLowerCase();
          return opts.allowances?.[`${owner}|${spender}`] ?? defAllow;
        }
        throw new Error(`unexpected readContract: ${functionName}`);
      },
    ),
    getBlockNumber: vi.fn(async () => {
      if (opts.failBlockNumber) throw new Error('rpc block failed');
      return opts.blockNumber ?? 73_491_234n;
    }),
  };
}

interface CtxOpts {
  contest?: Contest;
  pc?: PCOpts;
  signerAddr?: Hex;
}

function buildContext(opts: CtxOpts = {}): {
  ctx: CommitmentsContext;
  reads: Array<{ functionName: string; args: readonly unknown[] }>;
} {
  const reads: Array<{ functionName: string; args: readonly unknown[] }> = [];
  const contestsApi = {
    get: vi.fn(async () => opts.contest ?? openSpec()),
    list: vi.fn(),
    scripts: vi.fn(),
  } as unknown as ReturnType<CommitmentsContext['getContestsApi']>;
  const ctx: CommitmentsContext = {
    api: { request: vi.fn() } as unknown as CommitmentsContext['api'],
    requireSigner: () => buildSigner(opts.signerAddr ?? TAKER),
    getChainId: () => 137,
    getAddresses: () => ADDRESSES,
    requireChainClient: () =>
      buildPublicClient(opts.pc ?? {}, reads) as ReturnType<
        CommitmentsContext['requireChainClient']
      >,
    nonceCounter: new NonceCounter(),
    getContestsApi: () => contestsApi,
    getSpeculationsApi: () => ({}) as ReturnType<CommitmentsContext['getSpeculationsApi']>,
    getTeams: () => ({}) as ReturnType<CommitmentsContext['getTeams']>,
  };
  return { ctx, reads };
}

describe('checkCommitmentFillability — liveness short-circuit (no chain reads)', () => {
  it('expired commitment → not-fillable EXPIRED, no chain reads', async () => {
    const { ctx, reads } = buildContext();
    const commitment = makeCommitment({ expiry: PAST_ISO, isLive: false });
    const r = await checkCommitmentFillability(ctx, { commitment, taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    expect(r.fillableNow).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain('EXPIRED');
    // No funding evaluated → no block/fill, and no readContract calls.
    expect(r.checkedAtBlock).toBeUndefined();
    expect(r.fill).toBeUndefined();
    expect(reads).toHaveLength(0);
  });

  it('nonce-invalidated → NONCE_INVALIDATED', async () => {
    const { ctx } = buildContext();
    const commitment = makeCommitment({ nonceInvalidated: true, isLive: false });
    const r = await checkCommitmentFillability(ctx, { commitment, taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    expect(r.reasons.map((x) => x.code)).toContain('NONCE_INVALIDATED');
  });

  it('no remaining capacity → NO_REMAINING_CAPACITY', async () => {
    const { ctx } = buildContext();
    const commitment = makeCommitment({
      filledRiskAmount: '1000000',
      remainingRiskAmount: '0',
      status: 'filled',
      storedStatus: 'filled',
      isLive: false,
    });
    const r = await checkCommitmentFillability(ctx, { commitment, taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    expect(r.reasons.map((x) => x.code)).toContain('NO_REMAINING_CAPACITY');
  });

  it('stored status cancelled → NOT_LIVE', async () => {
    const { ctx } = buildContext();
    const commitment = makeCommitment({
      status: 'cancelled',
      storedStatus: 'cancelled',
      isLive: false,
    });
    const r = await checkCommitmentFillability(ctx, { commitment, taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    expect(r.reasons.map((x) => x.code)).toContain('NOT_LIVE');
  });
});

describe('checkCommitmentFillability — out-of-range line (fund-lock guard)', () => {
  it('|lineTicks| over MAX_LINE_TICKS → not-fillable LINE_TICKS_OUT_OF_RANGE, no chain reads', async () => {
    const { ctx, reads } = buildContext();
    const commitment = makeCommitment({ marketType: 'spread', lineTicks: MAX_LINE_TICKS + 1 });
    const r = await checkCommitmentFillability(ctx, { commitment, taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    expect(r.fillableNow).toBe(false);
    expect(r.reasons.map((x) => x.code)).toEqual(['LINE_TICKS_OUT_OF_RANGE']);
    // Decided from the signed commitment alone — no funding evaluated, no reads.
    expect(r.checkedAtBlock).toBeUndefined();
    expect(r.fill).toBeUndefined();
    expect(reads).toHaveLength(0);
  });

  it('the negative magnitude boundary is symmetric', async () => {
    const { ctx } = buildContext();
    const commitment = makeCommitment({ marketType: 'spread', lineTicks: -(MAX_LINE_TICKS + 1) });
    const r = await checkCommitmentFillability(ctx, { commitment, taker: TAKER });
    expect(r.reasons.map((x) => x.code)).toEqual(['LINE_TICKS_OUT_OF_RANGE']);
  });

  it('resolves the verdict even when no chain client is configured (short-circuits before requireChainClient)', async () => {
    const { ctx } = buildContext();
    const noChainCtx: CommitmentsContext = {
      ...ctx,
      requireChainClient: () => {
        throw new Error('rpcUrl required');
      },
    };
    const commitment = makeCommitment({ marketType: 'spread', lineTicks: MAX_LINE_TICKS + 5 });
    const r = await checkCommitmentFillability(noChainCtx, { commitment, taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    expect(r.reasons.map((x) => x.code)).toEqual(['LINE_TICKS_OUT_OF_RANGE']);
  });

  it('a missing (null) lineTicks is NOT_LIVE, never the fund-lock reason', async () => {
    // A null lineTicks is a missing required field, not an out-of-range line:
    // the 0b short-circuit skips it (null-guarded), liveness passes it, and
    // prepareMatch's missing-field check throws `field: 'lineTicks'`. That must
    // map to NOT_LIVE — mislabeling a benign missing field as the catastrophic
    // fund-lock reason would be a false alarm.
    const { ctx } = buildContext();
    const commitment = makeCommitment({ lineTicks: null });
    const r = await checkCommitmentFillability(ctx, { commitment, taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    expect(r.reasons.map((x) => x.code)).toContain('NOT_LIVE');
    expect(r.reasons.map((x) => x.code)).not.toContain('LINE_TICKS_OUT_OF_RANGE');
  });
});

describe('checkCommitmentFillability — funding (existing speculation)', () => {
  it('happy path → fillable, with checkedAtBlock + fill populated', async () => {
    const { ctx } = buildContext({ contest: openSpec() });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: TAKER });
    expect(r.outcome).toBe('fillable');
    expect(r.fillableNow).toBe(true);
    expect(r.reasons).toHaveLength(0);
    expect(r.advisory).toBe(true);
    expect(r.checkedAtBlock).toBe(73_491_234n);
    expect(r.fill).toEqual({ makerRiskWei6: MAKER_RISK, takerRiskWei6: TAKER_RISK, selfMatch: false });
  });

  it('maker USDC balance short → MAKER_USDC_BALANCE_INSUFFICIENT', async () => {
    const { ctx } = buildContext({
      contest: openSpec(),
      pc: { balances: { [MAKER.toLowerCase()]: 0n } },
    });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    const reason = r.reasons.find((x) => x.code === 'MAKER_USDC_BALANCE_INSUFFICIENT');
    expect(reason).toMatchObject({ account: 'maker', requiredWei6: MAKER_RISK, actualWei6: 0n });
  });

  it('maker PositionModule allowance short → MAKER_POSITION_ALLOWANCE_INSUFFICIENT (the gap the match flow lacks)', async () => {
    const { ctx } = buildContext({
      contest: openSpec(),
      pc: { allowances: { [allowKey(MAKER, POSITION)]: 0n } },
    });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    const reason = r.reasons.find((x) => x.code === 'MAKER_POSITION_ALLOWANCE_INSUFFICIENT');
    expect(reason).toMatchObject({
      account: 'maker',
      spender: POSITION,
      requiredWei6: MAKER_RISK,
      actualWei6: 0n,
    });
  });

  it('taker USDC balance short → TAKER_USDC_BALANCE_INSUFFICIENT', async () => {
    const { ctx } = buildContext({
      contest: openSpec(),
      pc: { balances: { [TAKER.toLowerCase()]: 100n } },
    });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    const reason = r.reasons.find((x) => x.code === 'TAKER_USDC_BALANCE_INSUFFICIENT');
    expect(reason).toMatchObject({ account: 'taker', requiredWei6: TAKER_RISK, actualWei6: 100n });
  });

  it('taker PositionModule allowance short → TAKER_POSITION_ALLOWANCE_INSUFFICIENT', async () => {
    const { ctx } = buildContext({
      contest: openSpec(),
      pc: { allowances: { [allowKey(TAKER, POSITION)]: 0n } },
    });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    const reason = r.reasons.find((x) => x.code === 'TAKER_POSITION_ALLOWANCE_INSUFFICIENT');
    expect(reason).toMatchObject({ account: 'taker', spender: POSITION, requiredWei6: TAKER_RISK });
  });
});

describe('checkCommitmentFillability — self-match combined debit', () => {
  it('per-leg checks each pass but the combined debit fails → MAKER_USDC_BALANCE_INSUFFICIENT', async () => {
    // maker === taker. makerRisk 1.0 + takerRisk 1.5 = 2.5 combined. A 2.0
    // wallet covers each leg individually but not the sum.
    const { ctx } = buildContext({
      contest: openSpec(),
      signerAddr: MAKER,
      pc: { balances: { [MAKER.toLowerCase()]: 2_000_000n } },
    });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: MAKER });
    expect(r.outcome).toBe('not-fillable');
    expect(r.fill?.selfMatch).toBe(true);
    // Exactly one balance reason, with the COMBINED requirement.
    const balanceReasons = r.reasons.filter((x) => x.code.endsWith('USDC_BALANCE_INSUFFICIENT'));
    expect(balanceReasons).toHaveLength(1);
    expect(balanceReasons[0]).toMatchObject({
      code: 'MAKER_USDC_BALANCE_INSUFFICIENT',
      requiredWei6: MAKER_RISK + TAKER_RISK,
      actualWei6: 2_000_000n,
    });
  });

  it('self-match with enough for the combined debit → fillable', async () => {
    const { ctx } = buildContext({
      contest: openSpec(),
      signerAddr: MAKER,
      pc: { balances: { [MAKER.toLowerCase()]: 2_500_000n } },
    });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: MAKER });
    expect(r.outcome).toBe('fillable');
    expect(r.fill?.selfMatch).toBe(true);
  });
});

describe('checkCommitmentFillability — lazy creation fee', () => {
  it('taker Treasury allowance short on a lazy match → TAKER_TREASURY_ALLOWANCE_INSUFFICIENT', async () => {
    // Empty speculations[] → lazy mode → 0.25 USDC treasury debit per side.
    const { ctx } = buildContext({
      contest: buildContest({ speculations: [] }),
      pc: { allowances: { [allowKey(TAKER, TREASURY)]: 0n } },
    });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    const reason = r.reasons.find((x) => x.code === 'TAKER_TREASURY_ALLOWANCE_INSUFFICIENT');
    expect(reason).toMatchObject({ account: 'taker', spender: TREASURY, requiredWei6: 250_000n });
  });

  it('lazy match fully funded → fillable (Treasury legs included)', async () => {
    const { ctx } = buildContext({ contest: buildContest({ speculations: [] }) });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: TAKER });
    expect(r.outcome).toBe('fillable');
  });
});

describe('checkCommitmentFillability — closed speculation', () => {
  it('matching but closed speculation → SPECULATION_CLOSED', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '101',
          contestId: '42',
          type: 'moneyline',
          lineTicks: 0,
          line: 0,
          speculationStatus: 1, // closed
          winSide: 'away',
          settledAt: '2026-01-01T00:00:00Z',
          voided: false,
        },
      ],
    });
    const { ctx } = buildContext({ contest });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: TAKER });
    expect(r.outcome).toBe('not-fillable');
    expect(r.reasons.map((x) => x.code)).toContain('SPECULATION_CLOSED');
  });
});

describe('checkCommitmentFillability — degraded reads', () => {
  it('a failed balance read → unknown (never a false not-fillable)', async () => {
    const { ctx } = buildContext({ contest: openSpec(), pc: { failBalanceOf: true } });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: TAKER });
    expect(r.outcome).toBe('unknown');
    expect(r.fillableNow).toBe(false);
    expect(r.reasons.map((x) => x.code)).toEqual(['FILLABILITY_UNKNOWN']);
  });

  it('a failed block read just drops checkedAtBlock; the verdict still resolves', async () => {
    const { ctx } = buildContext({ contest: openSpec(), pc: { failBlockNumber: true } });
    const r = await checkCommitmentFillability(ctx, { commitment: makeCommitment(), taker: TAKER });
    expect(r.outcome).toBe('fillable');
    expect(r.checkedAtBlock).toBeUndefined();
  });
});

describe('checkCommitmentFillability — arg validation', () => {
  it('rejects when both { hash } and { commitment } are provided', async () => {
    const { ctx } = buildContext();
    await expect(
      checkCommitmentFillability(ctx, { hash: HASH, commitment: makeCommitment(), taker: TAKER }),
    ).rejects.toThrow(/either.*not both/i);
  });

  it('rejects when neither is provided', async () => {
    const { ctx } = buildContext();
    await expect(checkCommitmentFillability(ctx, { taker: TAKER })).rejects.toThrow(/required/i);
  });
});
