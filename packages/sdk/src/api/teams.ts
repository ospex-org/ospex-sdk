/**
 * Typed wrapper around the team-aliases endpoint on core-api:
 *
 *   GET /v1/teams/aliases?sport=<sport>?
 *
 * Used by `client.teams.aliases()` (caching wrapper) which the SDK's
 * commitment resolver consults to map free-form `--side` input
 * ("Lakers", "LAL") to a canonical team_id. The endpoint enforces a
 * hard cap of 1000 rows per request — see `MAX_LIMIT` in
 * `ospex-core-api/src/v1/teams.ts`. PostgREST silently truncates above
 * 1000, so the API rejects larger `limit` values with HTTP 400 to
 * prevent naive `offset += pagination.limit` clients from skipping
 * rows. The `team_aliases` table is ~1300+ rows today, so a full
 * fetch is two round-trips. We paginate until `hasMore=false` to
 * guarantee the full set is returned.
 */

import { OspexAPIError } from '../errors.js';
import type { ApiClient } from './client.js';
import type { TeamAliasBody, TeamAliasesListBody } from './types.js';

export interface TeamAliasesQuery {
  sport?: string;
}

const MAX_PAGES = 100;

export class TeamsApi {
  constructor(private readonly client: ApiClient) {}

  /**
   * Returns the full list of alias rows matching the optional sport
   * filter, paging through all pages until `hasMore=false`. Response
   * order is by team_id then alias (server-side).
   *
   * **Fails closed on stalled pagination.** Two pathological server
   * states throw `OspexAPIError` rather than returning partial data:
   *
   *   1. `hasMore=true` with an empty page (server bug — never expected).
   *   2. `MAX_PAGES` (100 × 1000 = 100k rows) reached while the server
   *      still says `hasMore=true`. The current `team_aliases` table is
   *      ~2k rows; hitting the cap means something is fundamentally
   *      wrong with the server response.
   *
   * Returning partial alias data would silently corrupt the SDK's
   * resolver: a missing alias row could either hide a valid match
   * (resolver fails when it shouldn't) or hide an ambiguity-causing
   * row (resolver picks wrong without realizing). Fail-closed surfaces
   * the issue immediately and avoids poisoning `Teams`'s 5-minute
   * cache (the cache is only set after this resolves).
   */
  async aliases(opts: TeamAliasesQuery = {}): Promise<TeamAliasBody[]> {
    const all: TeamAliasBody[] = [];
    let offset = 0;
    const limit = 1000;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string | number | undefined> = { limit, offset };
      if (opts.sport !== undefined) query.sport = opts.sport;
      const body = await this.client.request<TeamAliasesListBody>('/v1/teams/aliases', { query });
      all.push(...body.aliases);
      if (!body.pagination.hasMore) return all;
      if (body.aliases.length === 0) {
        throw new OspexAPIError(
          'Team aliases pagination stalled: server returned hasMore=true with an empty page. ' +
            'Refusing to return a partial alias table — the resolver requires the complete set.',
          { path: '/v1/teams/aliases' },
        );
      }
      offset += body.aliases.length;
    }
    throw new OspexAPIError(
      `Team aliases pagination exceeded ${MAX_PAGES} pages while the server still reported hasMore=true. ` +
        'Refusing to return a partial alias table.',
      { path: '/v1/teams/aliases' },
    );
  }
}
