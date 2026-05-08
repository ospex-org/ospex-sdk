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

// ── americanOddsToTick / tickToAmericanOdds / parseOddsInput ──────────
//
// American-odds support, gated behind `parseOddsInput` so the CLI / SDK
// can accept both decimal ("1.91", "2.50") and American ("+115", "-110")
// strings. Disambiguation is strict — a plain integer like "101" or a
// signed-decimal like "+101.0" raises rather than guessing, because the
// US-bettor convention and the decimal-odds convention overlap exactly
// at integer-only inputs. Rules:
//
//   - sign present, no decimal point  → American
//   - decimal point present, no sign  → decimal
//   - both present                    → ambiguous (throws)
//   - neither present                 → ambiguous (throws)
//
// Conversion math:
//   American +N (N ≥ 100) → decimal (N + 100) / 100  → tick = N + 100   (exact)
//   American -N (N ≥ 100) → decimal (N + 100) / N    → tick = round(((N+100)*100)/N)
// Rounding only happens on the negative side and is inherent to the
// protocol's 2-decimal-place oddsTick precision; documented at
// `tickToAmericanOdds`'s header.

const AMERICAN_ODDS_RE = /^[+-]\d+$/;
const MIN_AMERICAN_MAGNITUDE = 100;
// Hard upper bound on |American| corresponding to the protocol's
// decimal range [1.01, 101.00]. Without this, large negative inputs
// (e.g. -15000) would silently round their decimal back up to 1.01
// and pass the post-math `tick < MIN_ODDS_TICK` check; the user would
// sign a materially different canonical price than they typed.
// Symmetrically applied to positive American so the rejection message
// is consistent.
const MAX_AMERICAN_MAGNITUDE = 10000;

/**
 * Parse American odds (signed integer, magnitude ≥ 100) into oddsTick
 * (decimal × 100). Negative-American conversion rounds to the nearest
 * 0.01 decimal point — this is inherent to the protocol's 2dp
 * precision (oddsTick is an integer = decimal × 100).
 *
 *   "+150"  → 250   (American +150 = decimal 2.50, exact)
 *   "+115"  → 215   (American +115 = decimal 2.15, exact)
 *   "-110"  → 191   (American -110 = decimal 1.9091…, rounded to 1.91)
 *   "-200"  → 150   (American -200 = decimal 1.50, exact)
 *   "+99"   throws  (magnitude < 100)
 *   "+0"    throws  (magnitude < 100)
 *   "115"   throws  (no sign — use parseOddsInput for the dual-format
 *                    entry point or this function for explicit American)
 */
export function americanOddsToTick(input: string): number {
  if (typeof input !== 'string') {
    throw new OspexValidationError('American odds input must be a string.');
  }
  if (input !== input.trim()) {
    throw new OspexValidationError(
      `American odds must not have leading or trailing whitespace: "${input}".`,
    );
  }
  if (!AMERICAN_ODDS_RE.test(input)) {
    throw new OspexValidationError(
      `Invalid American odds "${input}". Must be a signed integer like "+150" or "-110" (no decimal point, no whitespace).`,
    );
  }
  const sign = input.startsWith('-') ? -1 : 1;
  const magnitude = Number(input.slice(1));
  if (!Number.isFinite(magnitude) || !Number.isInteger(magnitude)) {
    throw new OspexValidationError(`American odds magnitude must be an integer, got "${input}".`);
  }
  if (magnitude < MIN_AMERICAN_MAGNITUDE) {
    throw new OspexValidationError(
      `American odds magnitude must be ≥ ${MIN_AMERICAN_MAGNITUDE}, got "${input}". ` +
        `Magnitudes below 100 don't have a standard American-odds meaning ` +
        `(decimal odds at the boundary is 2.00 = "+100" or "-100").`,
    );
  }
  if (magnitude > MAX_AMERICAN_MAGNITUDE) {
    // Reject before the math runs. Otherwise large negative magnitudes
    // round their resulting tick up to MIN_ODDS_TICK (decimal 1.01 =
    // American -10000) and silently accept a price the user did not
    // type — see ospex-org/ospex-sdk PR #30 review.
    throw new OspexValidationError(
      `American odds magnitude must be ≤ ${MAX_AMERICAN_MAGNITUDE}, got "${input}". ` +
        `Protocol range is decimal 1.01–101.00, equivalent to American ` +
        `[-${MAX_AMERICAN_MAGNITUDE}, -100] ∪ [+100, +${MAX_AMERICAN_MAGNITUDE}].`,
    );
  }

  let tick: number;
  if (sign > 0) {
    // +N → decimal (N + 100) / 100. Multiply both sides by 100: tick = N + 100.
    tick = magnitude + 100;
  } else {
    // -N → decimal (N + 100) / N. tick = round(decimal × 100) =
    // round(((N + 100) × 100) / N). Rounding is to nearest integer
    // (banker's rounding not needed — financial odds use half-up).
    tick = Math.round(((magnitude + 100) * 100) / magnitude);
  }

  if (tick < MIN_ODDS_TICK) {
    throw new OspexValidationError(
      `Odds ${formatOddsTick(tick)} below protocol minimum 1.01 (oddsTick >= ${MIN_ODDS_TICK}). ` +
        `American "${input}" maps to decimal ${formatOddsTick(tick)}.`,
    );
  }
  if (tick > MAX_ODDS_TICK) {
    throw new OspexValidationError(
      `Odds ${formatOddsTick(tick)} above protocol maximum 101.00 (oddsTick <= ${MAX_ODDS_TICK}). ` +
        `American "${input}" maps to decimal ${formatOddsTick(tick)}.`,
    );
  }
  return tick;
}

