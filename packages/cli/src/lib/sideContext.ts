/**
 * Structured "side context" for the Team Identity Rule on the position
 * lifecycle commands (`settle`, `claim`, `claim-all`).
 *
 * The protocol surfaces a bare side enum — `winSide`
 * (`away|home|over|under|push|void|tbd`) for settle / claim-all settle
 * outcomes, and `positionType` (0|1) for claim — which is abstract: it
 * names a side without the actual team or its favorite/underdog role.
 * The org Team Identity Rule requires tool output to pair an abstract
 * side with the real team NAME plus role.
 *
 * `buildSideContext` produces an ADDITIVE structured object that travels
 * NEXT TO the bare field (never replaces it — agents route on the bare
 * `winSide` / `positionType`; the structured `display` is for humans).
 * It is a pure function: callers gather what they have (team names from
 * `speculations.get`, role inputs from the spread line or `odds.snapshot`)
 * and pass it in; enrichment that isn't available degrades honestly
 * (`status`/`source` say so) rather than being fabricated or omitted.
 *
 * Design notes:
 *   - The SIDE alone implies the market family: `away`/`home` are
 *     team-bearing (moneyline or spread); `over`/`under` are always
 *     `total` (no team); `push`/`void`/`tbd` have no winning side. So the
 *     helper degrades cleanly even when `marketType` is unknown (the
 *     claim-all case — its entries carry no market without a fetch).
 *   - Role: `moneyline` from American-odds sign (more-negative =
 *     favorite); `spread` from the line sign (negative = favorite,
 *     positive = underdog, zero = even), falling back to spread American
 *     odds; `total` and the no-winner sides are `not_applicable`; missing
 *     inputs → `unknown` (never fabricated).
 */

import type { MarketType } from '@ospex/sdk';

/** The bare side values the protocol can surface (the `winSide` enum). */
export type SideValue = 'away' | 'home' | 'over' | 'under' | 'push' | 'void' | 'tbd';

export type SideRole = 'favorite' | 'underdog' | 'even' | 'unknown' | 'not_applicable';

export type SideContextStatus = 'complete' | 'partial' | 'unavailable' | 'not_applicable';

export type SideContextTeamSource =
  | 'speculation-detail'
  | 'claim-params-description'
  | 'unavailable'
  | 'not_applicable';

export type SideContextRoleSource =
  | 'moneyline-odds'
  | 'spread-line'
  | 'spread-odds'
  | 'unavailable'
  | 'not_applicable';

/**
 * Structured, additive team-identity context for one side. Emitted next
 * to the canonical bare field (`winSide` / `positionType`), never instead
 * of it. `display` is human-facing; agents route on the bare field.
 */
export interface SideContext {
  side: SideValue;
  marketType: MarketType | null;
  team: { name: string; alignment: 'away' | 'home' } | null;
  role: SideRole;
  display: string;
  status: SideContextStatus;
  source: { team: SideContextTeamSource; role: SideContextRoleSource };
}

export interface SideContextInput {
  /** Canonical side: a `winSide` value (settle / claim-all) or a
   * `positionType`-derived side role (claim). Required. */
  side: SideValue;
  /** Market type when known; `null`/omitted when unavailable (claim-all
   * entries carry no market without a fetch). */
  marketType?: MarketType | null;
  /** Resolved team names (e.g. from `speculations.get` → `contest`).
   * Omit / `null` when not fetched or unavailable — never fabricate. */
  teams?: { away: string; home: string } | null;
  /** Where the team names came from (only consulted when `teams` is
   * present); defaults to `'speculation-detail'`. */
  teamSource?: SideContextTeamSource;
  /** Signed spread lines per side (negative = that side favored). Drives
   * spread role. */
  spreadLine?: { away: number | null; home: number | null } | null;
  /** American odds per side. Drives moneyline role; spread-role fallback
   * when the line is absent. (More-negative = favorite.) */
  americanOdds?: { away: number | null; home: number | null } | null;
  /** Total over/under threshold — display only (no role for totals). */
  totalLine?: number | null;
}

const NO_WINNER_DISPLAY: Record<'push' | 'void' | 'tbd', string> = {
  tbd: 'tbd (unsettled)',
  push: 'push (no winning side)',
  void: 'void (contest/speculation voided)',
};

