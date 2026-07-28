/**
 * Tests for the agent-facing `you` / `counterparty` blocks on
 * `SubmitPreview` plus the `computeSubmitYouView` backfill helper.
 *
 * `SubmitPreview` already shipped with `outcomes[]` from the maker
 * perspective, so the new wiring adds `you` and `counterparty` only.
 * The hypothetical counterparty has `address: null` since no taker has
 * signed yet.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSubmitPreview,
  type BuildSubmitPreviewArgs,
} from '../src/commitments/buildSubmitPreview.js';
import { computeSubmitYouView } from '../src/commitments/youView.js';

const MAKER = '0x'.padEnd(42, '0') as `0x${string}`;
const MM = '0x'.padEnd(42, '1') as `0x${string}`;
const PM = '0x'.padEnd(42, '2') as `0x${string}`;
const SCORER = '0x'.padEnd(42, '3') as `0x${string}`;

const baseArgs = (
  overrides: Partial<BuildSubmitPreviewArgs> = {},
): BuildSubmitPreviewArgs => ({
  contestId: 42n,
  awayTeam: 'Los Angeles Lakers',
  homeTeam: 'Denver Nuggets',
  awayTeamId: 'lakers-uuid',
  homeTeamId: 'nuggets-uuid',
  sport: 'nba',
  matchTime: '2099-05-08T02:00:00Z',
  market: 'moneyline',
  scorer: SCORER,
  lineTicks: 0,
  speculation: { mode: 'lazy', speculationId: null, speculationKey: '0xabcd' },
  resolvedSide: {
    positionType: 0,
    resolvedLabel: 'Los Angeles Lakers',
    role: 'away',
    resolutionSource: 'exact',
  },
  sideInput: 'lakers',
  oddsTick: 250,
  riskWei6: 1_000_000n,
  maker: MAKER,
  chainId: 137,
  matchingModuleAddress: MM,
  expirySec: 1778281200n,
  expirySource: 'default-match-time' as const,
  matchTimeSec: 1778281200n,
  makerCreationFeeWei6: 250_000n,
  treasuryModuleAddress: '0x'.padEnd(42, '4') as `0x${string}`,
  treasuryUsdcCurrentAllowanceWei6: 0n,
  nonce: 17_000_000_001n,
  positionModuleAddress: PM,
  usdcCurrentAllowanceWei6: 0n,
  ...overrides,
});

describe('SubmitPreview.you', () => {
  it('maker on away (Lakers) at +150: you backs Lakers; counterparty hypothetical taker', () => {
    // 1 USDC at 2.50 (+150). Maker's profit = 1.5; counterparty risk
    // would be 1.5; counterparty odds = 100*250/150 = 166.67 → 167
    // (decimal 1.67).
    const p = buildSubmitPreview(baseArgs());
    expect(p.you).toBeDefined();
    expect(p.you?.role).toBe('maker');
    expect(p.you?.address).toBe(MAKER);
    expect(p.you?.backing).toBe('Los Angeles Lakers');
    expect(p.you?.odds).toEqual({
      decimal: '2.50',
      american: '+150',
      oddsTick: 250,
    });
    expect(p.you?.risk).toEqual({ wei6: '1000000', usdc: '1.000000' });
    expect(p.you?.profit).toEqual({ wei6: '1500000', usdc: '1.500000' });
    expect(p.you?.totalReturn).toEqual({
      wei6: '2500000',
      usdc: '2.500000',
    });
  });

  it('counterparty mirrors a hypothetical full-fill taker with null address', () => {
    const p = buildSubmitPreview(baseArgs());
    expect(p.counterparty?.role).toBe('taker');
    expect(p.counterparty?.address).toBeNull();
    expect(p.counterparty?.backing).toBe('Denver Nuggets');
    expect(p.counterparty?.odds.oddsTick).toBe(167);
    expect(p.counterparty?.odds.decimal).toBe('1.67');
    // Counterparty risk = maker's profit (zero-vig).
    expect(p.counterparty?.risk).toEqual({
      wei6: '1500000',
      usdc: '1.500000',
    });
    expect(p.counterparty?.profit).toEqual({
      wei6: '1000000',
      usdc: '1.000000',
    });
  });

  it('maker on home (Nuggets) flips counterparty to away (Lakers)', () => {
    const p = buildSubmitPreview(
      baseArgs({
        resolvedSide: {
          positionType: 1,
          resolvedLabel: 'Denver Nuggets',
          role: 'home',
          resolutionSource: 'exact',
        },
      }),
    );
    expect(p.you?.backing).toBe('Denver Nuggets');
    expect(p.counterparty?.backing).toBe('Los Angeles Lakers');
  });

  it('spread maker on away -3.5: counterparty on home +3.5', () => {
    const p = buildSubmitPreview(
      baseArgs({
        market: 'spread',
        lineTicks: -35,
        resolvedSide: {
          positionType: 0,
          resolvedLabel: 'Los Angeles Lakers',
          role: 'away',
          resolutionSource: 'exact',
        },
      }),
    );
    expect(p.you?.backing).toBe('Los Angeles Lakers -3.5');
    expect(p.counterparty?.backing).toBe('Denver Nuggets +3.5');
  });

  it('total maker over: counterparty under at same magnitude', () => {
    const p = buildSubmitPreview(
      baseArgs({
        market: 'total',
        lineTicks: 85,
        resolvedSide: {
          positionType: 0,
          resolvedLabel: 'over',
          role: 'over',
          resolutionSource: 'over',
        },
      }),
    );
    expect(p.you?.backing).toBe('Over 8.5');
    expect(p.counterparty?.backing).toBe('Under 8.5');
  });
});

describe('SubmitPreview.outcomes — still maker-perspective after refactor', () => {
  // The refactor moved outcome generation to the shared
  // `buildPreviewOutcomes` helper; this guards against regression.
  it('moneyline: two rows naming the maker side and the other team', () => {
    const p = buildSubmitPreview(baseArgs());
    expect(p.outcomes).toHaveLength(2);
    expect(p.outcomes[0]?.condition).toBe('Los Angeles Lakers wins');
    expect(p.outcomes[0]?.result).toBe('win');
    expect(p.outcomes[1]?.condition).toBe('Denver Nuggets wins');
    expect(p.outcomes[1]?.result).toBe('lose');
  });

  it('total integer push: three rows including exactly-N condition', () => {
    const p = buildSubmitPreview(
      baseArgs({
        market: 'total',
        lineTicks: 80,
        resolvedSide: {
          positionType: 0,
          resolvedLabel: 'over',
          role: 'over',
          resolutionSource: 'over',
        },
      }),
    );
    expect(p.outcomes).toHaveLength(3);
    expect(p.outcomes[1]?.result).toBe('push');
    expect(p.outcomes[1]?.condition).toContain('exactly 8');
  });
});

describe('computeSubmitYouView', () => {
  it('returns preview.you / preview.counterparty directly when present', () => {
    const p = buildSubmitPreview(baseArgs());
    const view = computeSubmitYouView(p);
    expect(view.you).toBe(p.you);
    expect(view.counterparty).toBe(p.counterparty);
    expect(view.outcomes).toBe(p.outcomes);
  });

  it('backfills you / counterparty from legacy fields when absent', () => {
    const p = buildSubmitPreview(baseArgs());
    const legacy = { ...p, you: undefined, counterparty: undefined };
    const view = computeSubmitYouView(legacy);
    expect(view.you).toEqual(p.you);
    expect(view.counterparty).toEqual(p.counterparty);
    expect(view.outcomes).toBe(p.outcomes);
  });

  it('backfill agrees across markets', () => {
    const fixtures: BuildSubmitPreviewArgs[] = [
      baseArgs(),
      baseArgs({
        market: 'spread',
        lineTicks: -35,
        resolvedSide: {
          positionType: 0,
          resolvedLabel: 'Los Angeles Lakers',
          role: 'away',
          resolutionSource: 'exact',
        },
      }),
      baseArgs({
        market: 'total',
        lineTicks: 85,
        resolvedSide: {
          positionType: 1,
          resolvedLabel: 'under',
          role: 'under',
          resolutionSource: 'under',
        },
      }),
    ];
    for (const args of fixtures) {
      const built = buildSubmitPreview(args);
      const legacy = { ...built, you: undefined, counterparty: undefined };
      const view = computeSubmitYouView(legacy);
      expect(view.you).toEqual(built.you);
      expect(view.counterparty).toEqual(built.counterparty);
    }
  });
});

describe('computeSubmitYouView — counterpartyRiskUSDC cross-check', () => {
  /**
   * The backfill re-derives the counterparty's risk with integer math and
   * cross-checks it against the decimal string the envelope published.
   *
   * The counterparty on a SubmitPreview is a hypothetical taker, so that
   * value carries no lot rule and is routinely sub-lot. Parsing it with
   * the maker-risk parser threw on exactly those cases, and the catch
   * added to absorb the throw also swallowed the drift error — leaving a
   * check that could not fail. Both halves are pinned below: the honest
   * sub-lot case must pass, and real drift must throw.
   */
  const legacyOf = (p: ReturnType<typeof buildSubmitPreview>) => ({
    ...p,
    you: undefined,
    counterparty: undefined,
  });

  it('NEGATIVE CONTROL: an honest sub-lot counterparty risk is accepted', () => {
    // riskWei6 100n at oddsTick 101 → profit 1 wei6 → "0.000001".
    // Off the 100-wei6 grid, and entirely legitimate.
    const p = buildSubmitPreview(baseArgs({ riskWei6: 100n, oddsTick: 101 }));
    expect(p.economics.counterpartyRiskUSDC).toBe('0.000001');
    const view = computeSubmitYouView(legacyOf(p));
    expect(view.counterparty.risk.wei6).toBe('1');
    expect(view.you.risk.wei6).toBe('100');
  });

  it('throws when counterpartyRiskUSDC actually disagrees with the integer math', () => {
    const p = buildSubmitPreview(baseArgs());
    const drifted = {
      ...legacyOf(p),
      economics: { ...p.economics, counterpartyRiskUSDC: '999.000000' },
    };
    expect(() => computeSubmitYouView(drifted)).toThrow(/disagrees with the BigInt-derived value/);
  });

  it('throws on a malformed counterpartyRiskUSDC rather than ignoring it', () => {
    const p = buildSubmitPreview(baseArgs());
    const broken = {
      ...legacyOf(p),
      economics: { ...p.economics, counterpartyRiskUSDC: 'not-a-number' },
    };
    // Match the PARSE message specifically: a bare .toThrow() would also be
    // satisfied by the drift error, so a parser that silently returned a
    // wrong bigint would still pass.
    expect(() => computeSubmitYouView(broken)).toThrow(/Plain decimal strings only/);
  });

  it('sweeps risk x odds: every honest preview backfills, many of them sub-lot', () => {
    let subLot = 0;
    let total = 0;
    for (const riskWei6 of [100n, 300n, 1_000n, 12_300n, 1_000_000n]) {
      for (const oddsTick of [101, 105, 137, 150, 191, 200, 244, 250, 999, 10_100]) {
        const p = buildSubmitPreview(baseArgs({ riskWei6, oddsTick }));
        const counterpartyWei6 = (riskWei6 * BigInt(oddsTick - 100)) / 100n;
        expect(() => computeSubmitYouView(legacyOf(p))).not.toThrow();
        if (counterpartyWei6 % 100n !== 0n) subLot += 1;
        total += 1;
      }
    }
    // If this share were zero the negative control above would prove nothing.
    expect(total).toBe(50);
    expect(subLot).toBeGreaterThan(15);
  });
});
