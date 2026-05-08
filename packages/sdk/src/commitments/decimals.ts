/**
 * String-based decimal parsers for financial inputs on `commitments
 * submit`. Never use `Number(input) * 10^n` for these — JS float math
 * is the standard cause of off-by-one-cent bugs in financial UIs.
 *
 * Every parser:
 *   - Accepts plain decimal strings only (no `1e3`, `1,000`, `NaN`,
 *     `Infinity`, whitespace-only).
 *   - Validates precision (rejects extra fractional digits rather
 *     than silently rounding).
 *   - Validates protocol bounds where they apply.
 *
 * Inverse helpers (`*ToDecimal*`) are used by the preview formatter
 * and JSON output. Round-trip fidelity is exercised by the tests.
 */

import { OspexValidationError } from '../errors.js';

// ── Protocol bounds ────────────────────────────────────────────────────
//
// MatchingModule.sol:
//   ODDS_SCALE = 100
//   MIN_ODDS   = 101
//   MAX_ODDS   = 10100
//   riskAmount % ODDS_SCALE === 0
const ODDS_SCALE = 100;
const MIN_ODDS_TICK = 101;
const MAX_ODDS_TICK = 10100;
const RISK_LOT_SIZE_WEI6 = 100n;
const LINE_SCALE = 10;
const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;

const REJECT_TOKENS = new Set(['', 'nan', 'infinity', '-infinity', '+infinity']);
// Strict regex: optional leading '-', integer part, optional '.' + fractional part.
// No exponents, no leading '+', no commas, no whitespace.
const SIGNED_DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;
const UNSIGNED_DECIMAL_RE = /^\d+(?:\.\d+)?$/;

interface ParsedParts {
  negative: boolean;
  intPart: string;
  fracPart: string;
}

function parseDecimalParts(input: string, allowSigned: boolean): ParsedParts {
  if (typeof input !== 'string') {
    throw new OspexValidationError('Decimal input must be a string.');
  }
  const lower = input.toLowerCase();
  if (REJECT_TOKENS.has(lower)) {
    throw new OspexValidationError(`Invalid decimal: "${input}".`);
  }
  if (input !== input.trim()) {
    throw new OspexValidationError(`Decimal must not have leading or trailing whitespace: "${input}".`);
  }
  const re = allowSigned ? SIGNED_DECIMAL_RE : UNSIGNED_DECIMAL_RE;
  if (!re.test(input)) {
    throw new OspexValidationError(
      `Invalid decimal "${input}". Plain decimal strings only (no scientific notation, no commas).`,
    );
  }
  const negative = input.startsWith('-');
  const body = negative ? input.slice(1) : input;
  const dot = body.indexOf('.');
  if (dot === -1) return { negative, intPart: body, fracPart: '' };
  return { negative, intPart: body.slice(0, dot), fracPart: body.slice(dot + 1) };
}

// ── decimalOddsToTick ──────────────────────────────────────────────────

/**
 * Parse decimal odds (max 2 fractional digits) into the integer
 * `oddsTick` the contract uses (decimal × 100).
 *
 *   "1.91" → 191
 *   "2.50" → 250
 *   "1.915" throws odds_precision
 *   "1.00"  throws odds_below_min
 *   "150"   throws odds_above_max
 */
export function decimalOddsToTick(input: string): number {
  const { negative, intPart, fracPart } = parseDecimalParts(input, false);
  if (negative) {
    throw new OspexValidationError(`Odds cannot be negative: "${input}".`);
  }
  if (fracPart.length > 2) {
    throw new OspexValidationError(`Odds accept at most 2 decimal places, got "${input}".`);
  }
  const padded = (fracPart + '00').slice(0, 2);
  const tick = Number(intPart) * ODDS_SCALE + Number(padded);
  if (!Number.isFinite(tick) || !Number.isInteger(tick)) {
    throw new OspexValidationError(`Odds parse failed: "${input}".`);
  }
  if (tick < MIN_ODDS_TICK) {
    throw new OspexValidationError(
      `Odds ${formatOddsTick(tick)} below protocol minimum 1.01 (oddsTick >= ${MIN_ODDS_TICK}).`,
    );
  }
  if (tick > MAX_ODDS_TICK) {
    throw new OspexValidationError(
      `Odds ${formatOddsTick(tick)} above protocol maximum 101.00 (oddsTick <= ${MAX_ODDS_TICK}).`,
    );
  }
  return tick;
}

