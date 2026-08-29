/**
 * Typed wrapper around the speculations read endpoints on core-api:
 *
 *   - `GET /v1/speculations`                       → list with filters
 *   - `GET /v1/speculations/:speculationId`        → single with orderbook + parent contest context
 *
 * Speculation is a first-class entity (mirrors the on-chain `Speculation`
 * struct). For the in-contest view (every speculation under a contest,
 * with their orderbooks), use `client.contests.get(contestId)`.
 */
import { z } from 'zod';
import type { ApiClient } from './client.js';
import type {
  Speculation,
  SpeculationDetail,
  SpeculationParentContext,
  SpeculationsListOptions,
} from '../types/contest.js';
import { CommitmentWireSchema, toCommitment } from './commitments.js';
import { SpeculationRowSchema, toSpeculation } from './contests.js';
import { parseWire } from '../wireSchema.js';
import type { Subscription } from '../types/odds.js';
import type { SpeculationsSubscribeFilters, StreamSubscribeHandlers } from '../types/stream.js';
import { subscribeToStream } from '../realtime/stream.js';
import { normalizeUint } from '../realtime/filters.js';

// ── wire schemas: the `/v1/speculations` decode boundaries ──────────────
//
// The flat speculation fields are declared once, in `api/contests.ts`
// beside `toSpeculation` (the mapper they type), and reused here. What is
// local to this file is the parent-contest context block and the two body
// envelopes.
//
// Same rule as every other boundary: types, not content. No `.min(1)` —
// `''` is core-api's sentinel on nine of the context's ten strings. No
// `.datetime()` — core-api passes `settledAt` through from PostgREST, so it
// carries the `+00:00` form zod v3's Z-only `.datetime()` refuses. And no
// `.default(...)` anywhere: every mapper copies on `!== undefined`, so a
// default would turn an absent wire key into a minted own-property and
// break the additivity the parent-context tests pin.

/**
 * The parent-contest context block on `GET /v1/speculations/:id`.
 *
 * Ten of the twelve keys are `''`-sentinelled strings; `awayTeamId` /
 * `homeTeamId` are the only nullable pair (null when the contest has no
 * JSONOdds linkage, the games row is missing, or the games lookup failed).
 *
 * Both team ids are `.optional()` as well as `.nullable()`, and that is the
 * shape the wire actually needs rather than the one the old interface
 * declared: a core-api predating the team-UUID join omits the keys
 * entirely, which is why `toContext` reads them with `?? null`. Declaring
 * them required — as the deleted `SpeculationParentContextBody` did —
 * refuses every body that build serves.
 */
const SpeculationParentContextSchema = z.object({
  contestId: z.string(),
  awayTeam: z.string(),
  homeTeam: z.string(),
  awayTeamId: z.string().nullable().optional(),
  homeTeamId: z.string().nullable().optional(),
  sport: z.string(),
  matchTime: z.string(),
  // The same five `''`-sentinelled companions as the contest surfaces,
  // optional because older builds omit the keys. `null` is NOT a value here.
  chainStartTime: z.string().optional(),
  gameMatchTime: z.string().optional(),
  gameEarliestMatchTime: z.string().optional(),
  gameRundownMatchTime: z.string().optional(),
  gameSportspageMatchTime: z.string().optional(),
  status: z.string(),
});

type SpeculationParentContextWire = z.infer<typeof SpeculationParentContextSchema>;

/** `GET /v1/speculations` — the paginated form (no `?since=`). */
const SpeculationsListBodySchema = z.object({
  speculations: z.array(SpeculationRowSchema),
  pagination: z.object({
    limit: z.number(),
    offset: z.number(),
    total: z.number(),
    hasMore: z.boolean(),
  }),
});

/**
 * `GET /v1/speculations/:speculationId` — the flat speculation fields at the
 * body root, plus `orderbook` and `contest`.
 *
 * `orderbook` is REQUIRED here, unlike the contest embed's. core-api
 * initialises it to `[]` before the branch that populates it and spreads it
 * in unconditionally, so the key is always on the wire — and the mapper's
 * former `?? []` fallback was worse than a refusal: on an ORDERBOOK,
 * fabricating `[]` from a missing key reports "no liquidity", which is a
 * wrong answer rather than a missing one. A body without the key now throws
 * with `field: 'orderbook'`.
 *
 * Its element is the full union: this endpoint surfaces a hidden row
 * REDACTED (the contest embed drops one instead), so a schema restricted to
 * the visible arm would refuse a body core-api is designed to serve.
 */
