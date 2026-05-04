/**
 * Typed wrapper around the contest read endpoints on core-api:
 *
 *   - `GET /v1/markets`             → list of Contests
 *   - `GET /v1/markets/:contestId`  → single Contest with orderbook
 *   - `GET /v1/contests/scripts/approved` → script approvals (M4)
 *
 * The wider contests namespace (create/score/waitForVerified) lives at
 * `src/contests/`; this file is the API-layer adapter so reads stay
 * parallel to other api/* files (positions, commitments, etc.).
 *
 * The HTTP paths still say `/v1/markets` because that's a core-api
 * decision, not the SDK's. The SDK exposes the renamed
 * `client.contests.{list, get}` surface on top.
 */
import type { ApiClient } from './client.js';
import type { Commitment } from '../types/commitment.js';
import type {
  ApprovedScripts,
  Contest,
  ContestsListOptions,
  ScriptApproval,
  Speculation,
} from '../types/contest.js';
import type {
  ApprovedScriptsBody,
  CommitmentBody,
  ContestBody,
  ContestsListBody,
  ScriptApprovalEntryBody,
  SpeculationBody,
} from './types.js';
import type { Hex } from '../types/signer.js';

export class ContestsApi {
  constructor(private readonly client: ApiClient) {}

  async list(options: ContestsListOptions = {}): Promise<Contest[]> {
    const query: Record<string, string | number | undefined> = {};
    if (options.sport !== undefined) query.sport = options.sport;
    if (options.status !== undefined) query.status = options.status;
    if (options.hours !== undefined) query.window = options.hours;
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.offset !== undefined) query.offset = options.offset;
    const body = await this.client.request<ContestsListBody>('/v1/markets', { query });
    return body.markets.map(toContest);
  }

  async get(contestId: string | number): Promise<Contest> {
    const body = await this.client.request<ContestBody>(
      `/v1/markets/${encodeURIComponent(String(contestId))}`,
    );
    return toContest(body);
  }

  async scripts(): Promise<ApprovedScripts> {
    const body = await this.client.request<ApprovedScriptsBody>(
      '/v1/contests/scripts/approved',
    );
    return toApprovedScripts(body);
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
  if (body.verifySourceHash !== undefined) out.verifySourceHash = body.verifySourceHash;
  if (body.marketUpdateSourceHash !== undefined) out.marketUpdateSourceHash = body.marketUpdateSourceHash;
  if (body.scoreContestSourceHash !== undefined) out.scoreContestSourceHash = body.scoreContestSourceHash;
  if (body.awayScore !== undefined) out.awayScore = body.awayScore;
  if (body.homeScore !== undefined) out.homeScore = body.homeScore;
  if (body.contestCreatedAt !== undefined) out.contestCreatedAt = body.contestCreatedAt;
  if (body.verifiedAt !== undefined) out.verifiedAt = body.verifiedAt;
  if (body.scoredAt !== undefined) out.scoredAt = body.scoredAt;
  if (body.voidedAt !== undefined) out.voidedAt = body.voidedAt;
  return out;
}

function toSpeculation(body: SpeculationBody): Speculation {
  const out: Speculation = {
    speculationId: body.speculationId,
    type: body.type,
    lineTicks: body.lineTicks,
    line: body.line,
    speculationStatus: body.speculationStatus,
  };
  if (body.awayLine !== undefined) out.awayLine = body.awayLine;
  if (body.homeLine !== undefined) out.homeLine = body.homeLine;
  if (body.orderbook !== undefined) out.orderbook = body.orderbook.map(toCommitment);
  return out;
}

function toCommitment(body: CommitmentBody): Commitment {
  return body satisfies Commitment;
}

function toApprovedScripts(body: ApprovedScriptsBody): ApprovedScripts {
  return {
    network: body.network,
    approvedSigner: body.approvedSigner as Hex,
    verify: toApprovalEntry(body.verify),
    marketUpdate: toApprovalEntry(body.marketUpdate),
    score: toApprovalEntry(body.score),
  };
}

function toApprovalEntry(body: ScriptApprovalEntryBody): ScriptApproval {
  return {
    scriptHash: body.scriptHash as Hex,
    purpose: body.purpose,
    leagueId: body.leagueId,
    version: body.version,
    validUntil: body.validUntil,
    signature: body.signature as Hex,
    sourceUrl: body.sourceUrl,
  };
}
