/**
 * Unit tests for `computeTakerView` — the pure helper that derives the
 * taker-centric perspective (which team / side, taker odds, max bet,
 * to-win) from a maker's commitment.
 *
 * Anchors:
 *   - moneyline: maker upper (away) ↔ taker home; maker lower (home) ↔
 *     taker away. Team name only — no line attached.
 *   - spread: lineTicks stored away-perspective. Taker upper → lineTicks
 *     as-is; taker lower → -lineTicks. Display sign always shown.
 *   - total: positionType-flipped Over/Under, perspective-neutral line.
 *   - odds: tick → tick inversion mirrors `buildMatchPreview`'s
 *     `inverseOddsTick`. 254 (decimal 2.54) → 165 (decimal 1.65).
 *   - economics: maxBet = remainingRiskAmount × (oddsTick − 100) / 100
 *     (wei6, BigInt floor); toWin = remainingRiskAmount.
 */

import { describe, expect, it } from 'vitest';
import { computeTakerView } from '../src/commitments/takerView.js';
import { OspexValidationError } from '../src/errors.js';
import type { Commitment } from '../src/types/commitment.js';

const GIANTS_DODGERS = {
  awayTeam: 'San Francisco Giants',
  homeTeam: 'Los Angeles Dodgers',
};

function makeCommitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    visibility: 'visible',
    redacted: false,
    commitmentHash: '0xac741f71' + 'a'.repeat(56),
    maker: '0x5316fa54c170d1927f30d1a497ac9e85e3826a9b',
    contestId: '9',
    scorer: '0xdead0000000000000000000000000000beef',
    lineTicks: 0,
    positionType: 0,
    oddsTick: 254,
    marketType: 'moneyline',
    riskAmount: '5000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '5000000',
    nonce: '1',
    expiry: '2027-01-01T00:00:00.000Z',
    speculationKey: null,
    signature: '0xsig',
    status: 'open',
    storedStatus: 'open',
    source: 'unit-test',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2026-05-14T20:00:00.000Z',
    ...overrides,
  };
}

describe('computeTakerView — moneyline', () => {
  it('maker upper (away) → taker backs home; odds invert; full-fill economics', () => {
    // Mirrors the staged Giants commitment: maker upper (Giants) at
    // +154 (decimal 2.54, oddsTick 254), 5 USDC risk fully remaining.
    // Taker takes the Dodgers side at 1.65 / -154, risks $7.70 to win
    // $5.00.
    const view = computeTakerView(makeCommitment(), GIANTS_DODGERS);
    expect(view.youBack).toBe('Los Angeles Dodgers');
    expect(view.takerDecimal).toBe('1.65');
    expect(view.takerAmerican).toBe('-154');
    expect(view.takerOddsTick).toBe(165);
    expect(view.maxBetUSDC).toBe('7.70');
    expect(view.toWinUSDC).toBe('5.00');
    expect(view.maxBetWei6).toBe('7700000');
  });

  it('maker lower (home) → taker backs away', () => {
    const view = computeTakerView(
      makeCommitment({ positionType: 1 }),
      GIANTS_DODGERS,
    );
    expect(view.youBack).toBe('San Francisco Giants');
  });

  it('partial-fill commitment: maxBet computed against remaining only', () => {
    // 5 USDC original, 2 already filled → 3 remaining. Same +154
    // odds. Taker max = 3 * 1.54 = 4.62.
    const view = computeTakerView(
      makeCommitment({ remainingRiskAmount: '3000000', filledRiskAmount: '2000000' }),
      GIANTS_DODGERS,
    );
    expect(view.maxBetUSDC).toBe('4.62');
    expect(view.toWinUSDC).toBe('3.00');
  });
});

describe('computeTakerView — spread', () => {
  it('maker lower with negative homeLine: taker takes away side at flipped line', () => {
    // Maker on Dodgers -1.5 (lower, lineTicks=-15). Taker takes
    // Giants +1.5 (upper, displayed line = lineTicks = -15 → no,
    // upper sees lineTicks as-is which is -15; but we flip to taker
    // upper which takes lineTicks=-15 → "Giants -1.5"? wait
    // let's read the helper.
    //
    // Actually: lineTicks is stored away-perspective. So if homeLine
    // = -1.5 (home favored), the protocol stores lineTicks=+15
    // (away-line = +1.5). Maker on home (lower) with lineTicks=+15
    // means home line = -lineTicks = -1.5. Taker on away (upper)
    // takes lineTicks as-is = +1.5 → "Giants +1.5".
    const view = computeTakerView(
      makeCommitment({
        marketType: 'spread',
        positionType: 1,
        lineTicks: 15,
      }),
      GIANTS_DODGERS,
    );
    expect(view.youBack).toBe('San Francisco Giants +1.5');
  });

  it('maker upper with positive away-line: taker takes home side at flipped line', () => {
    // Maker on Giants +1.5 (upper, lineTicks=+15). Taker takes
    // Dodgers -1.5 (lower, line = -lineTicks = -1.5).
    const view = computeTakerView(
      makeCommitment({
        marketType: 'spread',
        positionType: 0,
        lineTicks: 15,
      }),
      GIANTS_DODGERS,
    );
    expect(view.youBack).toBe('Los Angeles Dodgers -1.5');
  });
});

