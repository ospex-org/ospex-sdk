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
  americanOddsToTick,
  decimalOddsToTick,
  parseOddsInput,
  tickToAmericanOdds,
  tickToDecimalOdds,
  usdcDecimalToWei6,
  usdcDecimalToAmountWei6,
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

describe('americanOddsToTick', () => {
  it('positive American: tick = magnitude + 100 (exact, no rounding)', () => {
    const cases: Array<[string, number]> = [
      ['+100', 200], // even money via positive
      ['+115', 215],
      ['+150', 250],
      ['+200', 300],
      ['+500', 600],
      ['+10000', 10100], // protocol max
    ];
    for (const [input, expected] of cases) {
      expect(americanOddsToTick(input)).toBe(expected);
    }
  });

  it('negative American: tick = round(((|N|+100)*100)/|N|)', () => {
    const cases: Array<[string, number]> = [
      ['-100', 200], // even money via negative
      ['-110', 191], // 1.9091 → rounds to 1.91
      ['-150', 167], // 1.6667 → rounds to 1.67
      ['-200', 150], // 1.50 exact
      ['-500', 120], // 1.20 exact
      ['-10000', 101], // protocol min
    ];
    for (const [input, expected] of cases) {
      expect(americanOddsToTick(input)).toBe(expected);
    }
  });

  it('rejects magnitude < 100', () => {
    expect(() => americanOddsToTick('+99')).toThrow(/magnitude must be ≥ 100/);
    expect(() => americanOddsToTick('-99')).toThrow(/magnitude must be ≥ 100/);
    expect(() => americanOddsToTick('+0')).toThrow(/magnitude must be ≥ 100/);
    expect(() => americanOddsToTick('-0')).toThrow(/magnitude must be ≥ 100/);
    expect(() => americanOddsToTick('+50')).toThrow(/magnitude must be ≥ 100/);
  });

  it('rejects unsigned input', () => {
    expect(() => americanOddsToTick('150')).toThrow(/Invalid American odds/);
    expect(() => americanOddsToTick('-')).toThrow(/Invalid American odds/);
    expect(() => americanOddsToTick('+')).toThrow(/Invalid American odds/);
  });

  it('rejects decimal points (American is integer-only)', () => {
    expect(() => americanOddsToTick('+150.0')).toThrow(/Invalid American odds/);
    expect(() => americanOddsToTick('-110.5')).toThrow(/Invalid American odds/);
  });

  it('rejects scientific notation, commas, NaN, whitespace', () => {
    expect(() => americanOddsToTick('+1e2')).toThrow(/Invalid American odds/);
    expect(() => americanOddsToTick('+1,500')).toThrow(/Invalid American odds/);
    expect(() => americanOddsToTick('NaN')).toThrow(/Invalid American odds/);
    expect(() => americanOddsToTick(' +150')).toThrow(/whitespace/);
    expect(() => americanOddsToTick('+150 ')).toThrow(/whitespace/);
  });

  it('accepts boundary magnitudes (±10000)', () => {
    // +10000 → decimal 101.00 = protocol max → tick 10100 (passes)
    expect(americanOddsToTick('+10000')).toBe(10100);
    // -10000 → decimal 1.01 = protocol min → tick 101 (passes)
    expect(americanOddsToTick('-10000')).toBe(101);
  });

  it('rejects magnitudes above 10000 BEFORE rounding', () => {
    // The original implementation accepted values like -15000 by silently
    // rounding the resulting decimal back up to 1.01 = -10000 American.
    // The strict pre-math check now rejects any |American| > 10000 with
    // a clear error rather than letting the user sign a materially
    // different price than they typed.
    expect(() => americanOddsToTick('+10001')).toThrow(/magnitude must be ≤ 10000/);
    expect(() => americanOddsToTick('-10001')).toThrow(/magnitude must be ≤ 10000/);
    expect(() => americanOddsToTick('-15000')).toThrow(/magnitude must be ≤ 10000/);
    expect(() => americanOddsToTick('-1000000')).toThrow(/magnitude must be ≤ 10000/);
    // The old code path would have rounded -15000 → tick 101 (decimal 1.01
    // = American -10000). Verify that's NOT what happens anymore.
    let caught: unknown;
    try {
      americanOddsToTick('-15000');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OspexValidationError);
  });
});

