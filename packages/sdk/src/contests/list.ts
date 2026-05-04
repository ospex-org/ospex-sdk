/**
 * `client.contests.list(opts?)` — lists upcoming contests via the
 * `GET /v1/contests` endpoint on core-api.
 */
import type { Contest, ContestsListOptions } from '../types/contest.js';
import type { ContestsContext } from './context.js';

export function list(ctx: ContestsContext, options: ContestsListOptions = {}): Promise<Contest[]> {
  return ctx.contestsApi.list(options);
}
