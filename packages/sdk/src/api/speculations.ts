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
  SpeculationDetailBody,
  SpeculationParentContextBody,
  SpeculationsListBody,
} from './types.js';
import { toCommitment, toSpeculation } from './contests.js';

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
}

function toContext(body: SpeculationParentContextBody): SpeculationParentContext {
  return {
    contestId: body.contestId,
    awayTeam: body.awayTeam,
    homeTeam: body.homeTeam,
    sport: body.sport,
    matchTime: body.matchTime,
    status: body.status,
  };
}