const SpeculationDetailBodySchema = SpeculationRowSchema.extend({
  orderbook: z.array(CommitmentWireSchema),
  contest: SpeculationParentContextSchema,
});

export class SpeculationsApi {
  constructor(private readonly client: ApiClient) {}

  async list(options: SpeculationsListOptions = {}): Promise<Speculation[]> {
    const query: Record<string, string | number | undefined> = {};
    if (options.contestId !== undefined) query.contestId = String(options.contestId);
    if (options.sport !== undefined) query.sport = options.sport;
    if (options.status !== undefined) query.status = options.status;
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.offset !== undefined) query.offset = options.offset;
    const raw = await this.client.request<unknown>('/v1/speculations', { query });
    return parseWire(SpeculationsListBodySchema, raw).speculations.map(toSpeculation);
  }

  async get(speculationId: string | number): Promise<SpeculationDetail> {
    const raw = await this.client.request<unknown>(
      `/v1/speculations/${encodeURIComponent(String(speculationId))}`,
    );
    const body = parseWire(SpeculationDetailBodySchema, raw);
    const base = toSpeculation(body);
    return {
      ...base,
      // `orderbook` is optional on the shared speculation shape (a contest
      // embed's may be absent) but required by this endpoint's schema, so
      // the map needs no fallback. Mapped explicitly so the return type
      // satisfies SpeculationDetail.
      orderbook: body.orderbook.map(toCommitment),
      contest: toContext(body.contest),
    };
  }

  /**
   * Subscribe to live speculation deltas (SSE), optionally scoped to a
   * `contestId`. Delivers a snapshot of current speculations via `onSnapshot`,
   * then live `onDelta` rows (status/line changes). Apply last-received-wins
   * per `speculationId`. The stream body omits `orderbook` (commitments have
   * their own stream). The snapshot is a single bounded page (≤ 500).
   */
  async subscribe(
    filters: SpeculationsSubscribeFilters,
    handlers: StreamSubscribeHandlers<Speculation>,
  ): Promise<Subscription> {
    const contestId = normalizeUint(filters.contestId, 'contestId');
    const listOpts: SpeculationsListOptions = { limit: 500 };
    if (contestId !== undefined) listOpts.contestId = contestId;
    return subscribeToStream<Speculation>({
      api: this.client,
      resource: 'speculations',
      filters: { contestId },
      // The stream/recovery frame is the list row minus `closing` (which no
      // mapper reads and zod strips), so it decodes through the SAME row
      // schema — a frame the list endpoint would accept is accepted here.
      // That equality is what keeps this boundary safe: a decode throw on a
      // stream is NOT surfaced to the caller — `subscribeToStream` catches
      // it, emits `connection_failed` on `onError`, and SKIPS the delta — so
      // a schema tightened past what core-api serves loses real speculation
      // updates silently.
      decode: (body) => toSpeculation(parseWire(SpeculationRowSchema, body)),
      snapshot: () => this.list(listOpts),
      handlers,
    });
  }
}

function toContext(body: SpeculationParentContextWire): SpeculationParentContext {
  const out: SpeculationParentContext = {
    contestId: body.contestId,
    awayTeam: body.awayTeam,
    homeTeam: body.homeTeam,
    // Defensive on missing fields: a core-API version that predates
    // the team-UUID join returns no team_id keys; coerce to null so
    // downstream resolver code can treat both states identically.
    awayTeamId: body.awayTeamId ?? null,
    homeTeamId: body.homeTeamId ?? null,
    sport: body.sport,
    matchTime: body.matchTime,
    status: body.status,
  };
  // Conditional copy per `exactOptionalPropertyTypes`: the start-time
  // companions stay absent (not coerced) against older core-api builds.
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
  return out;
}
