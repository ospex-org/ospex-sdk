/**
 * Shared perspective-view math used by `buildSubmitPreview`,
 * `buildMatchPreview`, and `computeTakerView`. Pure functions; no I/O,
 * no module-level state.
 *
 * The protocol stores `positionType` as an opaque 0/1 enum (Upper /
 * Lower) and `lineTicks` in away-perspective for spreads. The
 * perspective view normalizes those to first-person fields the
 * executing party and the counterparty can read directly:
 *
 *   - `sideRoleFor` / `invertSideRole` — bridge `positionType` ↔
 *     `'away' | 'home' | 'over' | 'under'` so renderers and outcome
 *     generators never branch on the raw 0/1.
 *   - `buildBackingLabel` — emit the concise "Team -3.5" / "Over 220.5" /
 *     team-name strings used by the JSON `you.backing` /
 *     `counterparty.backing` fields and by `commitments list`'s
 *     `youBack` column.
 *   - `inverseOddsTick` — derive the symmetric taker price from the
 *     maker price using integer-tick math: takerTick = round(100 ×
 *     oddsTick / (oddsTick − 100)).
 *   - `buildPreviewYou` / `buildPreviewCounterparty` — assemble the
 *     `PreviewYou` / `PreviewCounterparty` shapes from already-resolved
 *     inputs. The caller is responsible for inverting odds / risks
 *     before calling — these helpers are pure formatters.
 *
 * Numeric contract: every USDC field is rendered via
 * `wei6ToDecimalUSDC` (6 fractional digits, BigInt-safe). The JSON
 * envelope keeps the 6dp form; renderers handle concise display
 * separately.
 */

import { OspexValidationError } from '../errors.js';
import type { MarketType } from '../types/odds.js';
import type {
  PerspectiveAmount,
  PerspectiveOdds,
  PreviewCounterparty,
  PreviewYou,
  SideRole,
} from '../types/preview.js';
import type { Hex } from '../types/signer.js';
import {
  tickToAmericanOdds,
  tickToDecimalOdds,
  ticksToDecimalLine,
  wei6ToDecimalUSDC,
} from './decimals.js';

const ODDS_SCALE = 100;

/**
 * Compute the symmetric counterparty oddsTick. If maker decimal is
 * D = oddsTick / 100, the taker decimal is D / (D − 1) =
 * oddsTick / (oddsTick − 100). In tick units this is
 * round(100 × oddsTick / (oddsTick − 100)).
 *
 * Inversion is exact for any maker tick that produces a taker tick in
 * the protocol range [101, 10100]; rounding may collapse two adjacent
 * maker ticks to the same taker tick due to the 2dp precision the
 * protocol uses for oddsTick. That's expected — round-trip stability
 * is exercised in the takerView tests.
 *
 * Throws `OspexValidationError` for `oddsTick <= 100` (below the
 * protocol minimum 101). Callers must validate the corrupt-row path
 * before invocation if they want a typed error.
 */
export function inverseOddsTick(oddsTick: number): number {
  const profitTicks = oddsTick - ODDS_SCALE;
  if (profitTicks <= 0) {
    throw new OspexValidationError(
      `Cannot invert oddsTick=${oddsTick}; protocol minimum is ${ODDS_SCALE + 1}.`,
      { field: 'oddsTick' },
    );
  }
  return Math.round((ODDS_SCALE * oddsTick) / profitTicks);
}

/**
 * Map a (market, positionType) tuple to the canonical side role.
 *
 *   moneyline / spread: Upper (0) = away, Lower (1) = home
 *   total:              Upper (0) = over, Lower (1) = under
 */
export function sideRoleFor(market: MarketType, positionType: 0 | 1): SideRole {
  if (market === 'total') return positionType === 0 ? 'over' : 'under';
  return positionType === 0 ? 'away' : 'home';
}

/**
 * Flip a side role to its counterpart. Pure: no market awareness
 * needed because the four roles partition cleanly into two pairs.
 */
export function invertSideRole(role: SideRole): SideRole {
  switch (role) {
    case 'away':
      return 'home';
    case 'home':
      return 'away';
    case 'over':
      return 'under';
    case 'under':
      return 'over';
  }
}

export interface BuildBackingLabelArgs {
  market: MarketType;
  /** The side role this perspective is backing. */
  sideRole: SideRole;
  /**
   * Stored line ticks (away-perspective for spreads). Ignored for
   * moneyline; required (non-null) for spread / total. The caller is
   * responsible for handling the corrupt-row case ahead of this call.
   */
  lineTicks: number;
  awayTeam: string;
  homeTeam: string;
}

/**
 * Build the concise human-readable label for a perspective's backed
 * side. Mirrors the existing `computeYouBack` in `takerView.ts`:
 *
 *   moneyline → team name only
 *   total     → `"Over <line>"` / `"Under <line>"`
 *   spread    → `"<Team> ±<line>"` (selected-side perspective; sign
 *               always rendered)
 */
