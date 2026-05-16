/**
 * Unit tests for the shared perspective-view helpers
 * (`packages/sdk/src/commitments/perspectiveView.ts`). These helpers
 * power the new `you` / `counterparty` blocks on `MatchPreview` /
 * `SubmitPreview` plus the existing `commitments list` taker-view, so
 * the tests anchor the math + label conventions before either builder
 * starts depending on them.
 *
 * The math is mirrored from `buildMatchPreview` and `takerView`; the
 * intent here is to lock the contract on the pure helpers so the
 * downstream builders can be verified by composition rather than by
 * re-deriving everything from scratch.
 */

import { describe, expect, it } from 'vitest';
import { OspexValidationError } from '../src/errors.js';
import {
  buildBackingLabel,
  buildPerspectiveAmount,
  buildPerspectiveOdds,
  buildPreviewCounterparty,
  buildPreviewYou,
  inverseOddsTick,
  invertSideRole,
  sideRoleFor,
} from '../src/commitments/perspectiveView.js';

const AWAY = 'San Francisco Giants';
const HOME = 'Los Angeles Dodgers';
const MAKER_ADDR = '0x5316fa54c170d1927f30d1a497ac9e85e3826a9b' as const;
const TAKER_ADDR = '0x1234567890abcdef1234567890abcdef12345678' as const;

describe('inverseOddsTick', () => {
  it('inverts +154 (decimal 2.54) to -154 (decimal 1.65)', () => {
    // 100 × 254 / (254 − 100) = 25400 / 154 = 164.93… → 165 (decimal 1.65)
    expect(inverseOddsTick(254)).toBe(165);
  });

  it('inverts +100 boundary (decimal 2.00) to itself', () => {
    // 100 × 200 / 100 = 200. Even money is self-symmetric.
    expect(inverseOddsTick(200)).toBe(200);
  });

  it('inverts long-shot decimal 5.00 to decimal 1.25', () => {
    // 100 × 500 / 400 = 125 (decimal 1.25)
    expect(inverseOddsTick(500)).toBe(125);
  });

  it('throws on oddsTick ≤ protocol minimum 101', () => {
    expect(() => inverseOddsTick(100)).toThrow(OspexValidationError);
    expect(() => inverseOddsTick(0)).toThrow(OspexValidationError);
  });
});

describe('sideRoleFor / invertSideRole', () => {
  it('maps moneyline / spread positionType to away/home', () => {
    expect(sideRoleFor('moneyline', 0)).toBe('away');
    expect(sideRoleFor('moneyline', 1)).toBe('home');
    expect(sideRoleFor('spread', 0)).toBe('away');
    expect(sideRoleFor('spread', 1)).toBe('home');
  });

  it('maps total positionType to over/under', () => {
    expect(sideRoleFor('total', 0)).toBe('over');
    expect(sideRoleFor('total', 1)).toBe('under');
  });

  it('inverts each side role to its counterpart', () => {
    expect(invertSideRole('away')).toBe('home');
    expect(invertSideRole('home')).toBe('away');
    expect(invertSideRole('over')).toBe('under');
    expect(invertSideRole('under')).toBe('over');
  });
});

