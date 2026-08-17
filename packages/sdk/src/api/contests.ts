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
import { z } from 'zod';
import type { ApiClient } from './client.js';
import { toCommitment } from './commitments.js';
import { parseWire } from '../wireSchema.js';
import type {
  Contest,
  ContestsListOptions,
  Speculation,
} from '../types/contest.js';
import type {
  ContestBody,
  SpeculationBody,
} from './types.js';

// ── wire schema: the `GET /v1/contests` (list) decode boundary ──────────
//
// The list body is validated through `parseWire()` per the repo hard rule:
// a mistyped field in an untrusted wire body must fail as a typed
// `OspexValidationError`, never propagate into the public `Contest` (the
// concrete hazard: a non-string `gameFinalType` flowing verbatim into the
// CLI's agent JSON payload). The schema enumerates exactly the fields the
// list mapper copies; zod's default unknown-key strip drops everything
// else, so new server fields still can't break a deployed SDK.
//
// Tolerances mirror the mapper's documented ones: the settlement trio is
// optional (a pre-#41 core-api omits it — `toSpeculation` degrades to
// null/false), the start-time companions + `gameFinalType` are optional
// (older builds / non-dated listings omit the keys), and the game identity
// pair `gameId` / `jsonoddsId` is optional-nullable (core-api builds ≥ the
// game-identity change serve both on every list row, `null` when the
// contest has no JSONOdds linkage; older builds omit the keys).
//
// The DETAIL read (`get`) keeps the pre-existing cast+copy decode: its
// body embeds per-speculation orderbooks of signed commitments — a much
// wider surface whose schema boundary is a deliberate separate change,
// not a rider on the list fix.
const SpeculationListRowSchema = z.object({
  speculationId: z.string(),
  contestId: z.string(),
  type: z.enum(['moneyline', 'spread', 'total']),
  lineTicks: z.number().nullable(),
  line: z.number().nullable(),
  awayLine: z.number().optional(),
  homeLine: z.number().optional(),
  speculationStatus: z.union([z.literal(0), z.literal(1)]),
  winSide: z.enum(['away', 'home', 'over', 'under', 'push', 'void']).nullable().optional(),
  settledAt: z.string().nullable().optional(),
  voided: z.boolean().optional(),
});

const ContestListRowSchema = z.object({
  contestId: z.string(),
  awayTeam: z.string(),
  homeTeam: z.string(),
  sport: z.string(),
  sportId: z.number(),
  matchTime: z.string(),
  chainStartTime: z.string().optional(),
  gameMatchTime: z.string().optional(),
  gameEarliestMatchTime: z.string().optional(),
  gameFinalType: z.string().optional(),
  gameId: z.string().nullable().optional(),
  jsonoddsId: z.string().nullable().optional(),
  status: z.string(),
  speculations: z.array(SpeculationListRowSchema),
});

const ContestsListBodySchema = z.object({
  contests: z.array(ContestListRowSchema),
  pagination: z.object({
    limit: z.number(),
    offset: z.number(),
    total: z.number(),
    hasMore: z.boolean(),
  }),
});

export class ContestsApi {
  constructor(private readonly client: ApiClient) {}

  async list(options: ContestsListOptions = {}): Promise<Contest[]> {
    const query: Record<string, string | number | undefined> = {};
    if (options.sport !== undefined) query.sport = options.sport;
    if (options.status !== undefined) query.status = options.status;
    if (options.hours !== undefined) query.window = options.hours;
    // Dated discovery — the API's UTC-day window param. Mutually exclusive
    // with `window` server-side; the SDK passes both through untouched and
    // lets the API's 400 surface, so the two layers can't disagree.
    if (options.date !== undefined) query.date = options.date;
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.offset !== undefined) query.offset = options.offset;
    const raw = await this.client.request<unknown>('/v1/contests', { query });
    const body = parseWire(ContestsListBodySchema, raw);
    // Mapped from the PARSED value, so the schema is the single enumeration
    // of what a list row can carry. The cast bridges zod's `?: T | undefined`
    // optional inference to `ContestBody`'s exact-optional keys — safe here
    // because the runtime check just ran, and JSON can't encode `undefined`.
    return body.contests.map((c) => toContest(c as ContestBody));
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
  // Conditional copy per `exactOptionalPropertyTypes`: only set keys the
  // body actually carried. The start-time companions are served on both
  // list and detail, but absent against core-api builds predating them.
  if (body.chainStartTime !== undefined) out.chainStartTime = body.chainStartTime;
  if (body.gameMatchTime !== undefined) out.gameMatchTime = body.gameMatchTime;
  if (body.gameEarliestMatchTime !== undefined) {
    out.gameEarliestMatchTime = body.gameEarliestMatchTime;
  }
  // Dated-list-only: `GET /v1/contests?date=` rows carry the linked game's
  // finality; every other contest surface omits the key.
  if (body.gameFinalType !== undefined) out.gameFinalType = body.gameFinalType;
  // Game identity. `gameId` arrives on list rows (core-api ≥ the
  // game-identity change); `jsonoddsId` on detail reads too. `null` is a
  // VALUE here (no linkage) and is copied — only an absent key stays
  // absent, per `exactOptionalPropertyTypes`.
  if (body.gameId !== undefined) out.gameId = body.gameId;
  if (body.jsonoddsId !== undefined) out.jsonoddsId = body.jsonoddsId;
  // Detail-endpoint-only fields — the list endpoint omits them entirely.
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
