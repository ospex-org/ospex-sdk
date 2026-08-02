/**
 * Public types for the contests namespace.
 *
 * `Contest` is what `client.contests.list` and `client.contests.get`
 * return — the off-chain projected view of an on-chain Contest paired
 * with the array of Speculations (single bettable lines) registered
 * against it. The shape mirrors the on-chain `Contest` struct
 * (`OspexTypes.sol`), plus the teams / sport / matchTime fields the
 * indexer joins from upstream.
 *
 * `Speculation` is the embedded per-line entity. Mirrors the on-chain
 * `Speculation` struct.
 *
 * `ContestStatus` mirrors `OspexTypes.ContestStatus` (`unverified`,
 * `verified`, `scored`, `voided`) and matches the lowercase string in
 * `Contest.status`.
 */

import type { Commitment } from './commitment.js';
import type { MarketType } from './odds.js';

export type ContestStatus = 'unverified' | 'verified' | 'scored' | 'voided';

/**
 * On-chain `WinSide` enum. `'tbd'` is the pre-settlement sentinel; the SDK
 * never surfaces it — {@link Speculation.winSide} maps `'tbd'` to `null`.
 */
export type WinSide = 'tbd' | 'away' | 'home' | 'over' | 'under' | 'push' | 'void';

/** A settled `WinSide` — every value except the `'tbd'` sentinel. */
export type SettledWinSide = Exclude<WinSide, 'tbd'>;

/**
 * A single bettable line on a contest. Mirrors the on-chain
 * `Speculation` struct (`contestId` is field 1, hence always populated
 * here too — a Speculation is meaningful standalone).
 *
 * `lineTicks` is the raw int32 from chain (10× ticks); `line` is the
 * human-readable value (`lineTicks / 10`). `awayLine` / `homeLine` are
 * populated for spread speculations only.
 *
 * `orderbook` is undefined on list-style endpoints and populated when
 * fetched via `client.contests.get(contestId)` or
 * `client.speculations.get(speculationId)` — the latter also attaches
 * a parent `contest` block (see `SpeculationDetail`).
 */
export interface Speculation {
  speculationId: string;
  contestId: string;
  type: MarketType;
  lineTicks: number | null;
  line: number | null;
  awayLine?: number;
  homeLine?: number;
  /**
   * 0 = open (taking commitments), 1 = closed (settled on-chain via
   * `settleSpeculation`).
   */
  speculationStatus: 0 | 1;
  /**
   * The settled outcome, or `null` while the speculation is still open.
   * `'push'`/`'void'` are settled outcomes (non-null). For spread/total/push/void
   * this cannot be recomputed from the contest score alone, so it is the
   * authoritative winner signal.
   *
   * INVARIANT: `speculationStatus === 1` ⟺ `winSide !== null` (core-api projects
   * both from the same atomic row).
   */
  winSide: SettledWinSide | null;
  /** ISO-8601 timestamp of the on-chain settlement, or `null` while open. */
  settledAt: string | null;
  /** True iff the speculation settled to `void` (equivalently `winSide === 'void'`). */
  voided: boolean;
  orderbook?: Commitment[];
}

/**
 * Small parent contest context attached by `client.speculations.get`.
 * The common "what game is this on?" question — lifecycle timestamps
 * stay on the contest detail endpoint. Team UUIDs come from the
 * games-row join; null when no game linkage exists.
 */
export interface SpeculationParentContext {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  awayTeamId: string | null;
  homeTeamId: string | null;
  sport: string;
  /** ISO-8601 string. */
  matchTime: string;
  /**
   * Same three optional start-time companions as {@link Contest}
   * (`chainStartTime` / `gameMatchTime` / `gameEarliestMatchTime`) — see the
   * field docs there. Absent against core-api builds that predate them.
   */
  chainStartTime?: string;
  gameMatchTime?: string;
  gameEarliestMatchTime?: string;
  status: string;
}

/**
 * Returned by `client.speculations.get(speculationId)` — the speculation
 * with a guaranteed-populated orderbook plus the parent contest context.
 */
export interface SpeculationDetail extends Speculation {
  orderbook: Commitment[];
  contest: SpeculationParentContext;
}

export interface SpeculationsListOptions {
  /** Fast indexed path. */
  contestId?: string | number;
  sport?: string;
  /** 'open' (taking commitments) or 'closed' (settled/scored). */
  status?: 'open' | 'closed';
  limit?: number;
  offset?: number;
}

