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
import { CommitmentWireSchema, toCommitment } from './commitments.js';
import { parseWire } from '../wireSchema.js';
import type {
  Contest,
  ContestsListOptions,
  Speculation,
} from '../types/contest.js';

// ── wire schemas: the `/v1/contests` decode boundaries ──────────────────
//
// Both reads are validated through `parseWire()` per the repo hard rule:
// a mistyped field in an untrusted wire body must fail as a typed
// `OspexValidationError`, never propagate into the public `Contest` (the
// concrete hazard: a non-string `gameFinalType` flowing verbatim into the
// CLI's agent JSON payload). Each schema enumerates exactly the fields its
// endpoint serves; zod's default unknown-key strip drops everything else,
// so new server fields still can't break a deployed SDK.
//
// The two endpoints share their field DECLARATIONS through the shape
// constants below and nothing else, so a widened field moves both schemas
// and the mapper's input type together. The mapper's input type is
// `z.infer` of the detail schema — there is no hand-written `*Body`
// interface to drift against, which is the defect the games boundary was
// blocked on: while `GameBody` sat beside `GameBodySchema` with the parsed
// row cast to it, widening the schema's `gameId` to `.nullable()` passed
// `tsc` and the whole suite, and a `null` reached a field declared
// `string`.
//
// Tolerances mirror the mapper's documented ones, and every one of them is
// a real older-server shape rather than defensive padding: the settlement
// trio is optional (a pre-#41 core-api omits it — `toSpeculation` degrades
// to null/false), the start-time companions + `gameFinalType` are optional
// (older builds / non-dated listings omit the keys), the detail-only block
// is optional (older builds omit it; the current build always sends all of
// it), and the game identity pair `gameId` / `jsonoddsId` is
// optional-nullable.
//
// Types, not content. `.min(1)` is wrong on every contest-shaped string:
// core-api coalesces a missing value to `''` on nine of them, so a
// non-empty rule refuses a contest with no linked games row. `.datetime()`
// is wrong on every timestamp: PostgREST renders `timestamptz` with a
// `+00:00` offset and zod v3's `.datetime()` is Z-only. Enums on `sport` /
// `status` are exact today and wrong the moment a migration lands.

/** Present on every contest surface, list and detail alike. */
const contestCoreShape = {
  contestId: z.string(),
  awayTeam: z.string(),
  homeTeam: z.string(),
  sport: z.string(),
  sportId: z.number(),
  matchTime: z.string(),
  status: z.string(),
};

/**
 * The five start-time companions. `''` — never `null` — is core-api's
 * sentinel on contest surfaces for "not verified yet" / "no games row
 * linked"; `/v1/games` passes the same three ideas through as `null`. The
 * two conventions must not be unified.
 */
const contestStartTimeShape = {
  chainStartTime: z.string().optional(),
  gameMatchTime: z.string().optional(),
  gameEarliestMatchTime: z.string().optional(),
  gameRundownMatchTime: z.string().optional(),
  gameSportspageMatchTime: z.string().optional(),
};

/**
 * Detail-endpoint-only enrichment. The list body omits every one of these;
 * the current detail build sends all twelve unconditionally, and each is
 * `.optional()` only so an older build still decodes.
 *
 * The split between `''` and `null` here is core-api's, not a choice: the
 * two id strings and the lifecycle timestamps use `?? null`, while
 * `contestCreator` uses `?? ''` and `leagueId` uses `?? 'unknown'`.
 */
const contestDetailOnlyShape = {
  rundownId: z.string().nullable().optional(),
  sportspageId: z.string().nullable().optional(),
  contestCreator: z.string().optional(),
  leagueId: z.string().optional(),
  awayScore: z.number().nullable().optional(),
  homeScore: z.number().nullable().optional(),
  contestCreatedAt: z.string().nullable().optional(),
  verifiedAt: z.string().nullable().optional(),
  scoredAt: z.string().nullable().optional(),
  voidedAt: z.string().nullable().optional(),
  awayTeamId: z.string().nullable().optional(),
  homeTeamId: z.string().nullable().optional(),
};