/**
 * Format an oddsTick as American odds (signed integer string).
 *
 *   200   → "+100"   (decimal 2.00 — even money, conventionally rendered as "+100")
 *   215   → "+115"   (decimal 2.15)
 *   250   → "+150"   (decimal 2.50)
 *   191   → "-110"   (decimal 1.91, rounds via 100/(decimal-1))
 *   150   → "-200"   (decimal 1.50)
 *   10100 → "+10000" (decimal 101.00, protocol max)
 *   101   → "-10000" (decimal 1.01, protocol min)
 *
 * Negative-side conversion rounds to the nearest integer American value
 * — see `americanOddsToTick` header. Round-trip stability is exercised
 * in the tests (some American inputs map to a tick that re-converts to
 * a different American value due to 2dp precision; that's expected).
 */
export function tickToAmericanOdds(tick: number): string {
  if (!Number.isInteger(tick)) {
    throw new OspexValidationError(`oddsTick must be an integer, got ${tick}.`);
  }
  if (tick < MIN_ODDS_TICK || tick > MAX_ODDS_TICK) {
    throw new OspexValidationError(
      `oddsTick ${tick} is outside the protocol range [${MIN_ODDS_TICK}, ${MAX_ODDS_TICK}].`,
    );
  }
  // Decimal = tick / 100. Even money is decimal 2.00 = tick 200.
  // For tick ≥ 200: American = tick - 100 (positive).
  // For tick < 200: American = -round(10000 / (tick - 100)) (negative).
  if (tick >= 200) {
    const american = tick - 100;
    return `+${american}`;
  }
  const decimalMinusOneInTickUnits = tick - 100;
  if (decimalMinusOneInTickUnits <= 0) {
    // Defensive: tick ≤ 100 would mean decimal ≤ 1.00, below protocol min.
    // Caught above by the range check, but belt-and-suspenders here.
    throw new OspexValidationError(
      `Cannot convert oddsTick ${tick} to American odds (decimal ≤ 1.00).`,
    );
  }
  const american = Math.round(10000 / decimalMinusOneInTickUnits);
  return `-${american}`;
}

/**
 * Dual-format odds parser. Returns the canonical oddsTick.
 *
 *   "+115"   → 215     (American)
 *   "-110"   → 191     (American — rounded via 2dp precision)
 *   "1.91"   → 191     (decimal)
 *   "2.50"   → 250     (decimal)
 *   "101.0"  → 10100   (decimal — at protocol max boundary)
 *   "101"    throws    (ambiguous: integer with no sign or decimal point)
 *   "+101.0" throws    (ambiguous: sign + decimal)
 *
 * The disambiguation rules are intentionally aggressive — when a user
 * types "101" they might mean American +101 (decimal 2.01) or decimal
 * 101.00, and the two values differ by ~50x. Erroring is much safer
 * than guessing.
 */
export function parseOddsInput(input: string): number {
  if (typeof input !== 'string') {
    throw new OspexValidationError('Odds input must be a string.');
  }
  if (input !== input.trim()) {
    throw new OspexValidationError(
      `Odds must not have leading or trailing whitespace: "${input}".`,
    );
  }

  const hasSign = /^[+-]/.test(input);
  const hasDecimalPoint = input.includes('.');

  if (hasSign && hasDecimalPoint) {
    throw new OspexValidationError(
      `Ambiguous odds "${input}": signed values are interpreted as American odds and must be ` +
        `integers (e.g. "+150", "-110"); decimal odds (e.g. "1.91", "2.50") must not be signed. ` +
        `Got both — pick one format.`,
    );
  }

  if (!hasSign && !hasDecimalPoint) {
    // Use static examples for the suggestion. Interpolating the raw
    // input would produce nonsense for small integers (e.g. for
    // `--odds 2`, suggesting `+2` is invalid because American magnitudes
    // must be ≥ 100). The two examples below cover both formats with
    // values that are always valid against the protocol bounds.
    throw new OspexValidationError(
      `Ambiguous odds "${input}": plain integers without a sign or decimal point are ambiguous ` +
        `between American and decimal odds. Add a sign for American odds (e.g. "+100", "+150", ` +
        `or "-110") or a decimal point for decimal odds (e.g. "2.00").`,
    );
  }

  if (hasSign) {
    return americanOddsToTick(input);
  }
  return decimalOddsToTick(input);
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