/**
 * Off-chain projected Contest — the contest-level entity bundled with
 * the array of Speculations registered against it. Detail-only fields
 * (jsonoddsId, rundownId, contestCreator, scores, lifecycle timestamps)
 * are populated only when fetched via `client.contests.get(contestId)`;
 * the list endpoint stays lean and leaves them undefined.
 */
export interface Contest {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  sport: string;
  sportId: number;
  /**
   * ISO-8601 string. The current conservative start-time safety bound — the
   * minimum over the chain start, the odds-feed schedule, and the game's
   * retained safety floor (the three companion fields below). Gate on this.
   */
  matchTime: string;
  // ── Start-time companion fields (list + detail) ───────────────────
  // All three are ISO-8601 strings with a `""` sentinel, mirroring the
  // core-api contest contract. Optional: absent (not `""`) against
  // core-api builds that predate them.
  /** Raw on-chain start. `""` until the contest is verified. */
  chainStartTime?: string;
  /** Raw odds-feed schedule for the linked game. `""` when no games row is linked. */
  gameMatchTime?: string;
  /**
   * The game's current retained start-time safety floor, verbatim — never
   * clamped (it is NOT guaranteed `<= gameMatchTime`); `""` when no games
   * row is linked. When it is the minimum of the three inputs, it is what
   * is driving `matchTime`.
   */
  gameEarliestMatchTime?: string;
  status: string;
  speculations: Speculation[];
  // ── Detail-endpoint-only fields ───────────────────────────────────
  /**
   * Upstream game id this contest is linked to (the writer's odds-provider
   * id). Null when the contest has no upstream linkage. Detail-endpoint-only.
   */
  jsonoddsId?: string | null;
  /** External Rundown id the contest was created against. */
  rundownId?: string | null;
  /** External Sportspage id the contest was created against. */
  sportspageId?: string | null;
  /** Wallet that called createContestAndRequestVerify. Lower-case hex string. */
  contestCreator?: string;
  /** Resolved league enum string ("nfl", "nba", … "unknown"). */
  leagueId?: string;
  /** Final away-team score, populated on CONTEST_SCORES_SET. */
  awayScore?: number | null;
  /** Final home-team score, populated on CONTEST_SCORES_SET. */
  homeScore?: number | null;
  /** ISO timestamp of CONTEST_CREATED projection. */
  contestCreatedAt?: string | null;
  /** ISO timestamp of CONTEST_VERIFIED projection. */
  verifiedAt?: string | null;
  /** ISO timestamp of CONTEST_SCORES_SET projection. */
  scoredAt?: string | null;
  /** ISO timestamp of CONTEST_VOIDED projection. */
  voidedAt?: string | null;
  /**
   * Team UUIDs from `teams`, resolved server-side via the games-row
   * join. Detail-endpoint-only. Null when the contest has no
   * JSONOdds linkage or the games row is missing. Consumed by the
   * SDK resolver layer to scope alias matching.
   */
  awayTeamId?: string | null;
  homeTeamId?: string | null;
}

/**
 * The payload delivered by `client.contests.subscribe` — a contest's
 * lifecycle slice, not the full `Contest`. The stream exists to push
 * status / score / verified / scored / voided transitions; it deliberately
 * omits `speculations[]` (those have their own `speculations.subscribe`
 * stream) and the detail-only enrichment (`jsonoddsId`, source hashes,
 * team UUIDs, …) that only `contests.get` returns. Distinct from `Contest`
 * so a streamed lifecycle update can't be mistaken for a full detail row.
 */
export interface ContestUpdate {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  sport: string;
  sportId: number;
  /** ISO-8601 string. */
  matchTime: string;
  /**
   * Same three optional start-time companions as {@link Contest} (`""`
   * sentinels) — the stream body carries them too, so a floor raise or a
   * feed reschedule arrives on deltas, not just snapshots. Absent against
   * core-api builds that predate them.
   */
  chainStartTime?: string;
  gameMatchTime?: string;
  gameEarliestMatchTime?: string;
  status: string;
  awayScore: number | null;
  homeScore: number | null;
  /** ISO-8601 string. CONTEST_VERIFIED projection time. */
  verifiedAt: string | null;
  /** ISO-8601 string. CONTEST_SCORES_SET projection time. */
  scoredAt: string | null;
  /** ISO-8601 string. CONTEST_VOIDED projection time. */
  voidedAt: string | null;
  /** ISO-8601 string. CONTEST_CREATED projection time. */
  contestCreatedAt: string | null;
}

export interface ContestsListOptions {
  sport?: string;
  status?: string;
  /** Hours into the future. Defaults to API-side default (72h). */
  hours?: number;
  limit?: number;
  offset?: number;
}
