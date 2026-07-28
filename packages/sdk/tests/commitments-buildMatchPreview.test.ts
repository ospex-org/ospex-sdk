/**
 * Unit tests for the pure preview-model builder for match. Covers:
 *   - economics under partial fill, full fill, lot-size rounding edges
 *   - selfMatch flag (case-insensitive)
 *   - spread / total / moneyline line displays for both maker AND taker
 *   - existing speculation: approvals[] length 1 (commitment-risk only)
 *   - lazy non-self-match: approvals[] length 2; lazy row required = half fee
 *   - lazy self-match: approvals[] length 2; lazy row required = full fee
 *   - lazy + maker treasury allowance insufficient → warning + boolean false
 *   - expiry warnings (expired, expires-soon, neither)
 *   - nonceInvalidated / isLive snapshot pass-through
 *   - both-perspective odds populated
 *   - partial-fill warning fires when fillMakerRisk < remaining
 */

import { describe, expect, it } from 'vitest';
import { OspexValidationError } from '../src/errors.js';
import {
  buildMatchPreview,
} from '../src/commitments/buildMatchPreview.js';
import type {
  BuildMatchPreviewArgs,
} from '../src/types/matchPreview.js';
import type { Commitment } from '../src/types/commitment.js';
import { usdcDecimalToAmountWei6 } from '../src/commitments/decimals.js';

const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const TAKER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
const MM = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const PM = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const TM = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const SCORER = '0x4444444444444444444444444444444444444444' as `0x${string}`;
const SPEC_KEY = '0x'.padEnd(66, 'a') as `0x${string}`;
const HASH = '0x'.padEnd(66, 'b') as `0x${string}`;

const FAR_FUTURE_ISO = '2099-05-08T02:00:00Z';