function deriveRole(
  marketType: MarketType | null,
  alignment: 'away' | 'home',
  input: SideContextInput,
): { role: SideRole; roleSource: SideContextRoleSource } {
  const odds = input.americanOdds;
  const oddsAvailable = odds != null && odds.away != null && odds.home != null;
  const roleFromOdds = (): SideRole => {
    // American-odds convention: the numerically LOWER (more-negative)
    // price is the favorite.
    const mine = (alignment === 'away' ? odds!.away : odds!.home) as number;
    const other = (alignment === 'away' ? odds!.home : odds!.away) as number;
    return mine < other ? 'favorite' : mine > other ? 'underdog' : 'even';
  };

  if (marketType === 'moneyline') {
    if (oddsAvailable) return { role: roleFromOdds(), roleSource: 'moneyline-odds' };
    return { role: 'unknown', roleSource: 'unavailable' };
  }

  if (marketType === 'spread') {
    // Spread role from the line sign first (review guidance), odds as
    // fallback. Negative line = favorite, positive = underdog, zero = even.
    const line = input.spreadLine;
    const myLine = line != null ? (alignment === 'away' ? line.away : line.home) : null;
    if (myLine != null) {
      const role: SideRole = myLine < 0 ? 'favorite' : myLine > 0 ? 'underdog' : 'even';
      return { role, roleSource: 'spread-line' };
    }
    if (oddsAvailable) return { role: roleFromOdds(), roleSource: 'spread-odds' };
    return { role: 'unknown', roleSource: 'unavailable' };
  }

  // marketType null/unknown for a team-bearing side: we know it's
  // away/home (so team-bearing) but can't pick the derivation path.
  return { role: 'unknown', roleSource: 'unavailable' };
}

/**
 * Build the additive structured side context. Pure; never throws, never
 * fabricates. See the file header for the role/display/status rules.
 */
export function buildSideContext(input: SideContextInput): SideContext {
  const { side } = input;
  const marketType = input.marketType ?? null;

  // No winning side — no team, no role.
  if (side === 'push' || side === 'void' || side === 'tbd') {
    return {
      side,
      marketType,
      team: null,
      role: 'not_applicable',
      display: NO_WINNER_DISPLAY[side],
      status: 'not_applicable',
      source: { team: 'not_applicable', role: 'not_applicable' },
    };
  }

  // Total — over/under always implies `total`, even when marketType is
  // unknown. No team; role not applicable.
  if (side === 'over' || side === 'under') {
    const line = input.totalLine;
    const display =
      line != null ? `${side} ${line} (total; no team)` : `${side} (total; no team)`;
    return {
      side,
      // over/under IS total — assert it rather than echo a (possibly
      // inconsistent) caller-supplied marketType.
      marketType: 'total',
      team: null,
      role: 'not_applicable',
      display,
      status: 'not_applicable',
      source: { team: 'not_applicable', role: 'not_applicable' },
    };
  }

  // Team-bearing: away / home (moneyline or spread).
  const alignment: 'away' | 'home' = side;
  const teamName = input.teams ? (alignment === 'away' ? input.teams.away : input.teams.home) : null;
  const team = teamName ? { name: teamName, alignment } : null;
  const teamSource: SideContextTeamSource = team
    ? input.teamSource ?? 'speculation-detail'
    : 'unavailable';

  if (team === null) {
    // We know the side is team-bearing but couldn't resolve the team —
    // degrade loudly, don't invent one.
    return {
      side,
      marketType,
      team: null,
      role: 'unknown',
      display: `${side} (team unavailable)`,
      status: 'unavailable',
      source: { team: 'unavailable', role: 'unavailable' },
    };
  }

  const { role, roleSource } = deriveRole(marketType, alignment, input);
  const roleResolved = role === 'favorite' || role === 'underdog' || role === 'even';
  const display = roleResolved
    ? `${side} (${team.name}, ${role})`
    : `${side} (${team.name}, role unknown)`;

  return {
    side,
    marketType,
    team,
    role,
    display,
    // Team is known; `complete` once role is resolved, `partial` while
    // the role couldn't be derived (missing/stale line + odds).
    status: roleResolved ? 'complete' : 'partial',
    source: { team: teamSource, role: roleSource },
  };
}
