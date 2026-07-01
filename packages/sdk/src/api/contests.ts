/**
 * Typed wrapper around the contest read endpoints on core-api:
 *
 *   - `GET /v1/contests`                     → list of Contests
 *   - `GET /v1/contests/:contestId`          → single Contest with orderbook-populated speculations
 *
 * The wider contests namespace (create/score/waitForVerified) lives at
 * `src/contests/`; this file is the API-layer adapter so reads stay
 * parallel to other api/* files (positions, commitments, etc.).
 *
 * Speculations also have their own first-class endpoint family — see
 * `api/speculations.ts` and `client.speculations`.
 */
import type { ApiClient } from './client.js';
import { toCommitment } from './commitments.js';
import type {
  Contest,
  ContestsListOptions,
  Speculation,
} from '../types/contest.js';
import type {
  ContestBody,
  ContestsListBody,
  SpeculationBody,
} from './types.js';

export class ContestsApi {
  constructor(private readonly client: ApiClient) {}

  async list(options: ContestsListOptions = {}): Promise<Contest[]> {
    const query: Record<string, string | number | undefined> = {};
    if (options.sport !== undefined) query.sport = options.sport;
    if (options.status !== undefined) query.status = options.status;
    if (options.hours !== undefined) query.window = options.hours;
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.offset !== undefined) query.offset = options.offset;
    const body = await this.client.request<ContestsListBody>('/v1/contests', { query });
    return body.contests.map(toContest);
  }

  async get(contestId: string | number): Promise<Contest> {
    const body = await this.client.request<ContestBody>(
      `/v1/contests/${encodeURIComponent(String(contestId))}`,
    );
    return toContest(body);
  }
}

function toContest(body: ContestBody): Contest {
  const out: Contest = {
    contestId: body.contestId,
    awayTeam: body.awayTeam,
    homeTeam: body.homeTeam,
    sport: body.sport,
    sportId: body.sportId,
    matchTime: body.matchTime,
    status: body.status,
    speculations: body.speculations.map(toSpeculation),
  };
  // Conditional spread per `exactOptionalPropertyTypes`: only set keys
  // that the body actually carried. Detail endpoint populates these;
  // list endpoint omits them entirely.
  if (body.jsonoddsId !== undefined) out.jsonoddsId = body.jsonoddsId;
  if (body.rundownId !== undefined) out.rundownId = body.rundownId;
  if (body.sportspageId !== undefined) out.sportspageId = body.sportspageId;
  if (body.contestCreator !== undefined) out.contestCreator = body.contestCreator;
  if (body.leagueId !== undefined) out.leagueId = body.leagueId;
  if (body.awayScore !== undefined) out.awayScore = body.awayScore;
  if (body.homeScore !== undefined) out.homeScore = body.homeScore;
  if (body.contestCreatedAt !== undefined) out.contestCreatedAt = body.contestCreatedAt;
  if (body.verifiedAt !== undefined) out.verifiedAt = body.verifiedAt;
  if (body.scoredAt !== undefined) out.scoredAt = body.scoredAt;
  if (body.voidedAt !== undefined) out.voidedAt = body.voidedAt;
  if (body.awayTeamId !== undefined) out.awayTeamId = body.awayTeamId;
  if (body.homeTeamId !== undefined) out.homeTeamId = body.homeTeamId;
  return out;
}

export function toSpeculation(body: SpeculationBody): Speculation {
  const out: Speculation = {
    speculationId: body.speculationId,
    contestId: body.contestId,
    type: body.type,
    lineTicks: body.lineTicks,
    line: body.line,
    speculationStatus: body.speculationStatus,
    // `?? null` / `?? false` degrade gracefully if talking to a pre-#41
    // core-api that omits these; a current server always returns them, and
    // then speculationStatus===1 ⟺ winSide!==null holds.
    winSide: body.winSide ?? null,
    settledAt: body.settledAt ?? null,
    voided: body.voided ?? false,
  };
  if (body.awayLine !== undefined) out.awayLine = body.awayLine;
  if (body.homeLine !== undefined) out.homeLine = body.homeLine;
  if (body.orderbook !== undefined) out.orderbook = body.orderbook.map(toCommitment);
  return out;
}
