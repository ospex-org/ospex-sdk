/**
 * Pure helper for the taker-centric view of a maker's commitment.
 *
 * Used by `ospex commitments list` to render the "what would I be
 * betting if I matched this?" perspective: the team the taker would
 * back, the inverted (taker-side) odds, and the fully-fill economics
 * (max bet, profit on full fill).
 *
 * Pure: no I/O, no state. The caller passes the commitment plus its
 * contest context (team names) and gets back the formatted strings
 * plus the raw `maxBetWei6` integer for sorting / arithmetic.
 *
 * Inversion math (kept symmetric with `buildMatchPreview`):
 *
 *   takerDecimal     = makerDecimal / (makerDecimal − 1)
 *   takerOddsTick    = round(100 × makerOddsTick / (makerOddsTick − 100))
 *   maxTakerRiskWei6 = remainingMakerRiskWei6 × (makerOddsTick − 100) / 100
 *   takerProfitOnFullFill = remainingMakerRiskWei6
 *
 * Integer-arithmetic note: `maxTakerRiskWei6` is computed with BigInt
 * floor-division, matching Solidity semantics. The 0.0001-USDC lot-size
 * rule keeps the worst-case truncation under 0.0001 USDC.
 *
 * Sign / line semantics (mirrors `computeLineDisplay` in
 * buildMatchPreview): `lineTicks` is stored in away-perspective. The
 * taker's `positionType` is the maker's flipped: maker upper (0) →
 * taker lower (1) (and vice versa). For spreads, the selected-side
 * line is `lineTicks` when taker is away, `-lineTicks` when taker is
 * home. Total lines are perspective-neutral; the row label is
 * "Over <line>" or "Under <line>" based on the flipped position type.
 */

import { OspexValidationError } from '../errors.js';
import type { Commitment } from '../types/commitment.js';
import {
  ticksToDecimalLine,
  tickToAmericanOdds,
  tickToDecimalOdds,
  wei6ToDecimalUSDC,
} from './decimals.js';

export interface TakerViewContext {
  /** Away team name from the parent contest. */
  awayTeam: string;
  /** Home team name from the parent contest. */
  homeTeam: string;
}

export interface TakerView {
  /**
   * Human-readable label for the team/side the taker would be backing
   * if they matched this commitment.
   *
   *   moneyline → team name (e.g. "Los Angeles Dodgers")
   *   spread    → team name + selected-side line (e.g. "Dodgers -1.5")
   *   total     → "Over <line>" or "Under <line>"
   */
  youBack: string;
  /** Taker's decimal odds, formatted with 2 fractional digits (e.g. "1.65"). */
  takerDecimal: string;
  /** Taker's American odds, signed (e.g. "-154"). */
  takerAmerican: string;
  /**
   * Taker's `oddsTick` (decimal × 100). Exposed for callers that want
   * to sort by best taker price without re-parsing the string forms.
   */
  takerOddsTick: number;
  /**
   * Max USDC the taker can risk to fully fill this commitment,
   * formatted concisely (trailing zeros trimmed below 2dp; up to 6dp
   * when the value isn't round). Example: "7.70".
   */
  maxBetUSDC: string;
  /**
   * Taker's profit if they fully fill — equals the maker's remaining
   * risk. Same concise format as `maxBetUSDC`.
   */
  toWinUSDC: string;
  /**
   * Taker's max risk as a wei6 BigInt string. Exposed for sorting and
   * exact arithmetic — `maxBetUSDC` is a display-formatted derivative.
   */
  maxBetWei6: string;
}