function makeCommitment(overrides: Partial<Commitment> = {}): Commitment {
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
    speculationKey: SPEC_KEY,
    signature: '0xsig',
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

function baseArgs(
  overrides: Partial<BuildMatchPreviewArgs> = {},
): BuildMatchPreviewArgs {
  return {
    commitment: makeCommitment(),
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
    speculationKey: SPEC_KEY,
    speculationCreationTotalFeeWei6: 500_000n,
    takerTreasuryAllowanceWei6: 0n,
    makerTreasuryAllowanceWei6: 0n,
    treasuryModuleAddress: TM,
    positionModuleAddress: PM,
    takerPositionAllowanceWei6: 0n,
    nowUnixSec: 1_700_000_000n, // far before FAR_FUTURE_ISO
    ...overrides,
  };
}

describe('buildMatchPreview — economics', () => {
  it('full-fill: taker risks decimal((tick - 100) / 100) per maker risk', () => {
    // maker tick 250 (decimal 2.50, +150). Maker risk 1.0 USDC.
    // Full fill: taker desired = 1.0 * (250-100)/100 = 1.5 USDC.
    // fillMakerRisk = 1.0 USDC; takerRisk = 1.5 USDC.
    const p = buildMatchPreview(baseArgs());
    expect(p.economics.remainingMakerRiskUSDC).toBe('1.000000');
    expect(p.economics.takerDesiredRiskUSDC).toBe('1.500000');
    expect(p.economics.fillMakerRiskUSDC).toBe('1.000000');
    expect(p.economics.takerRiskUSDC).toBe('1.500000');
    expect(p.economics.takerProfitOnWinUSDC).toBe('1.000000');
    expect(p.economics.takerReturnOnWinUSDC).toBe('2.500000');
  });

  it('partial fill: takerDesiredRiskWei6 < full → fillMakerRisk and takerRisk shrink', () => {
    // Same maker (1 USDC at 2.50) but taker only wants 0.5 USDC of risk.
    // fillMakerRisk math: ceil(500000 * 100 / 150) = 333334 → round-down to 333300
    //   (lot-size 100). takerRisk = 333300 * 150 / 100 = 499950.
    const p = buildMatchPreview(
      baseArgs({ takerDesiredRiskWei6: 500_000n }),
    );
    expect(BigInt(p.economics.fillMakerRiskWei6)).toBe(333_300n);
    expect(BigInt(p.economics.takerRiskWei6)).toBe(499_950n);
    expect(p.warnings).toContain('partial-fill');
  });

  it('lot-size rounding never exceeds takerDesired (clamps to desired)', () => {
    // For tick 250, takerDesired = 1.5 USDC = 1_500_000n.
    // fillMakerRisk = ceil(1500000 * 100 / 150) - mod = 1000000 ... wait,
    // (1500000 * 100 + 149) / 150 = 1000000.99... = 1000000 floor = 1000000;
    // 1000000 % 100 = 0 → fillMakerRisk = 1000000n.
    // takerRisk = 1000000 * 150 / 100 = 1500000 = takerDesired (exact).
    const p = buildMatchPreview(
      baseArgs({ takerDesiredRiskWei6: 1_500_000n }),
    );
    expect(BigInt(p.economics.fillMakerRiskWei6)).toBe(1_000_000n);
    expect(BigInt(p.economics.takerRiskWei6)).toBe(1_500_000n);
    expect(p.warnings).not.toContain('partial-fill');
  });

  it('rejects zero takerDesiredRiskWei6', () => {
    expect(() => buildMatchPreview(baseArgs({ takerDesiredRiskWei6: 0n }))).toThrow(
      /takerDesiredRiskWei6 must be positive/,
    );
  });

  it('rejects when fillMakerRisk would round to zero (sub-lot-size)', () => {
    // tick 191 (decimal 1.91). takerDesired tiny: 1 wei6 → fill rounds to 0.
    expect(() =>
      buildMatchPreview(
        baseArgs({
          commitment: makeCommitment({ oddsTick: 191 }),
          takerDesiredRiskWei6: 1n,
        }),
      ),
    ).toThrow(/fillMakerRisk=0/);
  });
});

describe('buildMatchPreview — selfMatch flag', () => {
  it('selfMatch true when maker (lowercased) === taker (lowercased)', () => {
    const sameUpper = MAKER.toUpperCase() as `0x${string}`;
    const p = buildMatchPreview(baseArgs({ taker: sameUpper }));
    expect(p.selfMatch).toBe(true);
    expect(p.warnings).toContain('self-match');
  });

  it('selfMatch false for distinct addresses', () => {
    const p = buildMatchPreview(baseArgs());
    expect(p.selfMatch).toBe(false);
    expect(p.warnings).not.toContain('self-match');
  });
});

describe('buildMatchPreview — odds (maker + taker)', () => {
  it('renders maker odds from oddsTick and computes inverse for taker', () => {
    // tick 260 (decimal 2.60, +160). Inverse: 100*260/160 = 162.5 → 163 (rounded)
    // = decimal 1.63, American -159 (round of 100/(1.63-1) ≈ -158.7 → -159).
    const p = buildMatchPreview(
      baseArgs({ commitment: makeCommitment({ oddsTick: 260 }) }),
    );
    expect(p.odds.oddsTick).toBe(260);
    expect(p.odds.makerDecimal).toBe('2.60');
    expect(p.odds.makerAmerican).toBe('+160');
    expect(p.odds.takerOddsTick).toBe(163);
    expect(p.odds.takerDecimal).toBe('1.63');
    expect(p.odds.takerAmerican).toBe('-159');
  });

  it('symmetric prices at 200 / 200 (decimal 2.00 = American +100 each side)', () => {
    const p = buildMatchPreview(
      baseArgs({ commitment: makeCommitment({ oddsTick: 200 }) }),
    );
    expect(p.odds.makerDecimal).toBe('2.00');
    expect(p.odds.takerOddsTick).toBe(200);
    expect(p.odds.takerDecimal).toBe('2.00');
    // tickToAmericanOdds renders 200 as "+100" (even money).
    expect(p.odds.makerAmerican).toBe('+100');
    expect(p.odds.takerAmerican).toBe('+100');
  });
});

describe('buildMatchPreview — sides + line displays', () => {
  it('moneyline: maker on away (positionType 0) → taker on home', () => {
    const p = buildMatchPreview(baseArgs());
    expect(p.makerSide).toMatchObject({ role: 'away', resolvedLabel: 'Los Angeles Lakers', positionType: 0 });
    expect(p.takerSide).toMatchObject({ role: 'home', resolvedLabel: 'Denver Nuggets', positionType: 1 });
    expect(p.market.makerLineDisplay).toBeNull();
    expect(p.market.takerLineDisplay).toBeNull();
  });

  it('spread: maker -3.5 (away favored) → taker +3.5 (home dog)', () => {
    // Spread storage is away-perspective. lineTicks = -35 means away
    // favored by 3.5 points. Maker on away (positionType 0) sees
    // "Lakers -3.5". Taker on home sees "Nuggets +3.5".
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'spread',
          lineTicks: -35,
          positionType: 0,
        }),
      }),
    );
    expect(p.market.makerLineDisplay).toBe('Los Angeles Lakers -3.5');
    expect(p.market.takerLineDisplay).toBe('Denver Nuggets +3.5');
  });

  it('spread: maker on HOME side flips to taker on AWAY', () => {
    // Same -3.5 line, but maker took home (positionType 1) — so maker
    // sees "Nuggets +3.5" (underdog) and taker sees "Lakers -3.5".
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'spread',
          lineTicks: -35,
          positionType: 1,
        }),
      }),
    );
    expect(p.market.makerLineDisplay).toBe('Denver Nuggets +3.5');
    expect(p.market.takerLineDisplay).toBe('Los Angeles Lakers -3.5');
  });

  it('total: maker over → taker under, line magnitude shared', () => {
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'total',
          lineTicks: 85,
          positionType: 0, // upper = over
        }),
      }),
    );
    expect(p.makerSide.role).toBe('over');
    expect(p.makerSide.resolvedLabel).toBe('over');
    expect(p.takerSide.role).toBe('under');
    expect(p.takerSide.resolvedLabel).toBe('under');
    expect(p.market.makerLineDisplay).toBe('Over 8.5');
    expect(p.market.takerLineDisplay).toBe('Under 8.5');
  });
});

