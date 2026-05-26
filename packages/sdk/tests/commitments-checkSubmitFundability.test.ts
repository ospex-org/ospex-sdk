/**
 * Unit tests for `checkSubmitFundability` — the advisory maker-side submit
 * preflight. Mocks the maker's open-book list (via `ctx.api.request`) and the
 * chain client (USDC balanceOf + allowance + block number). The SubmitPreview is
 * a minimal fixture — the primitive only reads `raw.maker`, `economics.riskWei6`,
 * `approvals[]`, and `submitAction`.
 *
 * Covers:
 *   - happy path → fundable, with requirement + checkedAtBlock populated
 *   - each maker funding shortfall (balance / PositionModule / TreasuryModule)
 *   - the WHOLE-BOOK aggregate: a new commitment that fits in isolation but tips
 *     the book past the wallet → not-fundable (the gap submit's approve loop misses)
 *   - partially-filled remaining is counted at risk − filled
 *   - lazy-creation-fee Treasury leg folds into balance + Treasury allowance
 *   - existing-open-risk pagination (a full page triggers a second list call)
 *   - degraded reads → unknown, never a false fundable; a definite shortfall still wins
 *   - a failed open-book list → unknown (can't compute the aggregate)
 */

import { describe, expect, it, vi } from 'vitest';
import { checkSubmitFundability } from '../src/commitments/checkSubmitFundability.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { Hex } from '../src/types/signer.js';
import type { SubmitPreview } from '../src/types/preview.js';

const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;

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

const POSITION = ADDRESSES.positionModule.toLowerCase();
const TREASURY = ADDRESSES.treasuryModule.toLowerCase();
const USDC = ADDRESSES.usdc.toLowerCase();
const allowKey = (owner: string, spender: string): string =>
  `${owner.toLowerCase()}|${spender.toLowerCase()}`;

/** Minimal SubmitPreview — only the fields `checkSubmitFundability` reads. */
function makePreview(opts: { riskWei6?: bigint; lazyFeeWei6?: bigint; maker?: Hex } = {}): SubmitPreview {
  const risk = opts.riskWei6 ?? 1_000_000n;
  const approvals: Array<Record<string, unknown>> = [
    {
      token: 'USDC',
      spender: ADDRESSES.positionModule,
      required: risk.toString(),
      current: '0',
      needsApproval: false,
      purpose: 'commitment-risk',
    },
  ];
  if (opts.lazyFeeWei6 !== undefined) {
    approvals.push({
      token: 'USDC',
      spender: ADDRESSES.treasuryModule,
      required: opts.lazyFeeWei6.toString(),
      current: '0',
      needsApproval: false,
      purpose: 'lazy-creation-fee',
    });
  }
  return {
    raw: { maker: opts.maker ?? MAKER },
    economics: { riskWei6: risk.toString() },
    approvals,
    submitAction: opts.lazyFeeWei6 !== undefined ? 'trade-and-create-speculation' : 'trade-only',
  } as unknown as SubmitPreview;
}

