/**
 * Unit tests for `checkSubmitFundability` — the advisory maker-side submit
 * preflight. Mocks the maker's open-book list (via `ctx.api.request`) and the
 * chain client (USDC balanceOf + allowance + block number). The SubmitPreview is
 * a minimal fixture — the primitive only reads `raw.maker`, `raw.speculationKey`,
 * `economics.riskWei6`, `approvals[]`, and `submitAction`.
 *
 * Covers:
 *   - happy path → fundable, with requirement + checkedAtBlock populated
 *   - each maker funding shortfall (balance / PositionModule / TreasuryModule)
 *   - the whole-VISIBLE-book aggregate: a new commitment that fits in isolation but tips
 *     the book past the wallet → not-fundable (the gap submit's approve loop misses)
 *   - a book-hidden (redacted) row is SKIPPED (visible-book-only), never degraded to unknown
 *   - partially-filled remaining is counted at risk − filled, and a partially-filled
 *     row is NOT treated as maybe-lazy (its speculation is already created)
 *   - this submit's lazy-creation-fee Treasury leg folds into balance + Treasury allowance
 *   - EXISTING never-matched commitments' POSSIBLE lazy fees: covered → fundable,
 *     straddling the funding line → unknown (EXISTING_LAZY_FEE_UNDETERMINED),
 *     definite risk shortfall → not-fundable; deduped by speculation key; the new
 *     commitment's own key is excluded
 *   - existing-open-risk pagination (a full page triggers a second list call)
 *   - degraded reads → unknown, never a false fundable; a definite shortfall still wins;
 *     a failed open-book list → unknown, but a definite new-commitment-alone shortfall still wins
 */

import { describe, expect, it, vi } from 'vitest';
import { checkSubmitFundability } from '../src/commitments/checkSubmitFundability.js';
import { SPECULATION_CREATION_FEE_MAKER_SHARE_WEI6 } from '../src/contracts/constants.js';
import { KeystoreSigner } from '../src/signers/keystore.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { Hex, Signer } from '../src/types/signer.js';
import type { StoredCommitmentStatus } from '../src/types/commitment.js';
import type { SubmitPreview } from '../src/types/preview.js';

const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
const FEE = SPECULATION_CREATION_FEE_MAKER_SHARE_WEI6[137]; // maker creation-fee share on chain 137

// Speculation keys (32-byte hex). The new commitment's key is distinct from the
// default existing-row key so existing rows aren't accidentally excluded.
const NEW_KEY = '0x'.padEnd(66, 'e');
const ROW_KEY = '0x'.padEnd(66, '7');
const KEY_A = '0x'.padEnd(66, 'a');
const KEY_B = '0x'.padEnd(66, 'b');

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
const USDC = ADDRESSES.usdc.toLowerCase();
const allowKey = (owner: string, spender: string): string =>
  `${owner.toLowerCase()}|${spender.toLowerCase()}`;

/** Minimal SubmitPreview — only the fields `checkSubmitFundability` reads. */
function makePreview(opts: { riskWei6?: bigint; lazy?: boolean; maker?: Hex; speculationKey?: string } = {}): SubmitPreview {
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
  if (opts.lazy === true) {
    approvals.push({
      token: 'USDC',
      spender: ADDRESSES.treasuryModule,
      required: FEE.toString(),
      current: '0',
      needsApproval: false,
      purpose: 'lazy-creation-fee',
    });
  }
  return {
    raw: { maker: opts.maker ?? MAKER, speculationKey: opts.speculationKey ?? NEW_KEY },
    economics: { riskWei6: risk.toString() },
    approvals,
    submitAction: opts.lazy === true ? 'trade-and-create-speculation' : 'trade-only',
  } as unknown as SubmitPreview;
}

