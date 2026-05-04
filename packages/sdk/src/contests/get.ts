/**
 * `client.contests.get(contestId)` — reads the off-chain projected
 * contest record from core-api. Calls `GET /v1/contests/:contestId`,
 * which returns every contest field plus the orderbook-populated
 * speculations the M4 surface needs.
 */
import type { Contest } from '../types/contest.js';
import type { ContestsContext } from './context.js';

export function get(ctx: ContestsContext, contestId: string | number | bigint): Promise<Contest> {
  return ctx.contestsApi.get(typeof contestId === 'bigint' ? contestId.toString() : contestId);
}