export function computeTakerView(
  commitment: Commitment,
  context: TakerViewContext,
): TakerView {
  const { marketType, positionType, oddsTick, lineTicks } = commitment;

  if (marketType === null) {
    throw new OspexValidationError(
      `computeTakerView: commitment ${commitment.commitmentHash} is missing marketType.`,
    );
  }
  if (positionType === null) {
    throw new OspexValidationError(
      `computeTakerView: commitment ${commitment.commitmentHash} is missing positionType.`,
    );
  }
  if (oddsTick === null) {
    throw new OspexValidationError(
      `computeTakerView: commitment ${commitment.commitmentHash} is missing oddsTick.`,
    );
  }

  // Flip the position: maker upper (0) ↔ taker lower (1).
  const takerPositionType: 0 | 1 = positionType === 0 ? 1 : 0;

  const youBack = computeYouBack(
    marketType,
    takerPositionType,
    lineTicks,
    context,
  );

  // Invert the odds. Profit-ticks ≤ 0 means decimal ≤ 1.00, which is
  // below the protocol's 1.01 floor — that's a corrupt commitment
  // row, not a normal case.
  const profitTicks = oddsTick - 100;
  if (profitTicks <= 0) {
    throw new OspexValidationError(
      `computeTakerView: cannot invert oddsTick=${oddsTick} ` +
        `(commitment ${commitment.commitmentHash}); protocol minimum is 101.`,
    );
  }
  const takerOddsTick = Math.round((100 * oddsTick) / profitTicks);

  // Max taker risk = remainingMaker × (makerDecimal − 1)
  //                = remainingMakerWei6 × (oddsTick − 100) / 100   (in wei6)
  // BigInt floor-division mirrors Solidity integer semantics. Worst-
  // case truncation: 0.000099 USDC, well below the 0.0001 lot.
  const remainingMakerWei6 = BigInt(commitment.remainingRiskAmount);
  const maxBetWei6 =
    (remainingMakerWei6 * BigInt(profitTicks)) / 100n;

  return {
    youBack,
    takerDecimal: tickToDecimalOdds(takerOddsTick),
    takerAmerican: tickToAmericanOdds(takerOddsTick),
    takerOddsTick,
    maxBetUSDC: formatUSDCConcise(maxBetWei6),
    toWinUSDC: formatUSDCConcise(remainingMakerWei6),
    maxBetWei6: maxBetWei6.toString(),
  };
}

function computeYouBack(
  market: 'moneyline' | 'spread' | 'total',
  takerPositionType: 0 | 1,
  lineTicks: number | null,
  context: TakerViewContext,
): string {
  if (market === 'moneyline') {
    return takerPositionType === 0 ? context.awayTeam : context.homeTeam;
  }
  if (market === 'total') {
    if (lineTicks === null) {
      throw new OspexValidationError(
        'computeTakerView: total commitment is missing lineTicks.',
      );
    }
    const lineDecimal = ticksToDecimalLine(Math.abs(lineTicks));
    return `${takerPositionType === 0 ? 'Over' : 'Under'} ${lineDecimal}`;
  }
  // Spread. Taker upper (0) = away, lower (1) = home. Selected-side
  // line: away → lineTicks (as stored), home → −lineTicks.
  if (lineTicks === null) {
    throw new OspexValidationError(
      'computeTakerView: spread commitment is missing lineTicks.',
    );
  }
  const fromSelectedTicks =
    takerPositionType === 0 ? lineTicks : -lineTicks;
  const formatted = ticksToDecimalLine(fromSelectedTicks);
  const signed =
    fromSelectedTicks >= 0 && !formatted.startsWith('+')
      ? `+${formatted}`
      : formatted;
  const teamLabel =
    takerPositionType === 0 ? context.awayTeam : context.homeTeam;
  return `${teamLabel} ${signed}`;
}

/**
 * Format wei6 as a concise USDC display string. Trailing zeros are
 * trimmed below 2dp; up to 6dp when the value isn't round.
 *
 *   7_700_000n → "7.70"
 *   1_000_000n → "1.00"
 *   1_234_567n → "1.234567"
 *   1_230_000n → "1.23"
 *     500_000n → "0.50"
 */
function formatUSDCConcise(wei6: bigint): string {
  const full = wei6ToDecimalUSDC(wei6); // always 6dp
  let result = full.replace(/0+$/, '');
  if (result.endsWith('.')) {
    return result + '00';
  }
  const dotIdx = result.indexOf('.');
  if (dotIdx < 0) {
    return result + '.00';
  }
  const fracLen = result.length - dotIdx - 1;
  if (fracLen < 2) {
    return result + '0'.repeat(2 - fracLen);
  }
  return result;
}