describe('tickToAmericanOdds', () => {
  it('formats positive American (tick ≥ 200)', () => {
    expect(tickToAmericanOdds(200)).toBe('+100'); // even money
    expect(tickToAmericanOdds(215)).toBe('+115');
    expect(tickToAmericanOdds(250)).toBe('+150');
    expect(tickToAmericanOdds(300)).toBe('+200');
    expect(tickToAmericanOdds(10100)).toBe('+10000'); // protocol max
  });

  it('formats negative American (tick < 200)', () => {
    expect(tickToAmericanOdds(191)).toBe('-110'); // 100/(0.91) = 109.89 → 110
    expect(tickToAmericanOdds(167)).toBe('-149'); // 100/0.67 = 149.25 → 149
    expect(tickToAmericanOdds(150)).toBe('-200'); // 100/0.50 = 200 exact
    expect(tickToAmericanOdds(120)).toBe('-500'); // 100/0.20 = 500 exact
    expect(tickToAmericanOdds(101)).toBe('-10000'); // protocol min
  });

  it('rejects ticks outside protocol range', () => {
    expect(() => tickToAmericanOdds(100)).toThrow(/protocol range/);
    expect(() => tickToAmericanOdds(10101)).toThrow(/protocol range/);
    expect(() => tickToAmericanOdds(0)).toThrow(/protocol range/);
  });

  it('rejects non-integer ticks', () => {
    expect(() => tickToAmericanOdds(1.5)).toThrow(/integer/);
  });
});