describe('buildMatchPreview — approvals (existing vs lazy)', () => {
  it('existing speculation: approvals[] has only commitment-risk', () => {
    const p = buildMatchPreview(baseArgs());
    expect(p.approvals).toHaveLength(1);
    expect(p.approvals[0]?.purpose).toBe('commitment-risk');
    expect(p.approvals[0]?.spender).toBe(PM);
    expect(p.speculation.mode).toBe('existing');
    expect(p.speculation.lazyCreation).toBeUndefined();
  });

  it('lazy non-self-match: 2 rows; lazy required = half fee', () => {
    const p = buildMatchPreview(
      baseArgs({
        speculation: { mode: 'lazy' },
        speculationCreationTotalFeeWei6: 500_000n,
      }),
    );
    expect(p.approvals).toHaveLength(2);
    const lazyRow = p.approvals.find((r) => r.purpose === 'lazy-creation-fee');
    expect(lazyRow).toBeDefined();
    expect(lazyRow?.spender).toBe(TM);
    expect(BigInt(lazyRow!.required)).toBe(250_000n); // half of 500_000
    expect(p.speculation.mode).toBe('lazy');
    expect(p.speculation.lazyCreation?.takerShareWei6).toBe('250000');
    expect(p.speculation.lazyCreation?.makerShareWei6).toBe('250000');
    expect(p.speculation.lazyCreation?.totalFeeWei6).toBe('500000');
  });

  it('lazy self-match: 2 rows; lazy required = FULL fee; shares sum to total (taker carries the full fee, maker is 0)', () => {
    const p = buildMatchPreview(
      baseArgs({
        taker: MAKER,
        speculation: { mode: 'lazy' },
        speculationCreationTotalFeeWei6: 500_000n,
      }),
    );
    expect(p.selfMatch).toBe(true);
    expect(p.approvals).toHaveLength(2);
    const lazyRow = p.approvals.find((r) => r.purpose === 'lazy-creation-fee');
    // Same wallet pays both halves; the approvals[] row asks for the
    // full fee against the wallet's TreasuryModule allowance.
    expect(BigInt(lazyRow!.required)).toBe(500_000n);
    // Share fields sum to totalFeeWei6 so dashboards don't double-
    // count. The full fee is attributed to the taker side (the
    // executing party in the match flow); the maker share is 0.
    // Mirrors the docstring on `LazyCreationFee`.
    expect(p.speculation.lazyCreation?.takerShareWei6).toBe('500000');
    expect(p.speculation.lazyCreation?.makerShareWei6).toBe('0');
    // `makerTreasuryAllowanceSufficient` is trivially true on self-
    // match (any allowance covers a 0 share); the maker-allowance
    // warning is gated on !selfMatch separately.
    expect(p.speculation.lazyCreation?.makerTreasuryAllowanceSufficient).toBe(true);
  });

  it('lazy with zero total fee disables the lazy row', () => {
    const p = buildMatchPreview(
      baseArgs({
        speculation: { mode: 'lazy' },
        speculationCreationTotalFeeWei6: 0n,
      }),
    );
    expect(p.approvals).toHaveLength(1);
    expect(p.approvals[0]?.purpose).toBe('commitment-risk');
  });

  it('commitment-risk needsApproval flips when allowance falls short', () => {
    const fullFill = buildMatchPreview(baseArgs());
    const required = BigInt(fullFill.approvals[0]!.required);

    const sufficient = buildMatchPreview(
      baseArgs({ takerPositionAllowanceWei6: required + 1n }),
    );
    expect(sufficient.approvals[0]?.needsApproval).toBe(false);

    const insufficient = buildMatchPreview(
      baseArgs({ takerPositionAllowanceWei6: required - 1n }),
    );
    expect(insufficient.approvals[0]?.needsApproval).toBe(true);
  });
});

// A reviewer asked that the lazy-vs-existing distinction be answerable
// positively (read one field, act) rather than by inferring from
// absence-of-fields. These assertions pin the wire contract for the
// always-present `creationFee` summary and `tradeAction` tag on both
// modes (existing, lazy, lazy + self-match).
describe('buildMatchPreview — creationFee + tradeAction (agent contract)', () => {
  it('existing mode: creationFee.applies===false, zeros, tradeAction==="trade-only"', () => {
    const p = buildMatchPreview(baseArgs());
    expect(p.tradeAction).toBe('trade-only');
    expect(p.speculation.creationFee).toMatchObject({
      applies: false,
      condition: 'never',
      totalFeeWei6: '0',
      totalFeeUSDC: '0.000000',
      takerShareWei6: '0',
      makerShareWei6: '0',
      viewerShareWei6: '0',
      viewerShareUSDC: '0.000000',
      spender: null,
      spenderLabel: null,
      approvalPurpose: null,
      approvalNeeded: false,
    });
  });

  it('lazy mode: applies===true, condition===if-first-match-at-execution, viewerShare===takerShare on non-self-match', () => {
    const p = buildMatchPreview(
      baseArgs({
        speculation: { mode: 'lazy' },
        speculationCreationTotalFeeWei6: 500_000n,
        takerTreasuryAllowanceWei6: 0n,
      }),
    );
    expect(p.tradeAction).toBe('trade-and-create-speculation');
    expect(p.speculation.creationFee).toMatchObject({
      applies: true,
      condition: 'if-first-match-at-execution',
      totalFeeWei6: '500000',
      totalFeeUSDC: '0.500000',
      takerShareWei6: '250000',
      takerShareUSDC: '0.250000',
      makerShareWei6: '250000',
      makerShareUSDC: '0.250000',
      // Match-preview viewer is the taker.
      viewerShareWei6: '250000',
      viewerShareUSDC: '0.250000',
      spender: TM,
      spenderLabel: 'TreasuryModule',
      approvalPurpose: 'lazy-creation-fee',
      approvalNeeded: true, // 0 allowance < 250000 viewer share
    });
  });

  it('lazy self-match: viewerShare collapses to the FULL fee (review-flagged invariant)', () => {
    const p = buildMatchPreview(
      baseArgs({
        taker: MAKER,
        speculation: { mode: 'lazy' },
        speculationCreationTotalFeeWei6: 500_000n,
        takerTreasuryAllowanceWei6: 0n,
      }),
    );
    expect(p.selfMatch).toBe(true);
    // Role shares stay 50/50 — the on-chain split is unchanged. Only
    // the wallet-centric viewerShare reflects the doubling that comes
    // from one wallet paying both halves of TreasuryModule.processSplitFee.
    expect(p.speculation.creationFee.takerShareWei6).toBe('250000');
    expect(p.speculation.creationFee.makerShareWei6).toBe('250000');
    expect(p.speculation.creationFee.viewerShareWei6).toBe('500000');
    expect(p.speculation.creationFee.viewerShareUSDC).toBe(
      p.speculation.creationFee.totalFeeUSDC,
    );
  });

  it('lazy mode + sufficient taker treasury allowance: approvalNeeded===false', () => {
    const p = buildMatchPreview(
      baseArgs({
        speculation: { mode: 'lazy' },
        speculationCreationTotalFeeWei6: 500_000n,
        takerTreasuryAllowanceWei6: 250_000n, // exactly viewer share
      }),
    );
    expect(p.speculation.creationFee.approvalNeeded).toBe(false);
  });

  it('lazy mode with zero total fee disables the summary (applies===false even on lazy mode)', () => {
    // Future-chain / test-disabled case. `creationFee.applies` reflects
    // "is there an actual fee right now" rather than "is the mode lazy",
    // so an agent's branch is "if applies → approve" without a separate
    // chain-config lookup.
    const p = buildMatchPreview(
      baseArgs({
        speculation: { mode: 'lazy' },
        speculationCreationTotalFeeWei6: 0n,
      }),
    );
    expect(p.tradeAction).toBe('trade-and-create-speculation');
    expect(p.speculation.creationFee.applies).toBe(false);
    expect(p.speculation.creationFee.totalFeeWei6).toBe('0');
    expect(p.speculation.creationFee.approvalNeeded).toBe(false);
  });
});