describe('buildBackingLabel', () => {
  it('moneyline → bare team name only', () => {
    expect(
      buildBackingLabel({
        market: 'moneyline',
        sideRole: 'away',
        lineTicks: 0,
        awayTeam: AWAY,
        homeTeam: HOME,
      }),
    ).toBe(AWAY);
    expect(
      buildBackingLabel({
        market: 'moneyline',
        sideRole: 'home',
        lineTicks: 0,
        awayTeam: AWAY,
        homeTeam: HOME,
      }),
    ).toBe(HOME);
  });

  it('total → "Over X.X" / "Under X.X" with absolute line', () => {
    expect(
      buildBackingLabel({
        market: 'total',
        sideRole: 'over',
        lineTicks: 75,
        awayTeam: AWAY,
        homeTeam: HOME,
      }),
    ).toBe('Over 7.5');
    expect(
      buildBackingLabel({
        market: 'total',
        sideRole: 'under',
        lineTicks: 80,
        awayTeam: AWAY,
        homeTeam: HOME,
      }),
    ).toBe('Under 8.0');
  });

  it('total handles negative lineTicks via absolute value', () => {
    expect(
      buildBackingLabel({
        market: 'total',
        sideRole: 'under',
        lineTicks: -75,
        awayTeam: AWAY,
        homeTeam: HOME,
      }),
    ).toBe('Under 7.5');
  });

  it('spread away-side: lineTicks rendered as-is with sign', () => {
    // Stored lineTicks=+15 (away +1.5 / home -1.5). Away perspective.
    expect(
      buildBackingLabel({
        market: 'spread',
        sideRole: 'away',
        lineTicks: 15,
        awayTeam: AWAY,
        homeTeam: HOME,
      }),
    ).toBe(`${AWAY} +1.5`);
  });

  it('spread home-side: lineTicks flipped (home perspective)', () => {
    // Same stored away-line +15 → home line is -15 → -1.5.
    expect(
      buildBackingLabel({
        market: 'spread',
        sideRole: 'home',
        lineTicks: 15,
        awayTeam: AWAY,
        homeTeam: HOME,
      }),
    ).toBe(`${HOME} -1.5`);
  });

  it('spread negative away-line: away favored', () => {
    // Stored lineTicks=-30 (away -3 / home +3). Away is favored.
    expect(
      buildBackingLabel({
        market: 'spread',
        sideRole: 'away',
        lineTicks: -30,
        awayTeam: AWAY,
        homeTeam: HOME,
      }),
    ).toBe(`${AWAY} -3.0`);
    expect(
      buildBackingLabel({
        market: 'spread',
        sideRole: 'home',
        lineTicks: -30,
        awayTeam: AWAY,
        homeTeam: HOME,
      }),
    ).toBe(`${HOME} +3.0`);
  });

  it("spread pick'em (lineTicks=0) shows +0.0 on both sides", () => {
    expect(
      buildBackingLabel({
        market: 'spread',
        sideRole: 'away',
        lineTicks: 0,
        awayTeam: AWAY,
        homeTeam: HOME,
      }),
    ).toBe(`${AWAY} +0.0`);
  });
});

describe('buildPerspectiveOdds', () => {
  it('formats a single tick into the triple', () => {
    expect(buildPerspectiveOdds(254)).toEqual({
      decimal: '2.54',
      american: '+154',
      oddsTick: 254,
    });
    expect(buildPerspectiveOdds(165)).toEqual({
      decimal: '1.65',
      american: '-154',
      oddsTick: 165,
    });
    expect(buildPerspectiveOdds(200)).toEqual({
      decimal: '2.00',
      american: '+100',
      oddsTick: 200,
    });
  });
});

describe('buildPerspectiveAmount', () => {
  it('renders wei6 BigInt as 6dp USDC + decimal-string wei6', () => {
    expect(buildPerspectiveAmount(4_999_918n)).toEqual({
      wei6: '4999918',
      usdc: '4.999918',
    });
    expect(buildPerspectiveAmount(5_000_000n)).toEqual({
      wei6: '5000000',
      usdc: '5.000000',
    });
    expect(buildPerspectiveAmount(0n)).toEqual({
      wei6: '0',
      usdc: '0.000000',
    });
  });
});