/** A maker open-book row carrying just the fields the primitive reads. */
function row(
  remainingWei6: bigint,
  opts: { storedStatus?: StoredCommitmentStatus; speculationKey?: string } = {},
): Record<string, unknown> {
  const stored = opts.storedStatus ?? 'open';
  return {
    commitmentHash: '0x'.padEnd(66, '7'),
    remainingRiskAmount: remainingWei6.toString(),
    status: stored,
    storedStatus: stored,
    speculationKey: opts.speculationKey ?? ROW_KEY,
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
    expect(r.scope).toBe('visible-book-only');
    // Default mode is signer-free + hidden-excluded (the buildContext signer throws if touched).
    expect(r.coverage).toEqual({ visible: 'included', hidden: 'excluded', source: 'public-commitments' });
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
      existingMaybeLazyKeyCount: 0,
      existingLazyFeeMaxWei6: 0n,
      balanceRequiredWei6: 1_000_000n,
    });
  });

  it('counts a partially-filled row at remaining, and does NOT treat it as maybe-lazy', async () => {
    // remaining 0.4 USDC, already matched → its speculation exists → owes no creation fee.
    const { ctx } = buildContext({ existing: [row(400_000n, { storedStatus: 'partially_filled' })] });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('fundable');
    expect(r.requirement).toMatchObject({
      existingOpenRiskWei6: 400_000n,
      existingMaybeLazyKeyCount: 0, // partially-filled → speculation created → not maybe-lazy
      existingLazyFeeMaxWei6: 0n,
      balanceRequiredWei6: 1_400_000n,
    });
  });
});

describe('checkSubmitFundability — funding shortfalls', () => {
  it('whole-visible-book over-commitment: new commitment fits alone but tips the book past the wallet → not-fundable', async () => {
    // Existing 100 USDC open, new 10 USDC, wallet 105 USDC. The new commitment
    // (10) fits in 105 in isolation — submit's per-commitment approve loop sees
    // no problem — but the 110 aggregate doesn't. This is exactly the gap B1 closes.
    const { ctx } = buildContext({
      existing: [row(100_000_000n)],
      pc: { balances: { [MAKER.toLowerCase()]: 105_000_000n } },
    });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 10_000_000n }) });
    expect(r.outcome).toBe('not-fundable');
    expect(r.scope).toBe('visible-book-only');
    expect(r.reasons.find((x) => x.code === 'MAKER_USDC_BALANCE_INSUFFICIENT')).toMatchObject({
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
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n, lazy: true }) });
    expect(r.outcome).toBe('not-fundable');
    expect(r.requirement).toMatchObject({
      lazyCreation: true,
      lazyCreationFeeWei6: FEE,
      balanceRequiredWei6: 1_000_000n + FEE, // new 1.0 + fee
      treasuryAllowanceRequiredWei6: FEE,
    });
    expect(r.reasons.find((x) => x.code === 'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT')).toMatchObject({
      spender: TREASURY,
      requiredWei6: FEE,
      actualWei6: 0n,
    });
  });

  it('lazy submit fully funded → fundable (Treasury leg satisfied)', async () => {
    const { ctx } = buildContext({ existing: [] });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n, lazy: true }) });
    expect(r.outcome).toBe('fundable');
  });
});