describe('buildMatchPreview — self-match PositionModule allowance doubling', () => {
  // For a self-match, PositionModule.recordFill performs TWO
  // safeTransferFrom calls against the same wallet — fillMakerRisk
  // and takerRisk. The wallet's PositionModule USDC allowance must
  // cover the SUM. Mirrors the lazy-creation-fee row's existing
  // self-match doubling.
  it('non-self match: commitment-risk required = takerRiskWei6 only', () => {
    // baseArgs: maker risk 1 USDC at oddsTick 250 → fillMakerRisk
    // 1.0 USDC, takerRisk 1.5 USDC.
    const p = buildMatchPreview(baseArgs());
    expect(p.selfMatch).toBe(false);
    const row = p.approvals.find((r) => r.purpose === 'commitment-risk')!;
    expect(BigInt(row.required)).toBe(1_500_000n); // takerRisk only
  });

  it('self-match (existing speculation): commitment-risk required = fillMakerRisk + takerRisk', () => {
    const p = buildMatchPreview(baseArgs({ taker: MAKER }));
    expect(p.selfMatch).toBe(true);
    expect(p.speculation.mode).toBe('existing');
    const row = p.approvals.find((r) => r.purpose === 'commitment-risk')!;
    // fillMakerRisk 1.0 USDC + takerRisk 1.5 USDC = 2.5 USDC.
    expect(BigInt(row.required)).toBe(2_500_000n);
  });

  it('self-match (lazy speculation): commitment-risk required is also doubled', () => {
    // Cross-cuts with the lazy-creation-fee row's full-fee doubling —
    // both rows must double independently, neither covers the other.
    const p = buildMatchPreview(
      baseArgs({
        taker: MAKER,
        speculation: { mode: 'lazy' },
        speculationCreationTotalFeeWei6: 500_000n,
      }),
    );
    expect(p.selfMatch).toBe(true);
    const positionRow = p.approvals.find((r) => r.purpose === 'commitment-risk')!;
    const lazyRow = p.approvals.find((r) => r.purpose === 'lazy-creation-fee')!;
    expect(BigInt(positionRow.required)).toBe(2_500_000n); // PM = fill + taker
    expect(BigInt(lazyRow.required)).toBe(500_000n); // TM = full fee
  });

  it('self-match partial fill: PM required reflects the partial-fill sum, not the maker total', () => {
    // takerDesiredRisk = 0.5 USDC → fillMakerRisk = 0.3333 USDC
    // (rounded down to 0.3330 by the lot-size rule), takerRisk = 0.49995 USDC.
    // Sum = 0.83295 USDC = 832950 wei6.
    const p = buildMatchPreview(
      baseArgs({ taker: MAKER, takerDesiredRiskWei6: 500_000n }),
    );
    const row = p.approvals.find((r) => r.purpose === 'commitment-risk')!;
    const expected =
      BigInt(p.economics.fillMakerRiskWei6) + BigInt(p.economics.takerRiskWei6);
    expect(BigInt(row.required)).toBe(expected);
    // Sanity that the fixture math actually exercises the partial-fill
    // path (otherwise the assertion above is just a tautology).
    expect(p.warnings).toContain('partial-fill');
  });

  it('self-match needsApproval: 1.6 USDC allowance is INSUFFICIENT for the doubled requirement', () => {
    // Reproduction of the live-Polygon failure that motivated this
    // fix. baseArgs takerRisk = 1.5 USDC; takerDesiredRiskWei6 1.6
    // gives fillMakerRisk 1.0 USDC + takerRisk 1.5 USDC = 2.5 USDC
    // total. A 1.6 USDC allowance covers takerRisk in isolation but
    // is < the 2.5 USDC sum → needsApproval must be true.
    const p = buildMatchPreview(
      baseArgs({
        taker: MAKER,
        takerPositionAllowanceWei6: 1_600_000n,
      }),
    );
    const row = p.approvals.find((r) => r.purpose === 'commitment-risk')!;
    expect(row.needsApproval).toBe(true);
    expect(BigInt(row.current)).toBe(1_600_000n);
    expect(BigInt(row.required)).toBe(2_500_000n);
  });
});