export function buildBackingLabel(args: BuildBackingLabelArgs): string {
  if (args.market === 'moneyline') {
    return args.sideRole === 'away' ? args.awayTeam : args.homeTeam;
  }
  if (args.market === 'total') {
    const lineDecimal = ticksToDecimalLine(Math.abs(args.lineTicks));
    return `${args.sideRole === 'over' ? 'Over' : 'Under'} ${lineDecimal}`;
  }
  // Spread: stored lineTicks is away-perspective; flip for home.
  const fromSelectedTicks = args.sideRole === 'away' ? args.lineTicks : -args.lineTicks;
  const formatted = ticksToDecimalLine(fromSelectedTicks);
  const signed =
    fromSelectedTicks >= 0 && !formatted.startsWith('+') ? `+${formatted}` : formatted;
  const teamLabel = args.sideRole === 'away' ? args.awayTeam : args.homeTeam;
  return `${teamLabel} ${signed}`;
}

/**
 * Build a `PerspectiveOdds` block from a single tick. Convenience over
 * three repeated calls to `tickToDecimalOdds` / `tickToAmericanOdds` /
 * field assignment.
 */
export function buildPerspectiveOdds(oddsTick: number): PerspectiveOdds {
  return {
    decimal: tickToDecimalOdds(oddsTick),
    american: tickToAmericanOdds(oddsTick),
    oddsTick,
  };
}

/**
 * Build a `PerspectiveAmount` (wei6 + 6dp USDC) from a wei6 BigInt.
 * Callers should pre-validate that `wei6 >= 0n` for risk / profit
 * fields; this helper does not check sign.
 */
export function buildPerspectiveAmount(wei6: bigint): PerspectiveAmount {
  return {
    wei6: wei6.toString(),
    usdc: wei6ToDecimalUSDC(wei6),
  };
}

export interface BuildPerspectiveArgs {
  role: 'maker' | 'taker';
  /** Perspective wallet. For the hypothetical-taker case on submit, pass `null` via the counterparty builder. */
  address: Hex;
  market: MarketType;
  /** Position type from this perspective (NOT the canonical maker's positionType for the taker case). */
  positionType: 0 | 1;
  /** Stored away-perspective line ticks. Pass `0` for moneyline (ignored by `buildBackingLabel`). */
  lineTicks: number;
  /** Effective oddsTick from this perspective (caller inverts if role='taker'). */
  oddsTick: number;
  /** Risk amount from this perspective (caller picks the right wei6). */
  riskWei6: bigint;
  /** Profit if this perspective wins (caller computes from oddsTick × risk). */
  profitWei6: bigint;
  awayTeam: string;
  homeTeam: string;
}

/**
 * Build a `PreviewYou` from already-resolved inputs. Pure formatter —
 * caller is responsible for inverting odds / risks against the
 * canonical maker representation before calling.
 */
export function buildPreviewYou(args: BuildPerspectiveArgs): PreviewYou {
  return {
    role: args.role,
    address: args.address,
    backing: buildBackingLabel({
      market: args.market,
      sideRole: sideRoleFor(args.market, args.positionType),
      lineTicks: args.lineTicks,
      awayTeam: args.awayTeam,
      homeTeam: args.homeTeam,
    }),
    odds: buildPerspectiveOdds(args.oddsTick),
    risk: buildPerspectiveAmount(args.riskWei6),
    profit: buildPerspectiveAmount(args.profitWei6),
    totalReturn: buildPerspectiveAmount(args.riskWei6 + args.profitWei6),
  };
}

export interface BuildCounterpartyArgs extends Omit<BuildPerspectiveArgs, 'address'> {
  /** Counterparty wallet, or `null` on a submit-preview hypothetical taker. */
  address: Hex | null;
}

/**
 * Build a `PreviewCounterparty` from already-resolved inputs. Same
 * shape as `buildPreviewYou` but accepts a nullable address so the
 * submit-preview hypothetical-taker case can be represented.
 */
export function buildPreviewCounterparty(args: BuildCounterpartyArgs): PreviewCounterparty {
  return {
    role: args.role,
    address: args.address,
    backing: buildBackingLabel({
      market: args.market,
      sideRole: sideRoleFor(args.market, args.positionType),
      lineTicks: args.lineTicks,
      awayTeam: args.awayTeam,
      homeTeam: args.homeTeam,
    }),
    odds: buildPerspectiveOdds(args.oddsTick),
    risk: buildPerspectiveAmount(args.riskWei6),
    profit: buildPerspectiveAmount(args.profitWei6),
    totalReturn: buildPerspectiveAmount(args.riskWei6 + args.profitWei6),
  };
}