describe('checkSubmitFundability — existing maybe-lazy creation fees', () => {
  // Two distinct existing OPEN keys → each MIGHT owe a maker creation fee at match.
  const twoLazy = [row(1_000_000n, { speculationKey: KEY_A }), row(1_000_000n, { speculationKey: KEY_B })];

  it('funding covers the definite risk but not the worst-case existing lazy fees → unknown (EXISTING_LAZY_FEE_UNDETERMINED)', async () => {
    // existing risk 2.0, new 1.0 → definite balance req 3.0; max adds 2 × FEE.
    // Wallet 3.2 ≥ 3.0 (no definite shortfall) but < 3.0 + 2×0.25 = 3.5 → unknown.
    const { ctx } = buildContext({
      existing: twoLazy,
      pc: { balances: { [MAKER.toLowerCase()]: 3_200_000n } },
    });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('unknown');
    expect(r.fundableNow).toBe(false);
    expect(r.reasons.map((x) => x.code)).toEqual(['EXISTING_LAZY_FEE_UNDETERMINED']);
    expect(r.reasons[0]?.requiredWei6).toBe(2n * FEE);
    expect(r.requirement).toMatchObject({
      existingMaybeLazyKeyCount: 2,
      existingLazyFeeMaxWei6: 2n * FEE,
      balanceRequiredWei6: 3_000_000n,
    });
  });

  it('funding covers even the worst-case existing lazy fees → fundable', async () => {
    const { ctx } = buildContext({
      existing: twoLazy,
      pc: { balances: { [MAKER.toLowerCase()]: 3_000_000n + 2n * FEE } }, // ≥ upper bound
    });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('fundable');
  });

  it('a definite risk shortfall wins over the lazy-fee uncertainty → not-fundable', async () => {
    const { ctx } = buildContext({
      existing: twoLazy,
      pc: { balances: { [MAKER.toLowerCase()]: 2_500_000n } }, // < 3.0 definite
    });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('not-fundable');
    expect(r.reasons.map((x) => x.code)).toEqual(['MAKER_USDC_BALANCE_INSUFFICIENT']);
  });

  it('dedupes existing maybe-lazy keys: many open commitments on ONE key → a single possible fee', async () => {
    const { ctx } = buildContext({
      existing: [
        row(1_000_000n, { speculationKey: KEY_A }),
        row(1_000_000n, { speculationKey: KEY_A }),
        row(1_000_000n, { speculationKey: KEY_A }),
      ],
      pc: { balances: { [MAKER.toLowerCase()]: 4_100_000n } }, // ≥ 4.0 definite, < 4.0 + 1×0.25
    });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('unknown');
    expect(r.requirement?.existingMaybeLazyKeyCount).toBe(1); // deduped
    expect(r.requirement?.existingLazyFeeMaxWei6).toBe(FEE);
  });

  it('excludes the new commitment’s own key from the existing maybe-lazy set (no double-count)', async () => {
    // The maker already has an open commitment on the SAME key they’re re-posting.
    const { ctx } = buildContext({ existing: [row(1_000_000n, { speculationKey: NEW_KEY })] });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('fundable');
    expect(r.requirement).toMatchObject({
      existingOpenRiskWei6: 1_000_000n, // still counted toward risk
      existingMaybeLazyKeyCount: 0, // but not an extra possible fee
    });
  });

  it('a live OPEN row with a null speculationKey is counted as its own maybe-lazy key (upper bound), not dropped', async () => {
    // A never-matched open row whose speculationKey can't be disambiguated must
    // still contribute one possible creation fee — dropping it would under-count
    // the worst case and risk a false `fundable`.
    const nullKeyOpen: Record<string, unknown> = {
      commitmentHash: '0x' + 'd0'.repeat(32),
      remainingRiskAmount: '1000000',
      status: 'open',
      storedStatus: 'open',
      speculationKey: null,
      nonceInvalidated: false,
      expiry: '2099-01-01T00:00:00Z',
    };
    const { ctx } = buildContext({
      existing: [nullKeyOpen],
      pc: { balances: { [MAKER.toLowerCase()]: 2_000_000n + FEE - 1n } }, // ≥ 2.0 definite, < 2.0 + FEE
    });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('unknown');
    expect(r.reasons.map((x) => x.code)).toEqual(['EXISTING_LAZY_FEE_UNDETERMINED']);
    expect(r.requirement).toMatchObject({ existingMaybeLazyKeyCount: 1, existingLazyFeeMaxWei6: FEE });
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
    expect(r.scope).toBe('visible-book-only');
    expect(r.reasons.map((x) => x.code)).toEqual(['FUNDABILITY_UNKNOWN']);
    expect(r.requirement).toBeUndefined();
  });

  it('open-book list failed BUT the wallet can’t cover the new commitment alone → still not-fundable', async () => {
    // Even without the existing book, balance < the new-commitment lower bound is a definite shortfall.
    const { ctx } = buildContext({ failList: true, pc: { balances: { [MAKER.toLowerCase()]: 0n } } });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('not-fundable');
    expect(r.reasons.map((x) => x.code)).toEqual(['MAKER_USDC_BALANCE_INSUFFICIENT']);
    expect(r.reasons[0]?.requiredWei6).toBe(1_000_000n); // new-commitment lower bound
    expect(r.requirement).toBeUndefined(); // can't form the full aggregate
  });

  it('a failed block read alone just drops checkedAtBlock; the verdict still resolves', async () => {
    const { ctx } = buildContext({ existing: [], pc: { failBlockNumber: true } });
    const r = await checkSubmitFundability(ctx, { preview: makePreview() });
    expect(r.outcome).toBe('fundable');
    expect(r.checkedAtBlock).toBeUndefined();
  });

  it('a hidden (redacted) row in the maker book is skipped — visible-book-only, NOT degraded to unknown', async () => {
    // The public commitments list filters `book_visible=true` server-side, so a
    // maker's book-hidden but still-on-chain-matchable rows never reach this
    // scan at all; a stray redacted row (only via `?since=` recovery / core-api
    // defensive projection, neither of which this scan uses) is likewise
    // skipped. The verdict is VISIBLE-BOOK-ONLY: it sums only the visible rows
    // and does NOT degrade to `unknown` for the hidden one — claiming otherwise
    // would promise a protection this anonymous read cannot deliver. The maker
    // accounts for hidden exposure via owner-auth `client.ownState.*`; the
    // result advertises the limit via `scope`.
    const hiddenRow: Record<string, unknown> = {
      commitmentHash: '0x' + 'ff'.repeat(32),
      maker: MAKER,
      contestId: '42',
      positionType: 0,
      status: 'cancelled',
      storedStatus: 'open',
      filledRiskAmount: '0',
      expiry: '2099-01-01T00:00:00Z',
      bookVisible: false,
      nonceInvalidated: false,
      redacted: true,
      payloadAvailable: false,
    };
    const { ctx } = buildContext({ existing: [row(1_000_000n), hiddenRow] });
    const r = await checkSubmitFundability(ctx, { preview: makePreview({ riskWei6: 1_000_000n }) });
    expect(r.outcome).toBe('fundable'); // NOT 'unknown' — the hidden row does not degrade the verdict
    expect(r.scope).toBe('visible-book-only');
    // Only the visible row is summed; the hidden row contributes nothing to the aggregate.
    expect(r.requirement).toMatchObject({
      existingOpenRiskWei6: 1_000_000n,
      existingOpenCommitmentCount: 1,
    });
  });
});