describe('buildMatchPreview — maker treasury allowance warning', () => {
  it('lazy + maker treasury allowance < maker share → warning + boolean false', () => {
    const p = buildMatchPreview(
      baseArgs({
        speculation: { mode: 'lazy' },
        speculationCreationTotalFeeWei6: 500_000n,
        makerTreasuryAllowanceWei6: 200_000n, // < 250_000 maker share
      }),
    );
    expect(p.warnings).toContain('maker-treasury-allowance-insufficient');
    expect(p.speculation.lazyCreation?.makerTreasuryAllowanceSufficient).toBe(false);
  });

  it('lazy + maker treasury allowance ≥ maker share → no warning', () => {
    const p = buildMatchPreview(
      baseArgs({
        speculation: { mode: 'lazy' },
        speculationCreationTotalFeeWei6: 500_000n,
        makerTreasuryAllowanceWei6: 250_000n, // exactly equal → sufficient
      }),
    );
    expect(p.warnings).not.toContain('maker-treasury-allowance-insufficient');
    expect(p.speculation.lazyCreation?.makerTreasuryAllowanceSufficient).toBe(true);
  });

  it('selfMatch + lazy + insufficient: warning is suppressed (same wallet covered by approvals row)', () => {
    const p = buildMatchPreview(
      baseArgs({
        taker: MAKER,
        speculation: { mode: 'lazy' },
        speculationCreationTotalFeeWei6: 500_000n,
        makerTreasuryAllowanceWei6: 0n,
      }),
    );
    expect(p.selfMatch).toBe(true);
    expect(p.warnings).not.toContain('maker-treasury-allowance-insufficient');
  });

  it('existing mode never sets the warning', () => {
    const p = buildMatchPreview(
      baseArgs({
        speculation: { mode: 'existing', speculationId: '101' },
        makerTreasuryAllowanceWei6: 0n,
      }),
    );
    expect(p.warnings).not.toContain('maker-treasury-allowance-insufficient');
  });
});

describe('buildMatchPreview — expiry warnings', () => {
  it('expired commitment → expired warning, expiresSoonMinutes null', () => {
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({ expiry: '2020-01-01T00:00:00Z' }),
        nowUnixSec: 1_700_000_000n,
      }),
    );
    expect(p.expiry.expired).toBe(true);
    expect(p.expiry.expiresSoonMinutes).toBeNull();
    expect(p.warnings).toContain('expired');
    expect(p.warnings).not.toContain('expires-soon');
  });

  it('expires within 5min → expires-soon warning + minutes populated', () => {
    // expiry = now + 3 minutes
    const now = 1_700_000_000n;
    const expirySec = now + 180n;
    const expiryISO = new Date(Number(expirySec) * 1000).toISOString();
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({ expiry: expiryISO }),
        nowUnixSec: now,
      }),
    );
    expect(p.expiry.expired).toBe(false);
    expect(p.expiry.expiresSoonMinutes).toBe(3);
    expect(p.warnings).toContain('expires-soon');
  });

  it('far-future expiry → no expiry warnings', () => {
    const p = buildMatchPreview(baseArgs());
    expect(p.expiry.expired).toBe(false);
    expect(p.expiry.expiresSoonMinutes).toBeNull();
    expect(p.warnings).not.toContain('expired');
    expect(p.warnings).not.toContain('expires-soon');
  });
});

describe('buildMatchPreview — snapshots from input commitment', () => {
  it('passes nonceInvalidated through and adds nonce-invalidated warning', () => {
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({ nonceInvalidated: true, isLive: false }),
      }),
    );
    expect(p.nonceInvalidated).toBe(true);
    expect(p.isLive).toBe(false);
    expect(p.warnings).toContain('nonce-invalidated');
  });

  it('full preview carries chainId + verifyingContract for execute-time check', () => {
    const p = buildMatchPreview(baseArgs());
    expect(p.chainId).toBe(137);
    expect(p.verifyingContract).toBe(MM);
    expect(p.commitment.commitmentHash).toBe(HASH);
  });
});