/** The eleven flat fields every speculation body carries, on every surface. */
const speculationCoreShape = {
  speculationId: z.string(),
  contestId: z.string(),
  type: z.enum(['moneyline', 'spread', 'total']),
  lineTicks: z.number().nullable(),
  line: z.number().nullable(),
  // Emitted together, and only on a spread with a non-null line.
  awayLine: z.number().optional(),
  homeLine: z.number().optional(),
  speculationStatus: z.union([z.literal(0), z.literal(1)]),
  // The settlement trio. Always sent by a current core-api; `.optional()`
  // for a pre-#41 build, which `toSpeculation` degrades to null/false.
  winSide: z.enum(['away', 'home', 'over', 'under', 'push', 'void']).nullable().optional(),
  settledAt: z.string().nullable().optional(),
  voided: z.boolean().optional(),
};

/**
 * A speculation with no orderbook — a `/v1/contests` list row, a
 * `/v1/speculations` list row, and a speculations stream/recovery frame all
 * have exactly this shape. (The stream frame differs from the list row by
 * one key, `closing`, which no mapper reads and zod strips.)
 */
export const SpeculationRowSchema = z.object(speculationCoreShape);

/**
 * A speculation nested in a CONTEST detail body, and the shape
 * {@link toSpeculation} reads.
 *
 * `orderbook` is `.optional()` rather than required for the same
 * older-build tolerance as everything else here; the current build always
 * sends the key, `[]` included.
 *
 * Its element is the full commitment union even though this handler DROPS a
 * redacted row rather than surfacing one (a redacted body carries no
 * `speculationKey` to group on, so it has nothing to group under). Mirroring
 * that narrower server type would buy nothing — the public
 * `Speculation.orderbook` is already `Commitment[]`, the union — and would
 * cost a whole-contest `OspexValidationError` on the market-maker's
 * discovery path the day core-api surfaces one. Accepting a shape the server
 * does not currently send is free; refusing one it might is not.
 */
const SpeculationWireSchema = z.object({
  ...speculationCoreShape,
  orderbook: z.array(CommitmentWireSchema).optional(),
});
export type SpeculationWire = z.infer<typeof SpeculationWireSchema>;

const ContestListRowSchema = z
  .object({
    ...contestCoreShape,
    ...contestStartTimeShape,
    gameFinalType: z.string().optional(),
    // The identity pair is cross-validated below: the two keys arrive
    // together or not at all, and when present they are either both null or
    // the same non-empty string. Every other combination is a shape no known
    // server emits, and passing one through would let two consumers pick
    // different "canonical" identifiers from the same row.
    gameId: z.string().nullable().optional(),
    jsonoddsId: z.string().nullable().optional(),
    speculations: z.array(SpeculationRowSchema),
  })
  .superRefine((row, ctx) => {
    // Identity-pair contract. The accept set is exactly what real servers
    // emit: BOTH keys absent (a pre-identity core-api), BOTH null (no
    // linkage — the server normalizes '' to null), or the SAME non-empty
    // string. One-sided presence, unequal values, a null/string mix, and
    // empty strings are shapes no known server produces; each would let
    // two consumers choose different "canonical" identifiers from one
    // row, so the boundary refuses them instead of passing them through.
    const gamePresent = row.gameId !== undefined;
    const jsonoddsPresent = row.jsonoddsId !== undefined;
    if (!gamePresent && !jsonoddsPresent) return;
    if (gamePresent !== jsonoddsPresent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        // Point at the MISSING half of the pair.
        path: [gamePresent ? 'jsonoddsId' : 'gameId'],
        message: 'gameId and jsonoddsId must be served together (both keys or neither)',
      });
      return;
    }
    if (row.gameId === null && row.jsonoddsId === null) return;
    if (typeof row.gameId === 'string' && row.gameId !== '' && row.gameId === row.jsonoddsId) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['gameId'],
      message: 'gameId / jsonoddsId must both be null or the same non-empty string',
    });
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