describe('parseOddsInput — dual-format with strict disambiguation', () => {
  it('dispatches signed inputs to American', () => {
    expect(parseOddsInput('+115')).toBe(215);
    expect(parseOddsInput('-110')).toBe(191);
    expect(parseOddsInput('+150')).toBe(250);
    expect(parseOddsInput('+10000')).toBe(10100);
  });

  it('dispatches decimal-point inputs to decimal', () => {
    expect(parseOddsInput('1.91')).toBe(191);
    expect(parseOddsInput('2.50')).toBe(250);
    expect(parseOddsInput('101.0')).toBe(10100);
    expect(parseOddsInput('1.5')).toBe(150);
  });

  it('rejects integers without sign or decimal point (ambiguous)', () => {
    expect(() => parseOddsInput('101')).toThrow(/Ambiguous/);
    expect(() => parseOddsInput('101')).toThrow(/sign or decimal point/);
    expect(() => parseOddsInput('150')).toThrow(/Ambiguous/);
    expect(() => parseOddsInput('2')).toThrow(/Ambiguous/);
    expect(() => parseOddsInput('1')).toThrow(/Ambiguous/);
  });

  it('ambiguous-integer error suggests valid examples (not raw input)', () => {
    // For `--odds 2`, an earlier message suggested `+2` for American —
    // invalid because magnitude must be ≥ 100. The error must use
    // static valid examples that work regardless of the user's input.
    let message = '';
    try {
      parseOddsInput('2');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/Ambiguous/);
    // Suggest valid American examples (±100/150/110), NOT "+2" / "-2".
    expect(message).toContain('"+100"');
    expect(message).toMatch(/\+150|-110/);
    expect(message).not.toContain('"+2"');
    expect(message).not.toContain('"-2"');
    // Suggest a valid decimal example.
    expect(message).toContain('"2.00"');

    // Same for `--odds 1` — `+1` would also fail magnitude check.
    let message1 = '';
    try {
      parseOddsInput('1');
    } catch (err) {
      message1 = err instanceof Error ? err.message : String(err);
    }
    expect(message1).not.toContain('"+1"');
    expect(message1).not.toContain('"-1"');
  });

  it('rejects inputs with both sign and decimal point (ambiguous)', () => {
    expect(() => parseOddsInput('+101.0')).toThrow(/Ambiguous/);
    expect(() => parseOddsInput('+101.0')).toThrow(/pick one format/);
    expect(() => parseOddsInput('-1.91')).toThrow(/Ambiguous/);
    expect(() => parseOddsInput('+2.50')).toThrow(/Ambiguous/);
    expect(() => parseOddsInput('-110.5')).toThrow(/Ambiguous/);
  });

  it('protocol bounds apply via the chosen path', () => {
    // Decimal path
    expect(() => parseOddsInput('1.00')).toThrow(/minimum/);
    expect(() => parseOddsInput('150.00')).toThrow(/maximum/);
    // American path: magnitude check before the math, then protocol
    // range applies to the resulting tick (which is naturally bounded
    // once magnitude is in [100, 10000]).
    expect(() => parseOddsInput('+10001')).toThrow(/magnitude must be ≤ 10000/);
    expect(() => parseOddsInput('-10001')).toThrow(/magnitude must be ≤ 10000/);
    expect(() => parseOddsInput('+99')).toThrow(/magnitude must be ≥ 100/);
  });

  it('rejects whitespace, NaN, scientific notation regardless of format', () => {
    expect(() => parseOddsInput(' 2.50')).toThrow(/whitespace/);
    expect(() => parseOddsInput('2.50 ')).toThrow(/whitespace/);
    expect(() => parseOddsInput(' +150')).toThrow(/whitespace/);
    expect(() => parseOddsInput('NaN')).toThrow(); // either decimal-path or ambiguous
    expect(() => parseOddsInput('1e2')).toThrow(); // hits decimal-path scientific reject
  });

  it('round-trips: decimal input → tick → American display matches expected', () => {
    // Verify the display roundtrip (tick → American) for canonical values.
    expect(tickToAmericanOdds(parseOddsInput('2.50'))).toBe('+150');
    expect(tickToAmericanOdds(parseOddsInput('1.91'))).toBe('-110');
    expect(tickToAmericanOdds(parseOddsInput('1.50'))).toBe('-200');
    expect(tickToAmericanOdds(parseOddsInput('2.00'))).toBe('+100');
  });

  it('round-trips: American input → tick → decimal display lossless', () => {
    expect(tickToDecimalOdds(parseOddsInput('+150'))).toBe('2.50');
    expect(tickToDecimalOdds(parseOddsInput('-200'))).toBe('1.50');
    // Negative American with non-2dp-clean conversion: input → tick rounds.
    // -110 input → 1.9091... → tick 191 → "1.91" display. Fine.
    expect(tickToDecimalOdds(parseOddsInput('-110'))).toBe('1.91');
  });

  it('+100 and -100 both map to tick 200 (even money)', () => {
    expect(parseOddsInput('+100')).toBe(200);
    expect(parseOddsInput('-100')).toBe(200);
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

describe('usdcDecimalToAmountWei6', () => {
  // The sibling parser for every USDC amount that is NOT a commitment's
  // signed riskAmount: a taker's desired risk, an ERC-20 approve amount.
  // It differs from usdcDecimalToWei6 in exactly one BEHAVIOURAL respect —
  // no lot rule — and each test below pairs the relaxation with the negative
  // control proving usdcDecimalToWei6 still refuses the same input. (The
  // non-positive message also names a different subject; pinned below.)

  it('accepts off-lot-grid amounts that usdcDecimalToWei6 refuses', () => {
    const offGrid: Array<[string, bigint]> = [
      ['0.000001', 1n], // 1 wei6 — a real takerRisk at oddsTick 101
      ['0.000123', 123n],
      ['0.000150', 150n], // the allowance-prompt default at oddsTick 250
      ['0.999936', 999_936n], // the value quoted in the issue
      ['4.999918', 4_999_918n], // the example in PerspectiveAmount's docstring
    ];
    for (const [input, expected] of offGrid) {
      expect(usdcDecimalToAmountWei6(input)).toBe(expected);
      // NEGATIVE CONTROL: the maker-risk parser must still refuse it.
      expect(() => usdcDecimalToWei6(input)).toThrow(/lot size/);
    }
  });

  it('agrees with usdcDecimalToWei6 on every lot-aligned value', () => {
    // The relaxation must not change any value the strict parser accepts.
    for (const input of ['1', '1.000000', '0.001', '0.0001', '25', '1000', '999999999.9999']) {
      expect(usdcDecimalToAmountWei6(input)).toBe(usdcDecimalToWei6(input));
    }
  });

  it('still rejects everything the strict parser rejects except the lot rule', () => {
    // Precision.
    expect(() => usdcDecimalToAmountWei6('1.0000001')).toThrow(OspexValidationError);
    // Zero / negative.
    expect(() => usdcDecimalToAmountWei6('0')).toThrow(/positive/);
    expect(() => usdcDecimalToAmountWei6('0.000000')).toThrow(/positive/);
    expect(() => usdcDecimalToAmountWei6('-1')).toThrow(/positive/);
    expect(() => usdcDecimalToAmountWei6('-0.000001')).toThrow(/positive/);
    // Malformed literals.
    expect(() => usdcDecimalToAmountWei6('1e3')).toThrow(OspexValidationError);
    expect(() => usdcDecimalToAmountWei6('1,000')).toThrow(OspexValidationError);
    expect(() => usdcDecimalToAmountWei6('NaN')).toThrow(OspexValidationError);
    expect(() => usdcDecimalToAmountWei6('Infinity')).toThrow(OspexValidationError);
    expect(() => usdcDecimalToAmountWei6(' 1 ')).toThrow(OspexValidationError);
    expect(() => usdcDecimalToAmountWei6('')).toThrow(OspexValidationError);
    expect(() => usdcDecimalToAmountWei6('abc')).toThrow(OspexValidationError);
  });

  it('sweeps the wei6 space: accepts every residue, strict parser accepts only 0 mod 100', () => {
    // Not a sampled example — every offset in a full lot is exercised.
    let strictAccepted = 0;
    for (let n = 1n; n <= 1000n; n += 1n) {
      const input = wei6ToDecimalUSDC(n);
      expect(usdcDecimalToAmountWei6(input)).toBe(n);
      if (n % 100n === 0n) {
        expect(usdcDecimalToWei6(input)).toBe(n);
        strictAccepted += 1;
      } else {
        expect(() => usdcDecimalToWei6(input)).toThrow(/lot size/);
      }
    }
    expect(strictAccepted).toBe(10);
  });

  it('inverts wei6ToDecimalUSDC for POSITIVE values only — zero and negatives are refused', () => {
    // The agent contract points consumers at the paired `*Wei6` field with
    // BigInt() precisely because of this asymmetry: wei6ToDecimalUSDC maps
    // ANY bigint to a string, but the parsers validate user-supplied input
    // and so refuse zero. Sweep rather than sample.
    // Sweep the SIGNED range: the SDK emits negative USDC strings too
    // (`outcomes[].payoutUSDC` on a 'lose' row is the negated risk).
    for (let n = -300n; n <= 300n; n += 1n) {
      const emitted = wei6ToDecimalUSDC(n);
      if (n > 0n) {
        expect(usdcDecimalToAmountWei6(emitted)).toBe(n);
      } else {
        expect(() => usdcDecimalToAmountWei6(emitted), emitted).toThrow(/must be positive/);
        expect(() => usdcDecimalToWei6(emitted), emitted).toThrow(/must be positive/);
      }
      // The documented always-works path, for every sign.
      expect(BigInt(n.toString())).toBe(n);
    }
    expect(wei6ToDecimalUSDC(0n)).toBe('0.000000');
    expect(wei6ToDecimalUSDC(-7_700_000n)).toBe('-7.700000');
    expect(() => usdcDecimalToAmountWei6('-7.700000')).toThrow(/must be positive/);
  });

  it('reports a neutral subject — it is not always a "risk amount"', () => {
    // Emitted verbatim at ERC-20 allowance prompts, where "Risk amount"
    // would be wrong.
    expect(() => usdcDecimalToAmountWei6('0')).toThrow(/USDC amount must be positive/);
    expect(() => usdcDecimalToWei6('0')).toThrow(/Risk amount must be positive/);
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

  it('rejects values whose tick magnitude exceeds MAX_LINE_TICKS (1_000_000)', () => {
    // ticks = decimal × 10, and MAX_LINE_TICKS = 1_000_000, so the bound is
    // decimal ±100_000.0. One decimal place above the boundary triggers it.
    expect(() => lineDecimalToTicks('100000.1')).toThrow(/exceeds the protocol maximum/);
    expect(() => lineDecimalToTicks('-100000.1')).toThrow(/exceeds the protocol maximum/);
    // A value still inside int32 but past the magnitude bound is now rejected
    // (it would have been accepted under the old int32-only check).
    expect(() => lineDecimalToTicks('214748364.7')).toThrow(/exceeds the protocol maximum/);
    // The boundary itself is accepted.
    expect(lineDecimalToTicks('100000')).toBe(1_000_000);
    expect(lineDecimalToTicks('100000.0')).toBe(1_000_000);
    expect(lineDecimalToTicks('-100000')).toBe(-1_000_000);
    expect(lineDecimalToTicks('-100000.0')).toBe(-1_000_000);
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