describe('buildMatchPreview — an explicit oversize is REFUSED, never clamped', () => {
  // These lock the JSDoc on MatchArgs.takerDesiredRisk,
  // PrepareMatchArgs.takerDesiredRiskWei6, and
  // CheckFillabilityArgs.takerDesiredRiskWei6, all three of which used to
  // claim the value was "Clamped to `commitment.remainingRiskAmount`". It
  // never was — it throws. That doc-untruth is the plausible root cause of an
  // operator authoring a taker size larger than the maker's remaining quote
  // could support, believing it would be clamped down.
  //
  // If a clamp is ever genuinely added, these tests fail and whoever adds it
  // has to update the docs in the same change. That is the point of them.

  it('throws rather than clamping when the desired risk exceeds remaining', () => {
    // Maker has 1.0 USDC remaining at tick 250 → full take is 1.5 USDC taker
    // risk. Ask for 3.0 USDC, i.e. double what the maker can support.
    expect(() =>
      buildMatchPreview(baseArgs({ takerDesiredRiskWei6: 3_000_000n })),
    ).toThrow(/not in \(0, remaining=1000000\]/);
  });

  it('the refusal is a typed OspexValidationError on takerDesiredRiskWei6', () => {
    try {
      buildMatchPreview(baseArgs({ takerDesiredRiskWei6: 3_000_000n }));
      throw new Error('expected buildMatchPreview to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OspexValidationError);
      expect((err as OspexValidationError).field).toBe('takerDesiredRiskWei6');
      // "Match would revert:" is a PREDICTION from this pure function — no
      // transaction is built, signed, or broadcast, and no gas is spent. (Via
      // `prepareMatch`, read-only API/RPC preflight has already run; only the
      // WRITE path is guaranteed untouched.)
      expect((err as OspexValidationError).message).toMatch(/^Match would revert:/);
    }
  });

  it('pins the exact refusal boundary — sub-lot overshoot is absorbed, beyond it refuses', () => {
    // The refusal is NOT "any value above the full-take size". It fires when
    // the LOT-ROUNDED maker leg exceeds remaining, so an overshoot smaller
    // than one lot's rounding is absorbed and fills at exactly remaining.
    //
    // tick 250 → profitTicks 150, ODDS_SCALE 100, remaining 1_000_000.
    //   fillMakerRisk = floor_to_lot(ceil(desired * 100 / 150))
    // 1_500_148 → 1_000_000 (fits, absorbed)
    // 1_500_149 → 1_000_100 (exceeds remaining → refuse)
    const ok = buildMatchPreview(baseArgs({ takerDesiredRiskWei6: 1_500_148n }));
    expect(BigInt(ok.economics.fillMakerRiskWei6)).toBe(1_000_000n);
    // The taker is billed the real cost of that leg, never their overshoot.
    expect(BigInt(ok.economics.takerRiskWei6)).toBe(1_500_000n);

    expect(() => buildMatchPreview(baseArgs({ takerDesiredRiskWei6: 1_500_149n })))
      .toThrow(/not in \(0, remaining=1000000\]/);
  });

  it('OMITTING the field takes full remaining capacity and cannot trip the refusal', () => {
    // The documented escape hatch: no explicit size → derived from remaining,
    // so it is structurally incapable of exceeding it. Same maker, a remaining
    // amount that an explicit guess would likely overshoot.
    const p = buildMatchPreview(
      baseArgs({ commitment: makeCommitment({ remainingRiskAmount: '333300' }) }),
    );
    expect(BigInt(p.economics.fillMakerRiskWei6)).toBe(333_300n);
    expect(p.warnings).not.toContain('partial-fill');
  });

  it('zero is rejected too', () => {
    expect(() => buildMatchPreview(baseArgs({ takerDesiredRiskWei6: 0n }))).toThrow(
      OspexValidationError,
    );
  });
});

describe('buildMatchPreview — taker-risk round-trip (no lot rule on the taker leg)', () => {
  /**
   * The operator round-trip: run a preview, read back the taker risk it
   * reported, and hand that exact number to a second run. This is how an
   * orchestrator binds an execution to an already-validated preview.
   *
   * It goes through `usdcDecimalToAmountWei6` deliberately — that parse is
   * the step the CLI performs on `--risk-usdc`, and it is the step that
   * used to reject the preview's own output.
   */
  function roundTrip(oddsTick: number, remaining: string, desiredWei6: bigint) {
    const args = (d: bigint) =>
      baseArgs({
        commitment: makeCommitment({
          oddsTick,
          riskAmount: remaining,
          remainingRiskAmount: remaining,
        }),
        takerDesiredRiskWei6: d,
      });
    const first = buildMatchPreview(args(desiredWei6));
    // Feed the REPORTED taker risk back through the CLI's own parser.
    const reparsed = usdcDecimalToAmountWei6(first.economics.takerRiskUSDC);
    const second = buildMatchPreview(args(reparsed));
    return { first, second, reparsed };
  }

  it('is idempotent across a full sweep of odds and sizes (property, not sample)', () => {
    let checked = 0;
    let offGrid = 0;
    let clampBound = 0;
    for (let oddsTick = 101; oddsTick <= 10100; oddsTick += 37) {
      for (const desired of [1n, 37n, 50n, 99n, 100n, 199n, 12_345n, 999_936n, 500_000n]) {
        let r: ReturnType<typeof roundTrip>;
        try {
          r = roundTrip(oddsTick, '1000000', desired);
        } catch (e) {
          // buildMatchPreview refuses fills outside (0, remaining] — an
          // interval bound, unrelated to the lot grid. Skip those. Assert
          // the REASON too: OspexValidationError is also what a lot-size
          // regression would throw, so a bare instanceof check would let
          // one hide here as a skipped case.
          expect(e).toBeInstanceOf(OspexValidationError);
          expect((e as Error).message).not.toMatch(/lot size/);
          continue;
        }
        expect(r.second.economics.fillMakerRiskWei6).toBe(r.first.economics.fillMakerRiskWei6);
        expect(r.second.economics.takerRiskWei6).toBe(r.first.economics.takerRiskWei6);

        // ABSOLUTE anchor, not just self-consistency: pin the reported taker
        // risk to the contract's own formula, clamp included. Idempotence
        // alone would still hold if the SDK's mirror of `matchCommitment`
        // drifted, and `approvals[].required` on a match IS this number — an
        // over-report would prompt for a larger allowance than the contract
        // charges.
        const profitTicks = BigInt(oddsTick) - 100n;
        const fill = BigInt(r.first.economics.fillMakerRiskWei6);
        const unclamped = (fill * profitTicks) / 100n;
        const expected = unclamped > desired ? desired : unclamped;
        expect(BigInt(r.first.economics.takerRiskWei6)).toBe(expected);
        expect(BigInt(r.first.economics.takerRiskWei6)).toBeLessThanOrEqual(desired);
        if (unclamped > desired) clampBound += 1;

        if (r.reparsed % 100n !== 0n) offGrid += 1;
        checked += 1;
      }
    }
    // Meaningful coverage, and a real share of it is off the lot grid —
    // i.e. these round-trips were impossible before the parser split.
    expect(checked).toBeGreaterThan(500);
    expect(offGrid).toBeGreaterThan(100);
    // The clamp branch must actually be exercised, or `expected` above
    // degenerates into the unclamped formula and pins only half the rule.
    expect(clampBound).toBeGreaterThan(0);
  });

  it('emits and re-accepts the off-grid taker risk quoted in the issue (999936)', () => {
    // oddsTick 244 → profitTicks 144. A fill of 694400 (lot-aligned) prices
    // the taker at 694400 * 144 / 100 = 999936 — the value observed in the
    // wild, 36 wei6 off the lot grid. The preview PRINTS it; before the
    // parser split, handing it straight back was refused.
    const r = roundTrip(244, '1000000', 999_936n);
    expect(r.first.economics.takerRiskUSDC).toBe('0.999936');
    expect(r.first.economics.fillMakerRiskWei6).toBe('694400');
    expect(r.reparsed).toBe(999_936n);
    expect(r.reparsed % 100n).toBe(36n); // genuinely off-grid
    expect(r.second.economics.fillMakerRiskWei6).toBe(r.first.economics.fillMakerRiskWei6);
  });

  it('is idempotent even when the reported taker risk lands back ON the grid', () => {
    // Same desired value at oddsTick 250 prices to 999900 — lot-aligned by
    // coincidence. Idempotence must not depend on which side of the grid
    // the number happens to fall.
    const r = roundTrip(250, '1000000', 999_936n);
    expect(r.reparsed).toBe(999_900n);
    expect(r.reparsed % 100n).toBe(0n);
    expect(r.second.economics.fillMakerRiskWei6).toBe(r.first.economics.fillMakerRiskWei6);
  });

  it('round-trips below decimal odds 2.00, where NO lot-aligned equivalent exists', () => {
    // oddsTick 150 == decimal 1.50 → profitTicks 50. The taker amounts
    // that produce a given fill span a window only `profitTicks` wide, so
    // below 2.00 that window can contain no multiple of 100 at all.
    const r = roundTrip(150, '1000000', 50n);
    expect(r.first.economics.fillMakerRiskWei6).toBe('100');
    expect(r.reparsed).toBe(50n);
    expect(r.reparsed % 100n).toBe(50n); // off-grid
    expect(r.second.economics.fillMakerRiskWei6).toBe('100');

    // Prove the unreachability rather than asserting it: sweep every taker
    // amount that yields this fill and confirm none is lot-aligned.
    const producingThisFill: bigint[] = [];
    for (let t = 1n; t <= 400n; t += 1n) {
      try {
        const p = buildMatchPreview(
          baseArgs({
            commitment: makeCommitment({ oddsTick: 150 }),
            takerDesiredRiskWei6: t,
          }),
        );
        if (p.economics.fillMakerRiskWei6 === '100') producingThisFill.push(t);
      } catch {
        /* outside (0, remaining] */
      }
    }
    expect(producingThisFill.length).toBeGreaterThan(0);
    expect(producingThisFill.filter((t) => t % 100n === 0n)).toEqual([]);
  });

  it('the minimum fill at oddsTick 101 is reachable ONLY at 1 wei6', () => {
    // profitTicks = 1 → the window for fill=100 is exactly [1, 1]. Under a
    // 100-wei6 lot rule on the taker leg this fill is inexpressible.
    const p = buildMatchPreview(
      baseArgs({ commitment: makeCommitment({ oddsTick: 101 }), takerDesiredRiskWei6: 1n }),
    );
    expect(p.economics.fillMakerRiskWei6).toBe('100');
    expect(p.economics.takerRiskUSDC).toBe('0.000001');
    expect(usdcDecimalToAmountWei6(p.economics.takerRiskUSDC)).toBe(1n);
  });
});

describe('buildMatchPreview — zero USDC strings are emitted but do NOT parse', () => {
  it('an ordinary existing-speculation preview emits "0.000000" the parser refuses', () => {
    // This is the agent-contract claim, checked against the artifact rather
    // than asserted in prose: `wei6ToDecimalUSDC` is total, the parsers are
    // not, and a routine preview emits zero-valued USDC strings. Consumers
    // are directed at the paired `*Wei6` field with BigInt() for this reason.
    const p = buildMatchPreview(baseArgs()); // speculation.mode === 'existing'
    const fee = p.speculation.creationFee;

    expect(fee.applies).toBe(false);
    for (const usdc of [
      fee.viewerShareUSDC,
      fee.totalFeeUSDC,
      fee.takerShareUSDC,
      fee.makerShareUSDC,
    ]) {
      expect(usdc).toBe('0.000000');
      expect(() => usdcDecimalToAmountWei6(usdc)).toThrow(/must be positive/);
    }

    // The path the contract tells agents to use works for exactly these.
    expect(BigInt(fee.viewerShareWei6)).toBe(0n);
    expect(BigInt(fee.totalFeeWei6)).toBe(0n);
  });

  it('the paired *Wei6 field is exact for the non-zero economics too', () => {
    // Negative control: the BigInt path is not a special case for zero — it
    // is the general rule, and it agrees with the parser wherever the parser
    // is defined.
    const p = buildMatchPreview(baseArgs({ takerDesiredRiskWei6: 150n }));
    expect(BigInt(p.economics.takerRiskWei6)).toBe(
      usdcDecimalToAmountWei6(p.economics.takerRiskUSDC),
    );
    expect(BigInt(p.economics.fillMakerRiskWei6)).toBe(
      usdcDecimalToAmountWei6(p.economics.fillMakerRiskUSDC),
    );
  });
});

describe('buildMatchPreview — the emitted USDC-string domain vs. what parses', () => {
  /**
   * Walks a real preview and classifies EVERY key ending in `USDC`. This
   * guards the class rather than the handful of fields anyone thought to
   * enumerate: a future zero- or negative-valued USDC field is caught here
   * without the test being updated.
   *
   * The public JSDoc on `MatchPreview` / `PerspectiveAmount` /
   * `PreviewOutcome.payoutUSDC` promises exactly this shape — decode via
   * the paired `*Wei6` field, because the parsers take positive input only.
   */
  type Found = { path: string; value: string };

  function collectUsdcStrings(node: unknown, path = '$', out: Found[] = []): Found[] {
    if (node === null || node === undefined) return out;
    if (Array.isArray(node)) {
      node.forEach((v, i) => collectUsdcStrings(v, `${path}[${i}]`, out));
      return out;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        // BOTH naming conventions: `xUSDC` at the top level, and the
        // `{ wei6, usdc }` pair inside you/counterparty PerspectiveAmounts.
        // An earlier version of this walker was case-sensitive on `USDC` and
        // silently skipped every PerspectiveAmount.
        if ((k.endsWith('USDC') || k === 'usdc') && typeof v === 'string') {
          out.push({ path: `${path}.${k}`, value: v });
        }
        else collectUsdcStrings(v, `${path}.${k}`, out);
      }
    }
    return out;
  }

  function toWei6(usdc: string): bigint {
    const neg = usdc.startsWith('-');
    const [int, frac] = (neg ? usdc.slice(1) : usdc).split('.');
    const mag = BigInt(int!) * 1_000_000n + BigInt(frac!);
    return neg ? -mag : mag;
  }

  it('every emitted *USDC string parses if and only if it is positive', () => {
    const previews = [
      buildMatchPreview(baseArgs()), // existing speculation -> zero fee strings
      buildMatchPreview(baseArgs({ speculation: { mode: 'lazy' } })), // lazy -> non-zero fee
      buildMatchPreview(baseArgs({ takerDesiredRiskWei6: 150n })), // off-grid taker risk
      buildMatchPreview(
        baseArgs({ commitment: makeCommitment({ marketType: 'spread', lineTicks: -35 }) }),
      ), // spread -> a push row too
    ];

    let positive = 0;
    let zero = 0;
    let negative = 0;

    for (const p of previews) {
      for (const { path, value } of collectUsdcStrings(p)) {
        // Every one is canonical 6dp, optionally signed.
        expect(value, path).toMatch(/^-?\d+\.\d{6}$/);
        const n = toWei6(value);
        if (n > 0n) {
          expect(usdcDecimalToAmountWei6(value), path).toBe(n);
          positive += 1;
        } else {
          expect(() => usdcDecimalToAmountWei6(value), path).toThrow(/must be positive/);
          if (n === 0n) zero += 1;
          else negative += 1;
        }
      }
    }

    // Non-vacuous: all three classes genuinely occur in real output, so the
    // "positive only" scoping in the public JSDoc is load-bearing, not
    // defensive boilerplate.
    expect(positive).toBeGreaterThan(0);
    expect(zero).toBeGreaterThan(0);
    expect(negative).toBeGreaterThan(0);
  });

  it('a lose row really is the negated risk, and it is refused', () => {
    const p = buildMatchPreview(baseArgs());
    const lose = p.outcomes?.find((o) => o.result === 'lose');
    expect(lose).toBeDefined();
    expect(lose!.payoutUSDC.startsWith('-')).toBe(true);
    expect(lose!.payoutUSDC).toBe(`-${p.economics.takerRiskUSDC}`);
    expect(() => usdcDecimalToAmountWei6(lose!.payoutUSDC)).toThrow(/must be positive/);
  });
});

