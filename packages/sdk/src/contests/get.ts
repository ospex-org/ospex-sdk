/**
 * `client.contests.get(contestId)` — reads the off-chain projected
 * contest record from core-api. Delegates to MarketsApi.get since the
 * /v1/markets/:contestId response carries every contest field needed
 * for M4 (no separate /v1/contests/:id endpoint exists per pre-flight §4).
 */
import type { Market } from '../types/market.js';
import type { ContestsContext } from './context.js';

export function get(ctx: ContestsContext, contestId: string | number | bigint): Promise<Market> {
  return ctx.marketsApi.get(typeof contestId === 'bigint' ? contestId.toString() : contestId);
}
