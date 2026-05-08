/**
 * Predicate: can a commitment on this market end in a push (stake
 * returned) given the line?
 *
 * Rule: spread/total push exactly when the line lands on an integer
 * (no half-point). Since `lineTicks` is the line × 10, that's the
 * tick value being a multiple of 10.
 *
 * Moneyline never pushes — there's no "tie" outcome in the protocol's
 * moneyline scorer.
 *
 * The preview block uses this to emit the third "push" outcome row
 * when relevant; outcome generation in `buildSubmitPreview` keys off it.
 */

import type { MarketType } from '../types/odds.js';

export function pushPossible(market: MarketType, lineTicks: number): boolean {
  if (market === 'moneyline') return false;
  if (!Number.isInteger(lineTicks)) return false;
  return lineTicks % 10 === 0;
}