describe('buildPreviewYou', () => {
  it('moneyline taker: assembles a complete PreviewYou with inverted odds', () => {
    // Maker upper (Giants) at +154 (oddsTick 254), 5 USDC risk fully
    // remaining. Taker takes the Dodgers side at 1.65 / -154, risks
    // $7.70 to win $5.00.
    const view = buildPreviewYou({
      role: 'taker',
      address: TAKER_ADDR,
      market: 'moneyline',
      positionType: 1, // taker is on the home side
      lineTicks: 0,
      oddsTick: 165, // already inverted
      riskWei6: 7_700_000n,
      profitWei6: 5_000_000n,
      awayTeam: AWAY,
      homeTeam: HOME,
    });
    expect(view).toEqual({
      role: 'taker',
      address: TAKER_ADDR,
      backing: HOME,
      odds: { decimal: '1.65', american: '-154', oddsTick: 165 },
      risk: { wei6: '7700000', usdc: '7.700000' },
      profit: { wei6: '5000000', usdc: '5.000000' },
      totalReturn: { wei6: '12700000', usdc: '12.700000' },
    });
  });

  it('moneyline maker: same shape, role=maker, non-inverted odds', () => {
    const view = buildPreviewYou({
      role: 'maker',
      address: MAKER_ADDR,
      market: 'moneyline',
      positionType: 0,
      lineTicks: 0,
      oddsTick: 254,
      riskWei6: 5_000_000n,
      profitWei6: 7_700_000n,
      awayTeam: AWAY,
      homeTeam: HOME,
    });
    expect(view.role).toBe('maker');
    expect(view.address).toBe(MAKER_ADDR);
    expect(view.backing).toBe(AWAY);
    expect(view.odds).toEqual({ decimal: '2.54', american: '+154', oddsTick: 254 });
    expect(view.totalReturn).toEqual({ wei6: '12700000', usdc: '12.700000' });
  });

  it('spread taker: backing string flips with positionType', () => {
    // Maker home with stored away-line=+15. Taker upper (away). Taker
    // backs Giants at +1.5.
    const view = buildPreviewYou({
      role: 'taker',
      address: TAKER_ADDR,
      market: 'spread',
      positionType: 0, // away
      lineTicks: 15,
      oddsTick: 191,
      riskWei6: 1_000_000n,
      profitWei6: 1_098_900n,
      awayTeam: AWAY,
      homeTeam: HOME,
    });
    expect(view.backing).toBe(`${AWAY} +1.5`);
  });

  it('total taker: Over/Under label flips with positionType', () => {
    const over = buildPreviewYou({
      role: 'taker',
      address: TAKER_ADDR,
      market: 'total',
      positionType: 0, // over
      lineTicks: 75,
      oddsTick: 200,
      riskWei6: 1_000_000n,
      profitWei6: 1_000_000n,
      awayTeam: AWAY,
      homeTeam: HOME,
    });
    expect(over.backing).toBe('Over 7.5');

    const under = buildPreviewYou({
      role: 'taker',
      address: TAKER_ADDR,
      market: 'total',
      positionType: 1, // under
      lineTicks: 75,
      oddsTick: 200,
      riskWei6: 1_000_000n,
      profitWei6: 1_000_000n,
      awayTeam: AWAY,
      homeTeam: HOME,
    });
    expect(under.backing).toBe('Under 7.5');
  });
});

describe('buildPreviewCounterparty', () => {
  it('match (submit triggered by counterparty match): address is known', () => {
    const view = buildPreviewCounterparty({
      role: 'maker',
      address: MAKER_ADDR,
      market: 'moneyline',
      positionType: 0,
      lineTicks: 0,
      oddsTick: 254,
      riskWei6: 5_000_000n,
      profitWei6: 7_700_000n,
      awayTeam: AWAY,
      homeTeam: HOME,
    });
    expect(view.address).toBe(MAKER_ADDR);
    expect(view.backing).toBe(AWAY);
  });

  it('submit hypothetical counterparty: address is null', () => {
    const view = buildPreviewCounterparty({
      role: 'taker',
      address: null,
      market: 'moneyline',
      positionType: 1,
      lineTicks: 0,
      oddsTick: 165,
      riskWei6: 7_700_000n,
      profitWei6: 5_000_000n,
      awayTeam: AWAY,
      homeTeam: HOME,
    });
    expect(view.address).toBeNull();
    expect(view.backing).toBe(HOME);
    expect(view.odds.american).toBe('-154');
  });
});
