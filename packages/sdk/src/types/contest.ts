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
 *
 * `ScriptApproval` / `ApprovedScripts` mirror what core-api returns
 * from `GET /v1/contests/scripts/approved` and what the SDK feeds into
 * `OracleModule.createContestFromOracle`'s `approvals` calldata struct.
 */

import type { Commitment } from './commitment.js';
import type { MarketType } from './odds.js';
import type { Network } from './protocol.js';
import type { Hex } from './signer.js';

export type ContestStatus = 'unverified' | 'verified' | 'scored' | 'voided';

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
  /** 0 = open (taking commitments), 1 = closed (settled or scored). */
  speculationStatus: 0 | 1;
  orderbook?: Commitment[];
}

/**
 * Small parent contest context attached by `client.speculations.get`.
 * The common "what game is this on?" question — source hashes /
 * lifecycle timestamps stay on the contest detail endpoint. Team
 * UUIDs come from the games-row join; null when no game linkage exists.
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
  /** ISO-8601 string. */
  matchTime: string;
  status: string;
  speculations: Speculation[];
  // ── Detail-endpoint-only fields ───────────────────────────────────
  /**
   * Upstream JSONOdds ID. Null when the contest has no JSONOdds
   * linkage. Required for opening a `current_odds` Realtime channel.
   */
  jsonoddsId?: string | null;
  /** External Rundown id the contest was created against. */
  rundownId?: string | null;
  /** External Sportspage id the contest was created against. */
  sportspageId?: string | null;
  /** Wallet that called createContestFromOracle. Lower-case hex string. */
  contestCreator?: string;
  /** Resolved league enum string ("nfl", "nba", … "unknown"). */
  leagueId?: string;
  /** keccak256 of the verify Chainlink Functions JS source. */
  verifySourceHash?: string | null;
  /** keccak256 of the market-update Chainlink Functions JS source. */
  marketUpdateSourceHash?: string | null;
  /** keccak256 of the score Chainlink Functions JS source. */
  scoreContestSourceHash?: string | null;
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

export interface ContestsListOptions {
  sport?: string;
  status?: string;
  /** Hours into the future. Defaults to API-side default (72h). */
  hours?: number;
  limit?: number;
  offset?: number;
}

export interface ScriptApproval {
  scriptHash: Hex;
  /** 0 = VERIFY, 1 = MARKET_UPDATE, 2 = SCORE. */
  purpose: 0 | 1 | 2;
  /** 0 = Unknown / wildcard. */
  leagueId: number;
  version: number;
  /** Unix seconds. 0 = permanent. */
  validUntil: number;
  signature: Hex;
  sourceUrl: string;
}

export interface ApprovedScripts {
  network: Network;
  approvedSigner: Hex;
  verify: ScriptApproval;
  marketUpdate: ScriptApproval;
  score: ScriptApproval;
}
