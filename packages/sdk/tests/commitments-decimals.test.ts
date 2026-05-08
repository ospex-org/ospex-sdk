/**
 * Unit tests for the string-based decimal parsers in
 * `commitments/decimals.ts`. Covers:
 *   - happy-path round trips for odds / risk / line
 *   - precision rejection (more decimals than allowed)
 *   - protocol bounds (odds 1.01..101.00, risk lot size, int32 line)
 *   - notation rejection (scientific, commas, NaN/Infinity, whitespace)
 *   - inverse formatters preserve sign and trailing zeros
 */

import { describe, expect, it } from 'vitest';
import {
  decimalOddsToTick,
  tickToDecimalOdds,
  usdcDecimalToWei6,
  wei6ToDecimalUSDC,
  lineDecimalToTicks,
  ticksToDecimalLine,
} from '../src/commitments/decimals.js';
import { OspexValidationError } from '../src/errors.js';

describe('decimalOddsToTick', () => {
  it('round-trips canonical decimals through tick form', () => {
    const cases: Array<[string, number]> = [
      ['1.01', 101],
      ['1.50', 150],
      ['1.91', 191],
      ['2.00', 200],
      ['2.50', 250],
      ['10.00', 1000],
      ['101.00', 10100],
      ['1.5', 150],
      ['2', 200],
    ];
    for (const [input, expected] of cases) {
      expect(decimalOddsToTick(input)).toBe(expected);
    }
  });

  it('rejects more than 2 decimal places', () => {
    expect(() => decimalOddsToTick('1.915')).toThrow(OspexValidationError);
    expect(() => decimalOddsToTick('2.123')).toThrow(OspexValidationError);
  });

  it('rejects below MIN_ODDS (1.01)', () => {
    expect(() => decimalOddsToTick('1.00')).toThrow(/minimum/);
    expect(() => decimalOddsToTick('0.99')).toThrow(OspexValidationError);
    expect(() => decimalOddsToTick('1')).toThrow(/minimum/);
  });

  it('rejects above MAX_ODDS (101.00)', () => {
    expect(() => decimalOddsToTick('150')).toThrow(/maximum/);
    expect(() => decimalOddsToTick('101.01')).toThrow(/maximum/);
  });

  it('rejects negative odds', () => {
    expect(() => decimalOddsToTick('-1.50')).toThrow(OspexValidationError);
  });

  it('rejects scientific notation, commas, NaN, Infinity, whitespace', () => {
    expect(() => decimalOddsToTick('1e2')).toThrow(OspexValidationError);
    expect(() => decimalOddsToTick('1,500')).toThrow(OspexValidationError);
    expect(() => decimalOddsToTick('NaN')).toThrow(OspexValidationError);
    expect(() => decimalOddsToTick('Infinity')).toThrow(OspexValidationError);
    expect(() => decimalOddsToTick('  2.00')).toThrow(OspexValidationError);
    expect(() => decimalOddsToTick('')).toThrow(OspexValidationError);
  });
});

describe('tickToDecimalOdds', () => {
  it('formats with 2 fractional digits, trailing zeros preserved', () => {
    expect(tickToDecimalOdds(100)).toBe('1.00');
    expect(tickToDecimalOdds(101)).toBe('1.01');
    expect(tickToDecimalOdds(250)).toBe('2.50');
    expect(tickToDecimalOdds(10100)).toBe('101.00');
  });
  it('rejects non-integer ticks', () => {
    expect(() => tickToDecimalOdds(1.5)).toThrow(OspexValidationError);
  });
});

