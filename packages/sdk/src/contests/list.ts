/**
 * `client.contests.list(opts?)` — lists upcoming contests via the
 * `GET /v1/markets` endpoint on core-api. The HTTP path stays under
 * `/v1/markets` for now; the SDK surface is contest-namespaced so it
 * mirrors the on-chain Contest entity.
 */
import type { Contest, ContestsListOptions } from '../types/contest.js';
import type { ContestsContext } from './context.js';

export function list(ctx: ContestsContext, options: ContestsListOptions = {}): Promise<Contest[]> {
  return ctx.contestsApi.list(options);
}
