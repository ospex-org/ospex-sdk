/**
 * Resolve a free-form `--side` input into a canonical
 * `(positionType, role, resolutionSource)` tuple.
 *
 * Algorithm — see PROPOSAL §4 in the parent ospex-matched-pairs/.
 *
 * For totals: input must be `over`/`under` (and a few obvious
 * alternates). Returns Upper/Lower per the OspexTypes convention
 * (Upper=0=away/over, Lower=1=home/under per OspexTypes.sol:106-108).
 *
 * For moneyline / spread: input is matched against the contest's two
 * team strings using these strategies, in order, returning on first hit:
 *   a. exact case-insensitive match on the full team name
 *   b. last-token nickname match (e.g., "lakers" ~ "Los Angeles Lakers")
 *   c. team_aliases lookup, scoped to {awayTeamId, homeTeamId} when
 *      both are non-null. The aliasType is informational only — the
 *      resolver matches against the alias text regardless of whether
 *      it's a 'short', 'full', 'abbreviation', etc. row.
 *
 * No substring matching — that risk silent wrong-team selection on a
 * financial command and was explicitly removed in v2 of the proposal.
 *
 * Failure modes:
 *   - 0 matches → OspexValidationError('unknown_side' or 'unknown_team').
 *   - both teams match (each by a different alias entry) → fail closed
 *     with a 'ambiguous_team' error — this is a data-quality issue.
 *
 * The contest scoping is what makes alias matching safe. Cross-league
 * "Hawks" → ATL Hawks vs Seahawks vs Blackhawks ambiguity cannot apply
 * here because the contest is already pinned and only its two teams
 * are candidates.
 */

import { OspexValidationError } from '../errors.js';
import type { MarketType } from '../types/odds.js';
import type { ResolutionSource, SideRole } from '../types/preview.js';

/** Wire shape of a single team_aliases row from the SDK Teams API. */
export interface TeamAlias {
  teamId: string;
  alias: string;
  aliasType: string;
}

/**
 * Slice of a contest's parent context the resolver needs. Both team
 * strings are always available (the indexer captures them at
 * CONTEST_CREATED time). team_ids are populated when a games-row
 * linkage exists; nulls disable the alias-matching fallback.
 */
export interface ContestContextForResolve {
  awayTeam: string;
  homeTeam: string;
  awayTeamId: string | null;
  homeTeamId: string | null;
}

export interface ResolveSideResult {
  positionType: 0 | 1;
  resolvedLabel: string;
  role: SideRole;
  resolutionSource: ResolutionSource;
}

const TOTAL_OVER = new Set(['over', 'o', 'o/u over']);
const TOTAL_UNDER = new Set(['under', 'u', 'o/u under']);

function normalize(input: string): string {
  return input.toLowerCase().trim().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

function lastTokenMatches(normalizedInput: string, teamName: string): boolean {
  // Lower-case the last alpha word of the team name, e.g. "Los Angeles Lakers" → "lakers".
  const tokens = teamName
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  const last = tokens[tokens.length - 1] as string;
  return last === normalizedInput;
}

function fullNameMatches(normalizedInput: string, teamName: string): boolean {
  return teamName.toLowerCase() === normalizedInput;
}

interface ContestMatch {
  role: 'away' | 'home';
  teamName: string;
  source: ResolutionSource;
}

function resolveTotalSide(input: string): ResolveSideResult {
  const normalized = normalize(input);
  if (TOTAL_OVER.has(normalized)) {
    return {
      positionType: 0,
      resolvedLabel: 'over',
      role: 'over',
      resolutionSource: 'over',
    };
  }
  if (TOTAL_UNDER.has(normalized)) {
    return {
      positionType: 1,
      resolvedLabel: 'under',
      role: 'under',
      resolutionSource: 'under',
    };
  }
  throw new OspexValidationError(
    `Invalid total side "${input}". Expected "over" or "under".`,
  );
}

function resolveTeamSide(
  input: string,
  context: ContestContextForResolve,
  aliases: TeamAlias[],
): ResolveSideResult {
  const normalized = normalize(input);
  if (normalized.length === 0) {
    throw new OspexValidationError('Side input cannot be empty.');
  }

  const matches: ContestMatch[] = [];
  // (a) exact full-name match
  if (fullNameMatches(normalized, context.awayTeam)) {
    matches.push({ role: 'away', teamName: context.awayTeam, source: 'exact' });
  }
  if (fullNameMatches(normalized, context.homeTeam)) {
    matches.push({ role: 'home', teamName: context.homeTeam, source: 'exact' });
  }
  // (b) last-token nickname match — only if no exact match yet
  if (matches.length === 0) {
    if (lastTokenMatches(normalized, context.awayTeam)) {
      matches.push({ role: 'away', teamName: context.awayTeam, source: 'nickname' });
    }
    if (lastTokenMatches(normalized, context.homeTeam)) {
      matches.push({ role: 'home', teamName: context.homeTeam, source: 'nickname' });
    }
  }
  // (c) alias-table lookup, contest-scoped — only if no exact/nickname match yet
  if (matches.length === 0 && context.awayTeamId !== null && context.homeTeamId !== null) {
    for (const a of aliases) {
      if (a.alias.toLowerCase() !== normalized) continue;
      if (a.teamId === context.awayTeamId) {
        matches.push({ role: 'away', teamName: context.awayTeam, source: 'alias' });
      } else if (a.teamId === context.homeTeamId) {
        matches.push({ role: 'home', teamName: context.homeTeam, source: 'alias' });
      }
    }
  }

  if (matches.length === 0) {
    throw new OspexValidationError(
      `Could not resolve side "${input}" against ${context.awayTeam} (away) or ${context.homeTeam} (home).`,
    );
  }
  // Both away and home matched — data-quality issue, fail closed.
  const distinctRoles = new Set(matches.map((m) => m.role));
  if (distinctRoles.size > 1) {
    throw new OspexValidationError(
      `Side "${input}" ambiguously matched both ${context.awayTeam} and ${context.homeTeam}. ` +
        'This is a data-quality issue — file an alias triage ticket.',
    );
  }
  // De-duplicate by role (alias step can produce multiple matches on the same team).
  const first = matches[0] as ContestMatch;
  return {
    positionType: first.role === 'away' ? 0 : 1,
    resolvedLabel: first.teamName,
    role: first.role,
    resolutionSource: first.source,
  };
}

export function resolveSide(
  input: string,
  market: MarketType,
  context: ContestContextForResolve,
  aliases: TeamAlias[],
): ResolveSideResult {
  if (market === 'total') return resolveTotalSide(input);
  return resolveTeamSide(input, context, aliases);
}
