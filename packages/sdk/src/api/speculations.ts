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
import type { ApiClient } from './client.js';
import type {
  Speculation,
  SpeculationDetail,
  SpeculationParentContext,
  SpeculationsListOptions,
} from '../types/contest.js';
import type {
  SpeculationBody,
  SpeculationDetailBody,
  SpeculationParentContextBody,
  SpeculationsListBody,
} from './types.js';
import { toCommitment } from './commitments.js';
import { toSpeculation } from './contests.js';
import type { Subscription } from '../types/odds.js';
import type { SpeculationsSubscribeFilters, StreamSubscribeHandlers } from '../types/stream.js';
import { subscribeToStream } from '../realtime/stream.js';

export class SpeculationsApi {
  constructor(private readonly client: ApiClient) {}

  async list(options: SpeculationsListOptions = {}): Promise<Speculation[]> {
    const query: Record<string, string | number | undefined> = {};
    if (options.contestId !== undefined) query.contestId = String(options.contestId);
    if (options.sport !== undefined) query.sport = options.sport;
    if (options.status !== undefined) query.status = options.status;
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.offset !== undefined) query.offset = options.offset;
    const body = await this.client.request<SpeculationsListBody>('/v1/speculations', { query });
    return body.speculations.map(toSpeculation);
  }

  async get(speculationId: string | number): Promise<SpeculationDetail> {
    const body = await this.client.request<SpeculationDetailBody>(
      `/v1/speculations/${encodeURIComponent(String(speculationId))}`,
    );
    const base = toSpeculation(body);
    return {
      ...base,
      // SpeculationBody.orderbook is optional for embedded use; the
      // /v1/speculations/:id detail endpoint always populates it. Map
      // explicitly so the return type satisfies SpeculationDetail.
      orderbook: (body.orderbook ?? []).map(toCommitment),
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
    const listOpts: SpeculationsListOptions = { limit: 500 };
    if (filters.contestId !== undefined) listOpts.contestId = filters.contestId;
    return subscribeToStream<Speculation>({
      api: this.client,
      resource: 'speculations',
      filters: { contestId: filters.contestId },
      decode: (body) => toSpeculation(body as SpeculationBody),
      snapshot: () => this.list(listOpts),
      handlers,
    });
  }
}

function toContext(body: SpeculationParentContextBody): SpeculationParentContext {
  return {
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
}