/** Format an integer oddsTick as a decimal string with 2 fractional digits. */
export function tickToDecimalOdds(tick: number): string {
  if (!Number.isInteger(tick)) {
    throw new OspexValidationError(`oddsTick must be an integer, got ${tick}.`);
  }
  const intPart = Math.trunc(tick / ODDS_SCALE);
  const fracPart = Math.abs(tick % ODDS_SCALE)
    .toString()
    .padStart(2, '0');
  return `${intPart}.${fracPart}`;
}

function formatOddsTick(tick: number): string {
  try {
    return tickToDecimalOdds(tick);
  } catch {
    return String(tick);
  }
}

// ── usdcDecimalToWei6 ──────────────────────────────────────────────────

/**
 * Parse decimal USDC (max 6 fractional digits) into wei6 as bigint.
 * Validates lot size (`% 100n === 0n`, matches MatchingModule's
 * "riskAmount must be multiple of ODDS_SCALE") and rejects zero/negative.
 *
 *   "1"        → 1_000_000n
 *   "0.001"    → 1_000n
 *   "0"        throws risk_zero_or_negative
 *   "0.000123" throws lot_size_violation
 */
export function usdcDecimalToWei6(input: string): bigint {
  const { negative, intPart, fracPart } = parseDecimalParts(input, true);
  if (fracPart.length > 6) {
    throw new OspexValidationError(`USDC accepts at most 6 decimal places, got "${input}".`);
  }
  const padded = (fracPart + '000000').slice(0, 6);
  const intBig = BigInt(intPart);
  const fracBig = BigInt(padded);
  let wei6 = intBig * 1_000_000n + fracBig;
  if (negative) wei6 = -wei6;
  if (wei6 <= 0n) {
    throw new OspexValidationError(`Risk amount must be positive, got "${input}".`);
  }
  if (wei6 % RISK_LOT_SIZE_WEI6 !== 0n) {
    throw new OspexValidationError(
      `Risk amount "${input}" violates the 100-wei6 ($0.0001) lot size required by MatchingModule.`,
    );
  }
  return wei6;
}

/** Format wei6 as a decimal string with exactly 6 fractional digits. */
export function wei6ToDecimalUSDC(wei6: bigint): string {
  const negative = wei6 < 0n;
  const absVal = negative ? -wei6 : wei6;
  const intPart = absVal / 1_000_000n;
  const fracPart = absVal % 1_000_000n;
  const fracStr = fracPart.toString().padStart(6, '0');
  return `${negative ? '-' : ''}${intPart.toString()}.${fracStr}`;
}

// ── lineDecimalToTicks ─────────────────────────────────────────────────

/**
 * Parse a decimal line (max 1 fractional digit) into the integer
 * `lineTicks` the contract uses (decimal × 10). Sign preserved.
 *
 *   "-3.5" → -35
 *   "8"    → 80
 *   "8.25" throws line_precision
 */
export function lineDecimalToTicks(input: string): number {
  const { negative, intPart, fracPart } = parseDecimalParts(input, true);
  if (fracPart.length > 1) {
    throw new OspexValidationError(`Line accepts at most 1 decimal place, got "${input}".`);
  }
  const padded = (fracPart + '0').slice(0, 1);
  let ticks = Number(intPart) * LINE_SCALE + Number(padded);
  if (!Number.isFinite(ticks)) {
    throw new OspexValidationError(`Line parse failed: "${input}".`);
  }
  if (negative) ticks = -ticks;
  if (ticks < INT32_MIN || ticks > INT32_MAX) {
    throw new OspexValidationError(`Line ticks ${ticks} outside int32 range.`);
  }
  return ticks;
}

/** Format integer lineTicks as a decimal string with exactly 1 fractional digit. */
export function ticksToDecimalLine(ticks: number): string {
  if (!Number.isInteger(ticks)) {
    throw new OspexValidationError(`lineTicks must be an integer, got ${ticks}.`);
  }
  const negative = ticks < 0;
  const abs = Math.abs(ticks);
  const intPart = Math.trunc(abs / LINE_SCALE);
  const fracPart = (abs % LINE_SCALE).toString();
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}