describe('computeTakerView — total', () => {
  it('maker upper (over) → taker takes under at same line', () => {
    const view = computeTakerView(
      makeCommitment({
        marketType: 'total',
        positionType: 0,
        lineTicks: 75, // 7.5
      }),
      GIANTS_DODGERS,
    );
    expect(view.youBack).toBe('Under 7.5');
  });

  it('maker lower (under) → taker takes over at same line', () => {
    const view = computeTakerView(
      makeCommitment({
        marketType: 'total',
        positionType: 1,
        lineTicks: 80,
      }),
      GIANTS_DODGERS,
    );
    expect(view.youBack).toBe('Over 8.0');
  });

  it('lineTicks is taken absolute for total display (negative input handled)', () => {
    const view = computeTakerView(
      makeCommitment({
        marketType: 'total',
        positionType: 0,
        lineTicks: -75,
      }),
      GIANTS_DODGERS,
    );
    expect(view.youBack).toBe('Under 7.5');
  });
});

describe('computeTakerView — formatUSDCConcise behavior', () => {
  it('trims trailing zeros below 2dp', () => {
    // Pick odds and risk that produce a non-round wei6 value.
    // remaining 1_234_567 wei6, oddsTick 200 (+100, decimal 2.00):
    //   maxBetWei6 = 1_234_567 × 100 / 100 = 1_234_567 → "1.234567"
    //   toWinWei6  = 1_234_567 → "1.234567"
    const view = computeTakerView(
      makeCommitment({
        oddsTick: 200,
        remainingRiskAmount: '1234567',
      }),
      GIANTS_DODGERS,
    );
    expect(view.maxBetUSDC).toBe('1.234567');
    expect(view.toWinUSDC).toBe('1.234567');
  });

  it('pads to 2dp when below', () => {
    // remaining 1_000_000 wei6, oddsTick 200: maxBet = 1_000_000 →
    // raw "1.000000" → trimmed "1." → padded "1.00".
    const view = computeTakerView(
      makeCommitment({
        oddsTick: 200,
        remainingRiskAmount: '1000000',
      }),
      GIANTS_DODGERS,
    );
    expect(view.maxBetUSDC).toBe('1.00');
    expect(view.toWinUSDC).toBe('1.00');
  });
});

describe('computeTakerView — corrupt-row guards', () => {
  it('throws when oddsTick is null', () => {
    expect(() =>
      computeTakerView(
        makeCommitment({ oddsTick: null }),
        GIANTS_DODGERS,
      ),
    ).toThrow(OspexValidationError);
  });

  it('throws when oddsTick ≤ 100 (decimal ≤ 1.00, below protocol min)', () => {
    expect(() =>
      computeTakerView(makeCommitment({ oddsTick: 100 }), GIANTS_DODGERS),
    ).toThrow(OspexValidationError);
  });

  it('throws when positionType is null', () => {
    expect(() =>
      computeTakerView(
        makeCommitment({ positionType: null }),
        GIANTS_DODGERS,
      ),
    ).toThrow(OspexValidationError);
  });

  it('throws when marketType is null', () => {
    expect(() =>
      computeTakerView(
        makeCommitment({ marketType: null }),
        GIANTS_DODGERS,
      ),
    ).toThrow(OspexValidationError);
  });

  it('throws when spread commitment is missing lineTicks', () => {
    expect(() =>
      computeTakerView(
        makeCommitment({ marketType: 'spread', lineTicks: null }),
        GIANTS_DODGERS,
      ),
    ).toThrow(OspexValidationError);
  });

  it('throws when total commitment is missing lineTicks', () => {
    expect(() =>
      computeTakerView(
        makeCommitment({ marketType: 'total', lineTicks: null }),
        GIANTS_DODGERS,
      ),
    ).toThrow(OspexValidationError);
  });
});
