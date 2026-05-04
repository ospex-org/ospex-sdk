/**
 * `client.contests.get(contestId)` — reads the off-chain projected
 * contest record from core-api. Calls `GET /v1/markets/:contestId`,
 * which returns every contest field plus the orderbook-populated
 * speculations the M4 surface needs (no separate /v1/contests/:id
 * endpoint exists per pre-flight §4).
 */
import type { Contest } from '../types/contest.js';
import type { ContestsContext } from './context.js';

export function get(ctx: ContestsContext, contestId: string | number | bigint): Promise<Contest> {
  return ctx.contestsApi.get(typeof contestId === 'bigint' ? contestId.toString() : contestId);
}