/**
 * `GET /v1/contests/:contestId`.
 *
 * `gameId` is deliberately NOT declared. It is a LIST-row key — core-api's
 * detail handler never emits it — and leaving it out makes the "a detail
 * body cannot mint `Contest.gameId`" contract structural at three layers
 * instead of one: zod strips the key before the mapper sees it, the mapper's
 * input type has no such property so reading it is a compile error, and
 * `list()` attaches it after the shared mapper runs.
 *
 * The identity-pair `superRefine` is NOT lifted from the list schema
 * either, and that is a correctness point rather than an omission: the
 * detail handler coalesces `jsonodds_id` with `??` where the list handler
 * uses `||`, so a row whose column holds `''` is served as `''` here and as
 * `null` there. A non-empty rule borrowed from the list path would refuse a
 * body this endpoint actually serves.
 *
 * `gameFinalType` is NOT declared either, for the same reason and by the
 * same mechanism. It reaches the wire only on `GET /v1/contests?date=`
 * rows; declaring it here so the SHARED mapper could copy it let a detail
 * body mint a dated-list-only field, which the #207 review reproduced. It
 * is attached on the list path beside `gameId` now, so both list-only keys
 * are handled the same way and neither is reachable from `toContest`.
 */
const ContestDetailBodySchema = z.object({
  ...contestCoreShape,
  ...contestStartTimeShape,
  ...contestDetailOnlyShape,
  jsonoddsId: z.string().nullable().optional(),
  speculations: z.array(SpeculationWireSchema),
});

/**
 * The contest shape {@link toContest} reads — the detail body, which is the
 * superset. A list row is assignable to it: the keys it lacks are all
 * `.optional()`, and its speculations lack only the optional `orderbook`.
 */
type ContestWire = z.infer<typeof ContestDetailBodySchema>;

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
    // Mapped from the PARSED value with no cast, so the schema is the only
    // declaration of what a list row can carry: widen a field here and the
    // mapper's assignment into the public `Contest` stops compiling.
    return body.contests.map((row) => {
      const contest = toContest(row);
      // The two LIST-ROW-ONLY keys are attached HERE, never in the shared
      // `toContest` — whose input type declares neither, so the detail path
      // cannot mint one even from a body that carries it. `gameFinalType`
      // joined `gameId` here after the #207 review reproduced a detail body
      // minting it. Pinned in both directions (list surfaces them verbatim;
      // detail refuses to mint either).
      if (row.gameId !== undefined) contest.gameId = row.gameId;
      if (row.gameFinalType !== undefined) contest.gameFinalType = row.gameFinalType;
      return contest;
    });
  }

  async get(contestId: string | number): Promise<Contest> {
    const raw = await this.client.request<unknown>(
      `/v1/contests/${encodeURIComponent(String(contestId))}`,
    );
    return toContest(parseWire(ContestDetailBodySchema, raw));
  }
}

function toContest(body: ContestWire): Contest {
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
  if (body.gameRundownMatchTime !== undefined) {
    out.gameRundownMatchTime = body.gameRundownMatchTime;
  }
  if (body.gameSportspageMatchTime !== undefined) {
    out.gameSportspageMatchTime = body.gameSportspageMatchTime;
  }
  // Game identity. `jsonoddsId` arrives on detail reads and (since the
  // game-identity change) list rows; `null` is a VALUE here (no linkage)
  // and is copied — only an absent key stays absent, per
  // `exactOptionalPropertyTypes`. `gameId` and `gameFinalType` are
  // deliberately NOT copied by this shared mapper: both are list-row-only
  // keys, attached by `list()` after this mapper runs. `ContestWire`
  // declares neither, so adding a copy here does not compile.
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

export function toSpeculation(body: SpeculationWire): Speculation {
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
