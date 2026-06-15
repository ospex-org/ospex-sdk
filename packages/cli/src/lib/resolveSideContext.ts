/**
 * Async enrichment for the structured `SideContext` (Team Identity) on the
 * single-position commands `settle` and `claim` — the I/O sibling of the
 * pure `buildSideContext` (lib/sideContext.ts).
 *
 * Resolves a side's team name + favorite/underdog role by fetching
 * `client.speculations.get` (team + market + spread line — one call) and,
 * only when a role genuinely needs odds, `client.odds.snapshot`.
 *
 * NON-BLOCKING + NEVER THROWS. The settle/claim transaction has ALREADY
 * resolved by the time these run; enrichment is post-hoc display metadata.
 * A fetch failure degrades the context honestly (team `unavailable` / role
 * `unknown`) and surfaces a `warning` — it must never propagate and cause a
 * successful settle/claim to be reported as failed (a hard review rule).
 */

import type { AgentWarning, MarketType, OspexClient } from '@ospex/sdk';
import { buildSideContext, type SideContext, type SideValue } from './sideContext.js';

type SpeculationDetail = Awaited<ReturnType<OspexClient['speculations']['get']>>;

const NO_TEAM_SIDES = new Set<SideValue>(['push', 'void', 'tbd']);

/**
 * `positionType` → side, given the market. Mirrors the SDK's `sideRoleFor`
 * (moneyline/spread: 0 = away, 1 = home; total: 0 = over, 1 = under).
 * Reimplemented here to keep enrichment CLI-layer (no new SDK export) — the
 * mapping is a stable protocol convention (`OspexTypes` Upper/Lower).
 */
function sideForPositionType(market: MarketType, positionType: 0 | 1): SideValue {
  if (market === 'total') return positionType === 0 ? 'over' : 'under';
  return positionType === 0 ? 'away' : 'home';
}

/** Derive the degradation warning from a resolved context's `status`
 * (none for `complete` / `not_applicable`). */
function enrichmentWarning(context: SideContext, speculationId: bigint): AgentWarning | undefined {
  const sid = speculationId.toString();
  if (context.status === 'unavailable') {
    return {
      code: 'side-context-unavailable',
      message: `Could not resolve the team identity for side "${context.side}" on speculation ${sid} — enrichment metadata was unavailable. The on-chain operation itself succeeded; route on the bare side field.`,
      severity: 'warning',
      details: { speculationId: sid, side: context.side },
    };
  }
  if (context.status === 'partial') {
    return {
      code: 'side-role-unavailable',
      message: `Resolved the team for side "${context.side}" on speculation ${sid} but could not determine its favorite/underdog role (odds/line unavailable).`,
      severity: 'warning',
      details: { speculationId: sid, side: context.side, team: context.team?.name ?? null },
    };
  }
  return undefined;
}

/**
 * Fetch the per-side American odds a role needs — ONLY when it actually
 * needs them (moneyline always; spread only when the line is absent). Throws
 * on a genuine odds-fetch error; the caller wraps this so a role-only failure
 * degrades to `partial` WITHOUT losing an already-resolved team.
 */
async function fetchRoleOdds(
  client: OspexClient,
  spec: SpeculationDetail,
  side: SideValue,
): Promise<{ away: number | null; home: number | null } | null> {
  if (side !== 'away' && side !== 'home') return null; // role only for team-bearing sides
  if (spec.type === 'moneyline') {
    const m = (await client.odds.snapshot(spec.contestId)).odds.moneyline;
    return m ? { away: m.awayOddsAmerican, home: m.homeOddsAmerican } : null;
  }
  if (spec.type === 'spread') {
    const hasLine = spec.awayLine != null || spec.homeLine != null;
    if (hasLine) return null; // role derives from the line; no odds fetch needed
    const s = (await client.odds.snapshot(spec.contestId)).odds.spread;
    return s ? { away: s.awayOddsAmerican, home: s.homeOddsAmerican } : null;
  }
  return null; // total → no role
}

/** Build the context for a known side from a fetched speculation, degrading
 * the role independently of the team (an odds failure → role `unknown`, the
 * team stays resolved). */
async function contextFromSpeculation(
  client: OspexClient,
  spec: SpeculationDetail,
  side: SideValue,
): Promise<SideContext> {
  const away = spec.contest.awayTeam;
  const home = spec.contest.homeTeam;
  const teams = away && home ? { away, home } : null; // empty names (no game linkage) → unavailable, never invented
  let americanOdds: { away: number | null; home: number | null } | null = null;
  try {
    americanOdds = await fetchRoleOdds(client, spec, side);
  } catch {
    americanOdds = null; // role → unknown (status `partial`); team stays resolved
  }
  return buildSideContext({
    side,
    marketType: spec.type,
    teams,
    teamSource: 'speculation-detail',
    spreadLine: { away: spec.awayLine ?? null, home: spec.homeLine ?? null },
    americanOdds,
    totalLine: spec.line,
  });
}

/**
 * `settle` (and any winSide-keyed caller): the side is the known on-chain
 * `winSide`. Never throws — a fetch failure degrades to `team: unavailable`
 * (for away/home) with a `warning`. No fetch at all for push/void/tbd.
 */
export async function resolveWinSideContext(
  client: OspexClient,
  speculationId: bigint,
  winSide: SideValue,
): Promise<{ context: SideContext; warning?: AgentWarning }> {
  if (NO_TEAM_SIDES.has(winSide)) {
    return { context: buildSideContext({ side: winSide }) }; // not_applicable; no fetch
  }
  let context: SideContext;
  try {
    const spec = await client.speculations.get(speculationId.toString());
    context = await contextFromSpeculation(client, spec, winSide);
  } catch {
    // speculations.get failed → degrade. away/home → unavailable; over/under
    // → not_applicable (the line is cosmetic). Never blocks the settle.
    context = buildSideContext({ side: winSide });
  }
  const warning = enrichmentWarning(context, speculationId);
  return warning ? { context, warning } : { context };
}

/**
 * `claim`: the canonical field is `positionType`; the side it represents is
 * derived from the fetched market (`positionType` + `marketType`). Never
 * throws. Returns `context: null` on a fetch failure — without the market the
 * side can't be derived — with a `warning`; the bare `positionType` stands.
 */
export async function resolvePositionSideContext(
  client: OspexClient,
  speculationId: bigint,
  positionType: 0 | 1,
): Promise<{ context: SideContext | null; warning?: AgentWarning }> {
  try {
    const spec = await client.speculations.get(speculationId.toString());
    const side = sideForPositionType(spec.type, positionType);
    const context = await contextFromSpeculation(client, spec, side);
    const warning = enrichmentWarning(context, speculationId);
    return warning ? { context, warning } : { context };
  } catch {
    const sid = speculationId.toString();
    return {
      context: null,
      warning: {
        code: 'side-context-unavailable',
        message: `Could not resolve the team identity for the claimed position (type ${positionType}) on speculation ${sid} — speculation metadata was unavailable. The claim itself succeeded; route on the bare positionType.`,
        severity: 'warning',
        details: { speculationId: sid, positionType },
      },
    };
  }
}
