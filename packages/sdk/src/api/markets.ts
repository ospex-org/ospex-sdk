import type { ApiClient } from './client.js';
import type { Commitment } from '../types/commitment.js';
import type { Market, MarketsListOptions, MarketSpeculation } from '../types/market.js';
import type { CommitmentBody, MarketBody, MarketsListBody, MarketSpeculationBody } from './types.js';

export class MarketsApi {
  constructor(private readonly client: ApiClient) {}

  async list(options: MarketsListOptions = {}): Promise<Market[]> {
    const query: Record<string, string | number | undefined> = {};
    if (options.sport !== undefined) query.sport = options.sport;
    if (options.status !== undefined) query.status = options.status;
    if (options.hours !== undefined) query.window = options.hours;
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.offset !== undefined) query.offset = options.offset;
    const body = await this.client.request<MarketsListBody>('/v1/markets', { query });
    return body.markets.map(toMarket);
  }

  async get(contestId: string | number): Promise<Market> {
    const body = await this.client.request<MarketBody>(
      `/v1/markets/${encodeURIComponent(String(contestId))}`,
    );
    return toMarket(body);
  }
}

function toMarket(body: MarketBody): Market {
  const out: Market = {
    contestId: body.contestId,
    awayTeam: body.awayTeam,
    homeTeam: body.homeTeam,
    sport: body.sport,
    sportId: body.sportId,
    matchTime: body.matchTime,
    status: body.status,
    speculations: body.speculations.map(toMarketSpeculation),
  };
  if (body.jsonoddsId !== undefined) out.jsonoddsId = body.jsonoddsId;
  return out;
}

function toMarketSpeculation(body: MarketSpeculationBody): MarketSpeculation {
  const out: MarketSpeculation = {
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