describe('buildMatchPreview — which USDC strings carry a paired integer', () => {
  /**
   * The public JSDoc and AGENT_CONTRACT tell agents to decode USDC amounts
   * via the paired `*Wei6` field. That rule has exactly three exceptions,
   * and this test PINS THE EXCEPTION SET so a fourth cannot appear without
   * failing here and forcing the docs to be updated. Naming a specific
   * exception in prose is what put this claim wrong twice.
   */
  const UNPAIRED = [
    '$.economics.takerProfitOnWinUSDC',
    '$.economics.takerReturnOnWinUSDC',
    '$.outcomes[*].payoutUSDC',
  ];

  function classify(node: unknown, path: string, paired: Set<string>, unpaired: Set<string>): void {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const v of node) classify(v, `${path}[*]`, paired, unpaired);
      return;
    }
    if (typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    const keys = Object.keys(rec);
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === 'string' && (k.endsWith('USDC') || k === 'usdc')) {
        const twin = k === 'usdc' ? 'wei6' : `${k.slice(0, -4)}Wei6`;
        const has = keys.includes(twin) && typeof rec[twin] === 'string';
        (has ? paired : unpaired).add(`${path}.${k}`);
      } else {
        classify(v, `${path}.${k}`, paired, unpaired);
      }
    }
  }

  it('the set of USDC fields WITHOUT a paired integer is exactly the documented three', () => {
    const paired = new Set<string>();
    const unpaired = new Set<string>();
    for (const args of [
      baseArgs(),
      baseArgs({ speculation: { mode: 'lazy' } }),
      baseArgs({ commitment: makeCommitment({ marketType: 'spread', lineTicks: -35 }) }),
      baseArgs({ commitment: makeCommitment({ marketType: 'total', lineTicks: 85 }) }),
      baseArgs({ takerDesiredRiskWei6: 150n }),
    ]) {
      classify(buildMatchPreview(args), '$', paired, unpaired);
    }

    expect([...unpaired].sort()).toEqual([...UNPAIRED].sort());
    // Non-vacuous: the paired majority is real, so the general rule is worth
    // stating and the exception list is genuinely an exception list.
    expect(paired.size).toBeGreaterThan(10);
    // And the `{ wei6, usdc }` convention is in the paired set, not skipped.
    expect([...paired]).toContain('$.you.risk.usdc');
  });

  it('the two unpaired ECONOMICS fields are positive and derivable from paired ones', () => {
    // The docs tell agents to derive these rather than parse them; that
    // advice is only safe if the derivation is exact. Sweep, do not sample.
    for (let oddsTick = 101; oddsTick <= 3000; oddsTick += 23) {
      const p = buildMatchPreview(baseArgs({ commitment: makeCommitment({ oddsTick }) }));
      const fill = BigInt(p.economics.fillMakerRiskWei6);
      const risk = BigInt(p.economics.takerRiskWei6);

      // profit-on-win === fillMakerRisk (zero-vig), return === risk + profit.
      expect(usdcDecimalToAmountWei6(p.economics.takerProfitOnWinUSDC)).toBe(fill);
      expect(usdcDecimalToAmountWei6(p.economics.takerReturnOnWinUSDC)).toBe(risk + fill);
      // Positive, hence parseable — unlike payoutUSDC.
      expect(p.economics.takerProfitOnWinUSDC.startsWith('-')).toBe(false);
      expect(p.economics.takerReturnOnWinUSDC.startsWith('-')).toBe(false);
    }
  });
});