/** A maker open-book row carrying just the remaining risk the primitive sums. */
function row(remainingWei6: bigint): Record<string, unknown> {
  return {
    commitmentHash: '0x'.padEnd(66, '7'),
    remainingRiskAmount: remainingWei6.toString(),
    status: 'open',
    storedStatus: 'open',
    nonceInvalidated: false,
    expiry: '2099-01-01T00:00:00Z',
  };
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

function buildPublicClient(opts: PCOpts): unknown {
  const defBal = opts.defaultBalance ?? 1_000_000_000n;
  const defAllow = opts.defaultAllowance ?? 1_000_000_000n;
  return {
    readContract: vi.fn(
      async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
        if (functionName === 'balanceOf') {
          if (opts.failBalanceOf) throw new Error('rpc balanceOf failed');
          return opts.balances?.[(args[0] as string).toLowerCase()] ?? defBal;
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
  /** Open-book rows the list returns. A function form receives the `offset` for pagination tests. */
  existing?: Array<Record<string, unknown>> | ((offset: number) => Array<Record<string, unknown>>);
  failList?: boolean;
  pc?: PCOpts;
}

function buildContext(opts: CtxOpts = {}): { ctx: CommitmentsContext; listCalls: number } {
  const counter = { listCalls: 0 };
  const request = vi.fn(async (_path: string, init?: { query?: Record<string, unknown> }) => {
    counter.listCalls += 1;
    if (opts.failList) throw new Error('list 503');
    const offset = Number(init?.query?.offset ?? 0);
    const rows =
      typeof opts.existing === 'function' ? opts.existing(offset) : (opts.existing ?? []);
    return { commitments: rows };
  });
  const ctx: CommitmentsContext = {
    api: { request } as unknown as CommitmentsContext['api'],
    requireSigner: () => {
      throw new Error('checkSubmitFundability must not require a signer');
    },
    getChainId: () => 137,
    getAddresses: () => ADDRESSES,
    requireChainClient: () =>
      buildPublicClient(opts.pc ?? {}) as ReturnType<CommitmentsContext['requireChainClient']>,
    nonceCounter: {} as CommitmentsContext['nonceCounter'],
    getContestsApi: () => ({}) as ReturnType<CommitmentsContext['getContestsApi']>,
    getSpeculationsApi: () => ({}) as ReturnType<CommitmentsContext['getSpeculationsApi']>,
    getTeams: () => ({}) as ReturnType<CommitmentsContext['getTeams']>,
  };
  return {
    ctx,
    get listCalls() {
      return counter.listCalls;
    },
  };
}

describe('checkSubmitFundability — fundable', () => {
  it('happy path → fundable with requirement + checkedAtBlock', async () => {
    const { ctx } = buildContext({ existing: [row(2_000_000n)] }); // 2 USDC already open
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('fundable');
    expect(r.fundableNow).toBe(true);
    expect(r.advisory).toBe(true);
    expect(r.maker).toBe(MAKER);
    expect(r.reasons).toHaveLength(0);
    expect(r.checkedAtBlock).toBe(73_491_234n);
    expect(r.requirement).toMatchObject({
      newCommitmentRiskWei6: 1_000_000n,
      existingOpenRiskWei6: 2_000_000n,
      existingOpenCommitmentCount: 1,
      lazyCreationFeeWei6: 0n,
      lazyCreation: false,
      balanceRequiredWei6: 3_000_000n,
      positionAllowanceRequiredWei6: 3_000_000n,
      treasuryAllowanceRequiredWei6: 0n,
    });
  });

  it('no existing open commitments → required is just the new commitment', async () => {
    const { ctx } = buildContext({ existing: [] });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('fundable');
    expect(r.requirement).toMatchObject({
      existingOpenRiskWei6: 0n,
      existingOpenCommitmentCount: 0,
      balanceRequiredWei6: 1_000_000n,
    });
  });

  it('counts a partially-filled row at remaining (risk − filled)', async () => {
    // remaining 0.4 USDC. + new 1.0 = 1.4 required.
    const { ctx } = buildContext({ existing: [row(400_000n)] });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.requirement?.existingOpenRiskWei6).toBe(400_000n);
    expect(r.requirement?.balanceRequiredWei6).toBe(1_400_000n);
  });
});

describe('checkSubmitFundability — funding shortfalls', () => {
  it('whole-book over-commitment: new commitment fits alone but tips the book past the wallet → not-fundable', async () => {
    // Existing 100 USDC open, new 10 USDC, wallet 105 USDC. The new commitment
    // (10) fits in 105 in isolation — submit's per-commitment approve loop sees
    // no problem — but the 110 aggregate doesn't. This is exactly the gap B1 closes.
    const { ctx } = buildContext({
      existing: [row(100_000_000n)],
      pc: { balances: { [MAKER.toLowerCase()]: 105_000_000n } },
    });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 10_000_000n }) });
    expect(r.outcome).toBe('not-fundable');
    const reason = r.reasons.find((x) => x.code === 'MAKER_USDC_BALANCE_INSUFFICIENT');
    expect(reason).toMatchObject({
      token: USDC,
      requiredWei6: 110_000_000n, // existing 100 + new 10
      actualWei6: 105_000_000n,
    });
  });

  it('maker PositionModule allowance short (aggregate) → MAKER_POSITION_ALLOWANCE_INSUFFICIENT', async () => {
    const { ctx } = buildContext({
      existing: [row(2_000_000n)],
      pc: { allowances: { [allowKey(MAKER, POSITION)]: 2_500_000n } }, // < 3.0 aggregate
    });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('not-fundable');
    expect(r.reasons.find((x) => x.code === 'MAKER_POSITION_ALLOWANCE_INSUFFICIENT')).toMatchObject({
      spender: POSITION,
      requiredWei6: 3_000_000n,
      actualWei6: 2_500_000n,
    });
  });

  it('lazy submit: Treasury allowance short → MAKER_TREASURY_ALLOWANCE_INSUFFICIENT, and the fee folds into balance', async () => {
    const { ctx } = buildContext({
      existing: [],
      pc: { allowances: { [allowKey(MAKER, TREASURY)]: 0n } },
    });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n, lazyFeeWei6: 250_000n }),
    });
    expect(r.outcome).toBe('not-fundable');
    expect(r.requirement).toMatchObject({
      lazyCreation: true,
      lazyCreationFeeWei6: 250_000n,
      balanceRequiredWei6: 1_250_000n, // new 1.0 + fee 0.25
      treasuryAllowanceRequiredWei6: 250_000n,
    });
    expect(r.reasons.find((x) => x.code === 'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT')).toMatchObject({
      spender: TREASURY,
      requiredWei6: 250_000n,
      actualWei6: 0n,
    });
  });

  it('lazy submit fully funded → fundable (Treasury leg satisfied)', async () => {
    const { ctx } = buildContext({ existing: [] });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n, lazyFeeWei6: 250_000n }),
    });
    expect(r.outcome).toBe('fundable');
  });
});

