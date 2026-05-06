/**
 * Public types for the games surface.
 *
 * The `gameId` is the row's `jsonodds_id` from the writer-managed
 * `games` table — part of the (network, jsonodds_id) primary key,
 * immutable for the row's lifetime. `slug` is the writer's
 * human-readable form (e.g. `lal-okc-2026-05-05`); it's exposed for
 * display but is mutable (the writer renames slugs on doubleheader
 * detect / reschedule), so anything that stores an identifier between
 * calls MUST use `gameId`.
 *
 * `externalIds` exposes all three feed identifiers needed by
 * `OracleModule.createContestFromOracle`. End-user-facing tools should
 * generally hide them from display — the canonical UX is "user passes
 * gameId; SDK fetches externalIds; SDK builds the contract call." The
 * field is kept on the public type for symmetry with the existing
 * Contest type and to support advanced consumers that want to see them.
 */

export type GameSport = 'mlb' | 'nba' | 'ncaab' | 'ncaaf' | 'nfl' | 'nhl';
export type GameStatus = 'upcoming' | 'live' | 'final' | 'postponed' | 'cancelled';

export interface GameTeam {
  name: string;
  abbreviation: string;
}

export interface GameExternalIds {
  jsonodds: string;
  sportspage: string | null;
  rundown: string | null;
}

export interface Game {
  gameId: string;
  slug: string;
  sport: GameSport;
  matchTime: string;
  status: GameStatus;
  homeTeam: GameTeam;
  awayTeam: GameTeam;
  hasOdds: boolean;
  contestCreated: boolean;
  contestId: string | null;
  canCreateContest: boolean;
  externalIds: GameExternalIds;
}

export interface GamesListOptions {
  sport?: GameSport;
  /** Window in hours to look ahead. Default 168 (one week), max 720. */
  hours?: number;
  /** Default true — only games with all three external IDs and contestCreated=false and status=upcoming. */
  availableOnly?: boolean;
  limit?: number;
  offset?: number;
}
