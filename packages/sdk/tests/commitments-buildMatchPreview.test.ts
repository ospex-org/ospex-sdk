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
import {
  buildMatchPreview,
} from '../src/commitments/buildMatchPreview.js';
import type {
  BuildMatchPreviewArgs,
} from '../src/types/matchPreview.js';
import type { Commitment } from '../src/types/commitment.js';

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