describe('checkSubmitFundability — pagination', () => {
  it('sums existing open risk across pages (a full page triggers a second list call)', async () => {
    // Page 0: 1000 rows × 1000 wei6 = 1_000_000. Page 1: 1 row × 500_000. Total 1_500_000, count 1001.
    const ctxObj = buildContext({
      existing: (offset) =>
        offset === 0 ? Array.from({ length: 1000 }, () => row(1_000n)) : [row(500_000n)],
    });
    const r = await checkSubmitFundability(ctxObj.ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.requirement?.existingOpenRiskWei6).toBe(1_500_000n);
    expect(r.requirement?.existingOpenCommitmentCount).toBe(1001);
    expect(ctxObj.listCalls).toBe(2); // page 0 (full) → page 1 (partial) → stop
  });
});

describe('checkSubmitFundability — degraded reads', () => {
  it('a failed balance read → unknown (never a false fundable)', async () => {
    const { ctx } = buildContext({ existing: [], pc: { failBalanceOf: true } });
    const r = await checkSubmitFundability(ctx, { preview: makePreview() });
    expect(r.outcome).toBe('unknown');
    expect(r.fundableNow).toBe(false);
    expect(r.reasons.map((x) => x.code)).toEqual(['FUNDABILITY_UNKNOWN']);
    expect(r.requirement).toBeDefined(); // existing-risk fetched fine → requirement still computed
  });

  it('a definite shortfall from a good read wins even when another read failed', async () => {
    const { ctx } = buildContext({
      existing: [],
      pc: { failBlockNumber: true, allowances: { [allowKey(MAKER, POSITION)]: 0n } },
    });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('not-fundable'); // the allowance read proved a shortfall
    expect(r.reasons.map((x) => x.code)).toContain('MAKER_POSITION_ALLOWANCE_INSUFFICIENT');
    expect(r.checkedAtBlock).toBeUndefined(); // block read failed → dropped
  });

  it('a failed open-book list → unknown, no requirement (the aggregate is uncomputable)', async () => {
    const { ctx } = buildContext({ failList: true });
    const r = await checkSubmitFundability(ctx, { preview: makePreview() });
    expect(r.outcome).toBe('unknown');
    expect(r.reasons.map((x) => x.code)).toEqual(['FUNDABILITY_UNKNOWN']);
    expect(r.requirement).toBeUndefined();
  });

  it('a failed block read alone just drops checkedAtBlock; the verdict still resolves', async () => {
    const { ctx } = buildContext({ existing: [], pc: { failBlockNumber: true } });
    const r = await checkSubmitFundability(ctx, { preview: makePreview() });
    expect(r.outcome).toBe('fundable');
    expect(r.checkedAtBlock).toBeUndefined();
  });
});
