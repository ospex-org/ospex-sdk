/**
 * Typed wrapper around the team-aliases endpoint on core-api:
 *
 *   GET /v1/teams/aliases?sport=<sport>?
 *
 * Used by `client.teams.aliases()` (caching wrapper) which the SDK's
 * commitment resolver consults to map free-form `--side` input
 * ("Lakers", "LAL") to a canonical team_id. The endpoint is paginated
 * (default page size 2000); table is ~1300+ rows but PostgREST's
 * default page is 1000, so we paginate until `hasMore=false` to
 * guarantee the full set is returned.
 */

import type { ApiClient } from './client.js';
import type { TeamAliasBody, TeamAliasesListBody } from './types.js';

export interface TeamAliasesQuery {
  sport?: string;
}

export class TeamsApi {
  constructor(private readonly client: ApiClient) {}

  /**
   * Returns the full list of alias rows matching the optional sport
   * filter, paging through all pages. Response order is by team_id
   * then alias (server-side).
   */
  async aliases(opts: TeamAliasesQuery = {}): Promise<TeamAliasBody[]> {
    const all: TeamAliasBody[] = [];
    let offset = 0;
    const limit = 2000;
    // Loop guard: a misbehaving server that always returns hasMore=true
    // could spin forever. Cap at 100 pages × 2000 = 200k rows; the
    // table is ~1300 today, so this is two orders of magnitude of
    // headroom while still bounded.
    const MAX_PAGES = 100;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string | number | undefined> = { limit, offset };
      if (opts.sport !== undefined) query.sport = opts.sport;
      const body = await this.client.request<TeamAliasesListBody>('/v1/teams/aliases', { query });
      all.push(...body.aliases);
      if (!body.pagination.hasMore) return all;
      offset += body.aliases.length;
      // Defensive: if the server returns hasMore=true but no rows on
      // this page, break to avoid an infinite loop.
      if (body.aliases.length === 0) return all;
    }
    return all;
  }
}