describe('usdcDecimalToWei6', () => {
  it('round-trips canonical USDC values', () => {
    const cases: Array<[string, bigint]> = [
      ['1', 1_000_000n],
      ['1.000000', 1_000_000n],
      ['0.001', 1_000n],
      ['0.0001', 100n],
      ['25', 25_000_000n],
      ['1000', 1_000_000_000n],
    ];
    for (const [input, expected] of cases) {
      expect(usdcDecimalToWei6(input)).toBe(expected);
    }
  });

  it('rejects more than 6 decimal places', () => {
    expect(() => usdcDecimalToWei6('1.0000001')).toThrow(OspexValidationError);
  });

  it('rejects zero or negative', () => {
    expect(() => usdcDecimalToWei6('0')).toThrow(/positive/);
    expect(() => usdcDecimalToWei6('0.000000')).toThrow(/positive/);
    expect(() => usdcDecimalToWei6('-1')).toThrow(/positive/);
  });

  it('enforces 100-wei6 lot size', () => {
    // $0.000001 = 1n wei6; not a multiple of 100n.
    expect(() => usdcDecimalToWei6('0.000001')).toThrow(/lot size/);
    expect(() => usdcDecimalToWei6('0.000123')).toThrow(/lot size/);
    // Multiples of $0.0001 = 100n wei6 are accepted.
    expect(usdcDecimalToWei6('0.0001')).toBe(100n);
    expect(usdcDecimalToWei6('0.0002')).toBe(200n);
  });

  it('rejects scientific notation, commas, NaN, Infinity, whitespace', () => {
    expect(() => usdcDecimalToWei6('1e3')).toThrow(OspexValidationError);
    expect(() => usdcDecimalToWei6('1,000')).toThrow(OspexValidationError);
    expect(() => usdcDecimalToWei6('NaN')).toThrow(OspexValidationError);
    expect(() => usdcDecimalToWei6(' 1 ')).toThrow(OspexValidationError);
  });

  it('handles large values without precision loss (lot-size aligned)', () => {
    expect(usdcDecimalToWei6('1000000')).toBe(1_000_000_000_000n);
    // Largest lot-aligned value just below 1B USDC.
    expect(usdcDecimalToWei6('999999999.9999')).toBe(999_999_999_999_900n);
  });
});

describe('wei6ToDecimalUSDC', () => {
  it('formats with 6 fractional digits, trailing zeros preserved', () => {
    expect(wei6ToDecimalUSDC(1_000_000n)).toBe('1.000000');
    expect(wei6ToDecimalUSDC(1_000n)).toBe('0.001000');
    expect(wei6ToDecimalUSDC(100n)).toBe('0.000100');
    expect(wei6ToDecimalUSDC(0n)).toBe('0.000000');
  });
  it('preserves negative sign', () => {
    expect(wei6ToDecimalUSDC(-1_000_000n)).toBe('-1.000000');
  });
});

describe('lineDecimalToTicks', () => {
  it('round-trips canonical line values', () => {
    const cases: Array<[string, number]> = [
      ['0', 0],
      ['0.5', 5],
      ['-0.5', -5],
      ['3', 30],
      ['-3', -30],
      ['3.5', 35],
      ['-3.5', -35],
      ['8.5', 85],
      ['220.5', 2205],
    ];
    for (const [input, expected] of cases) {
      expect(lineDecimalToTicks(input)).toBe(expected);
    }
  });

  it('rejects more than 1 decimal place', () => {
    expect(() => lineDecimalToTicks('8.25')).toThrow(OspexValidationError);
    expect(() => lineDecimalToTicks('-3.55')).toThrow(OspexValidationError);
  });

  it('rejects scientific notation / commas / NaN / Infinity / whitespace', () => {
    expect(() => lineDecimalToTicks('1e2')).toThrow(OspexValidationError);
    expect(() => lineDecimalToTicks('1,5')).toThrow(OspexValidationError);
    expect(() => lineDecimalToTicks('NaN')).toThrow(OspexValidationError);
    expect(() => lineDecimalToTicks('Infinity')).toThrow(OspexValidationError);
    expect(() => lineDecimalToTicks('-Infinity')).toThrow(OspexValidationError);
    expect(() => lineDecimalToTicks(' 3.5')).toThrow(OspexValidationError);
    expect(() => lineDecimalToTicks('3.5 ')).toThrow(OspexValidationError);
    expect(() => lineDecimalToTicks('')).toThrow(OspexValidationError);
  });

  it('rejects values whose tick representation overflows int32', () => {
    // INT32_MAX = 2_147_483_647; ticks = decimal × 10. So a decimal of
    // 214_748_364.8 → tick 2_147_483_648 → overflow. Anything ≥ 214_748_364.8
    // overflows; one decimal place above the boundary triggers it.
    expect(() => lineDecimalToTicks('214748364.8')).toThrow(/int32/);
    expect(() => lineDecimalToTicks('-214748364.9')).toThrow(/int32/);
    // Just inside the bound is accepted.
    expect(lineDecimalToTicks('214748364.7')).toBe(2_147_483_647);
    expect(lineDecimalToTicks('-214748364.8')).toBe(-2_147_483_648);
  });
});

describe('ticksToDecimalLine', () => {
  it('formats with 1 fractional digit, sign preserved', () => {
    expect(ticksToDecimalLine(0)).toBe('0.0');
    expect(ticksToDecimalLine(35)).toBe('3.5');
    expect(ticksToDecimalLine(-35)).toBe('-3.5');
    expect(ticksToDecimalLine(80)).toBe('8.0');
  });
});
