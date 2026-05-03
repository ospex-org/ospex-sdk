/**
 * `client.contests.list(opts?)` — lists upcoming contests via the
 * existing `/v1/markets` endpoint. Identical surface to MarketsApi.list;
 * exposed under `contests` so operators have a contest-namespaced verb.
 */
import type { Market, MarketsListOptions } from '../types/market.js';
import type { ContestsContext } from './context.js';

export function list(ctx: ContestsContext, options: MarketsListOptions = {}): Promise<Market[]> {
  return ctx.marketsApi.list(options);
}