// ── whole-book mode (bookScope: 'whole-book', own-state-sourced) ──────────

// Anvil account #0 — a real signer so the EIP-712 stream-auth mint actually runs.
const WB_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const WB_MAKER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Hex; // its address (lowercase)

/** A wire OwnerCommitmentBody for the own-state snapshot mock — mirrors the shape
 *  the core-api own-state surface emits (visible + hidden, unredacted). */
function ownerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commitmentHash: '0x' + '11'.repeat(32),
    maker: WB_MAKER,
    contestId: '42',
    scorer: '0x' + '22'.repeat(20),
    lineTicks: 0,
    positionType: 0,
    oddsTick: 200,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '1',
    expiry: new Date(Date.now() + 600_000).toISOString(),
    speculationKey: '0x' + 'aa'.repeat(32),
    signature: '0x' + 'bb'.repeat(65),
    status: 'open',
    storedStatus: 'open',
    source: 'sdk',
    network: 'polygon',
    nonceInvalidated: false,
    bookVisible: true,
    createdAt: new Date().toISOString(),
    speculationId: '7',
    sport: 'americanfootball_nfl',
    awayTeam: 'A',
    homeTeam: 'H',
    updatedAtUnixSec: 1735700000,
    signedPayload: null,
    ...overrides,
  };
}

interface WBOpts {
  /** Own-state snapshot pages (indexed by cursor). Default one empty, non-truncated page. */
  pages?: Array<{ commitments: Array<Record<string, unknown>>; truncated: boolean }>;
  pc?: PCOpts;
  failChallenge?: boolean;
  failToken?: boolean;
  failSnapshot?: boolean;
  /** Public-list fallback rows (used only when the own-state read is unavailable). */
  existing?: Array<Record<string, unknown>>;
  failList?: boolean;
  /** Override the configured signer; `null` → `requireSigner()` throws. Default: a real WB_MAKER signer. */
  signer?: Signer | null;
}

function buildWholeBookContext(opts: WBOpts = {}): { ctx: CommitmentsContext; snapshotCalls: () => number } {
  const counter = { snapshotCalls: 0 };
  const now = Math.floor(Date.now() / 1000);
  const pages = opts.pages ?? [{ commitments: [], truncated: false }];
  const request = vi.fn(async (path: string, init?: { query?: Record<string, unknown> }) => {
    if (path === '/v1/auth/stream-challenge') {
      if (opts.failChallenge) throw new Error('challenge 503');
      return {
        challenge: {
          address: WB_MAKER,
          resource: 'own-state',
          scope: 'read:own-state',
          network: { chainId: 137 },
          audience: 'api.ospex.test',
          challengeId: 'CID_wb_test',
          issuedAt: now,
          expiresAt: now + 180,
        },
        expiresAt: now + 180,
      };
    }
    if (path === '/v1/auth/stream-token') {
      if (opts.failToken) throw new Error('token 503');
      return { token: 'WB_TOKEN', expiresAt: now + 900 };
    }
    if (path === '/v1/own-state/snapshot') {
      if (opts.failSnapshot) throw new Error('snapshot 503');
      counter.snapshotCalls += 1;
      const cursor = init?.query?.cursor as string | undefined;
      const idx = cursor === undefined ? 0 : Number(cursor);
      const page = pages[Math.min(idx, pages.length - 1)]!;
      return {
        cursor: String(idx + 1),
        commitments: page.commitments,
        positions: [],
        truncated: page.truncated,
        positionsTruncated: false,
      };
    }
    if (path === '/v1/commitments') {
      if (opts.failList) throw new Error('list 503');
      return { commitments: opts.existing ?? [] };
    }
    throw new Error(`unexpected path: ${path}`);
  });
  const signer =
    opts.signer === undefined ? KeystoreSigner.fromPrivateKey(WB_PRIVATE_KEY) : opts.signer;
  const ctx: CommitmentsContext = {
    api: { request } as unknown as CommitmentsContext['api'],
    requireSigner: () => {
      if (signer === null) throw new Error('no signer configured');
      return signer;
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
  return { ctx, snapshotCalls: () => counter.snapshotCalls };
}

/** A live, already-matched (partially-filled → not maybe-lazy) own-state row. */
function liveOwnerRow(
  hashByte: string,
  remainingWei6: bigint,
  opts: { bookVisible?: boolean; keyByte?: string } = {},
): Record<string, unknown> {
  return ownerBody({
    commitmentHash: '0x' + hashByte.repeat(32),
    bookVisible: opts.bookVisible ?? false,
    storedStatus: 'partially_filled',
    status: 'partially_filled',
    riskAmount: (remainingWei6 + 1_000_000n).toString(),
    filledRiskAmount: '1000000',
    remainingRiskAmount: remainingWei6.toString(),
    speculationKey: '0x' + (opts.keyByte ?? hashByte).repeat(32),
  });
}

describe('checkSubmitFundability — whole-book (own-state) mode', () => {
  it('whole-book without a signer → unknown (HIDDEN_EXPOSURE_UNKNOWN), never fundable', async () => {
    const { ctx } = buildContext({ existing: [] }); // buildContext.requireSigner throws if touched
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n }),
      bookScope: 'whole-book',
    });
    expect(r.outcome).toBe('unknown');
    expect(r.fundableNow).toBe(false);
    expect(r.reasons.map((x) => x.code)).toEqual(['HIDDEN_EXPOSURE_UNKNOWN']);
    expect(r.scope).toBe('visible-book-only'); // achieved scope, not the request
    expect(r.coverage).toEqual({ visible: 'included', hidden: 'unknown', source: 'mixed' });
  });

  it('whole-book with a signer that is not the maker → unknown, and never touches own-state', async () => {
    // Configured signer is WB_MAKER, but the preview maker is the default MAKER → mismatch.
    const { ctx, snapshotCalls } = buildWholeBookContext({ existing: [] });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n }),
      bookScope: 'whole-book',
    });
    expect(r.outcome).toBe('unknown');
    expect(r.reasons.map((x) => x.code)).toEqual(['HIDDEN_EXPOSURE_UNKNOWN']);
    expect(r.coverage.hidden).toBe('unknown');
    expect(snapshotCalls()).toBe(0); // short-circuits before minting / snapshotting
  });

  it('whole-book sums visible + hidden live commitments from own-state (no double-count)', async () => {
    const visible = liveOwnerRow('11', 2_000_000n, { bookVisible: true, keyByte: 'a1' });
    const hidden = liveOwnerRow('22', 3_000_000n, { bookVisible: false, keyByte: 'a2' });
    const { ctx } = buildWholeBookContext({ pages: [{ commitments: [visible, hidden], truncated: false }] });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n, maker: WB_MAKER }),
      bookScope: 'whole-book',
    });
    expect(r.scope).toBe('whole-book');
    expect(r.coverage).toEqual({ visible: 'included', hidden: 'included', source: 'own-state' });
    expect(r.outcome).toBe('fundable'); // default 1e9 balance/allowances cover it
    expect(r.requirement).toMatchObject({
      existingOpenRiskWei6: 5_000_000n, // 2M visible + 3M hidden
      existingOpenCommitmentCount: 2,
      existingVisibleOpenRiskWei6: 2_000_000n,
      existingVisibleOpenCommitmentCount: 1,
      existingHiddenOpenRiskWei6: 3_000_000n,
      existingHiddenOpenCommitmentCount: 1,
    });
  });

  it('a hidden still-live row raises the requirement → whole-book flips a visible-only fundable to not-fundable', async () => {
    // Visible book empty, hidden book 5 USDC, new 1 USDC. Wallet holds 4 USDC:
    // visible-only would say fundable (0 + 1 ≤ 4), whole-book says NOT (0 + 5 + 1 > 4).
    const hidden = liveOwnerRow('33', 5_000_000n, { bookVisible: false, keyByte: 'a3' });
    const { ctx } = buildWholeBookContext({
      pages: [{ commitments: [hidden], truncated: false }],
      pc: { balances: { [WB_MAKER]: 4_000_000n } },
    });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n, maker: WB_MAKER }),
      bookScope: 'whole-book',
    });
    expect(r.scope).toBe('whole-book');
    expect(r.outcome).toBe('not-fundable');
    expect(r.reasons.find((x) => x.code === 'MAKER_USDC_BALANCE_INSUFFICIENT')).toMatchObject({
      requiredWei6: 6_000_000n, // hidden 5 + new 1
      actualWei6: 4_000_000n,
    });
    expect(r.requirement).toMatchObject({ existingHiddenOpenRiskWei6: 5_000_000n });
  });

  it('whole-book excludes non-live hidden rows (expired / nonce-invalidated / filled)', async () => {
    const expired = ownerBody({ commitmentHash: '0x' + '44'.repeat(32), bookVisible: false, expiry: new Date(Date.now() - 60_000).toISOString() });
    const invalidated = ownerBody({ commitmentHash: '0x' + '55'.repeat(32), bookVisible: false, nonceInvalidated: true });
    const filled = liveOwnerRow('66', 0n, { bookVisible: false }); // remaining 0 → not live
    const live = liveOwnerRow('77', 2_000_000n, { bookVisible: false, keyByte: 'a7' });
    const { ctx } = buildWholeBookContext({
      pages: [{ commitments: [expired, invalidated, filled, live], truncated: false }],
    });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n, maker: WB_MAKER }),
      bookScope: 'whole-book',
    });
    expect(r.scope).toBe('whole-book');
    expect(r.requirement).toMatchObject({
      existingOpenRiskWei6: 2_000_000n, // only the one live row
      existingOpenCommitmentCount: 1,
      existingHiddenOpenRiskWei6: 2_000_000n,
      existingHiddenOpenCommitmentCount: 1,
    });
  });

  it('whole-book drains all snapshot pages (truncated) and de-dupes by hash across pages', async () => {
    const a = liveOwnerRow('81', 2_000_000n, { bookVisible: false, keyByte: 'b1' });
    const b = liveOwnerRow('82', 3_000_000n, { bookVisible: true, keyByte: 'b2' });
    const { ctx, snapshotCalls } = buildWholeBookContext({
      pages: [
        { commitments: [a], truncated: true },
        { commitments: [a, b], truncated: false }, // `a` repeated → must be de-duped
      ],
    });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n, maker: WB_MAKER }),
      bookScope: 'whole-book',
    });
    expect(snapshotCalls()).toBe(2);
    expect(r.scope).toBe('whole-book');
    expect(r.requirement).toMatchObject({
      existingOpenRiskWei6: 5_000_000n, // a(2M) + b(3M), a counted once
      existingOpenCommitmentCount: 2,
    });
  });

  it('whole-book own-state snapshot failure → unknown (HIDDEN_EXPOSURE_UNKNOWN), never fundable', async () => {
    const { ctx } = buildWholeBookContext({ failSnapshot: true, existing: [] });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n, maker: WB_MAKER }),
      bookScope: 'whole-book',
    });
    expect(r.outcome).toBe('unknown');
    expect(r.reasons.map((x) => x.code)).toEqual(['HIDDEN_EXPOSURE_UNKNOWN']);
    expect(r.scope).toBe('visible-book-only');
    expect(r.coverage).toEqual({ visible: 'included', hidden: 'unknown', source: 'mixed' });
  });

  it('whole-book token mint failure → unknown, never fundable', async () => {
    const { ctx } = buildWholeBookContext({ failToken: true, existing: [] });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n, maker: WB_MAKER }),
      bookScope: 'whole-book',
    });
    expect(r.outcome).toBe('unknown');
    expect(r.reasons.map((x) => x.code)).toEqual(['HIDDEN_EXPOSURE_UNKNOWN']);
  });

  it('whole-book own-state never fully drains (page cap) → unknown, not a partial sum', async () => {
    const a = liveOwnerRow('91', 2_000_000n, { bookVisible: false });
    const { ctx, snapshotCalls } = buildWholeBookContext({
      pages: [{ commitments: [a], truncated: true }], // always truncated → never drains
      existing: [],
    });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n, maker: WB_MAKER }),
      bookScope: 'whole-book',
    });
    expect(r.outcome).toBe('unknown');
    expect(r.reasons.map((x) => x.code)).toEqual(['HIDDEN_EXPOSURE_UNKNOWN']);
    expect(snapshotCalls()).toBe(50); // MAX_SNAPSHOT_PAGES — bounded, then degrades
  });

  it('whole-book: a definite visible/new shortfall still returns not-fundable even when own-state is unavailable', async () => {
    // own-state unavailable (no signer); wallet can't even cover the new commitment alone.
    const { ctx } = buildContext({ existing: [], pc: { balances: { [MAKER.toLowerCase()]: 0n } } });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n }),
      bookScope: 'whole-book',
    });
    expect(r.outcome).toBe('not-fundable'); // a definite shortfall wins over hidden-unknown
    expect(r.reasons.map((x) => x.code)).toEqual(['MAKER_USDC_BALANCE_INSUFFICIENT']);
  });

  it('whole-book maybe-lazy-fee accounting includes hidden live OPEN commitments', async () => {
    // A hidden, never-matched (open) commitment on a distinct key MIGHT owe a creation fee.
    const hiddenOpen = ownerBody({
      commitmentHash: '0x' + 'cc'.repeat(32),
      bookVisible: false,
      storedStatus: 'open',
      status: 'open',
      riskAmount: '1000000',
      filledRiskAmount: '0',
      remainingRiskAmount: '1000000',
      speculationKey: '0x' + 'c1'.repeat(32),
    });
    const { ctx } = buildWholeBookContext({
      pages: [{ commitments: [hiddenOpen], truncated: false }],
      // ≥ 2.0 definite (hidden 1 + new 1), but < 2.0 + FEE worst-case lazy → unknown.
      pc: { balances: { [WB_MAKER]: 2_000_000n + FEE - 1n } },
    });
    const r = await checkSubmitFundability(ctx, {
      preview: makePreview({ riskWei6: 1_000_000n, maker: WB_MAKER }),
      bookScope: 'whole-book',
    });
    expect(r.scope).toBe('whole-book');
    expect(r.outcome).toBe('unknown');
    expect(r.reasons.map((x) => x.code)).toEqual(['EXISTING_LAZY_FEE_UNDETERMINED']);
    expect(r.requirement).toMatchObject({
      existingMaybeLazyKeyCount: 1, // the hidden open key
      existingLazyFeeMaxWei6: FEE,
      existingHiddenOpenRiskWei6: 1_000_000n,
    });
  });
});
