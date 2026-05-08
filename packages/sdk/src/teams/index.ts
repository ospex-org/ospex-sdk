/**
 * Teams namespace — caching wrapper around `TeamsApi.aliases()`.
 *
 * Caches the alias table in memory per `OspexClient` instance with a
 * 5-minute TTL (matching `client.contests.scripts()`). The SDK's
 * resolver layer hits this on every prepareSubmit; without caching
 * each submit would round-trip ~1300+ rows.
 *
 * Cache key includes the optional sport filter — different filters
 * are cached independently so a CLI session that touches only one
 * sport doesn't pay the all-aliases cost.
 *
 * Use `invalidateCache()` after a known alias addition (rare — would
 * normally just wait out the 5-min TTL).
 */

import type { TeamsApi } from '../api/teams.js';
import type { TeamAlias } from '../commitments/resolveSide.js';

export interface TeamsAliasesArgs {
  sport?: string;
  /** Bypass cache and fetch fresh. Cache is updated with the result. */
  bypassCache?: boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  aliases: TeamAlias[];
  expiresAt: number;
}

export class Teams {
  // Map key: sport ?? '' (empty string for "all sports").
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly api: TeamsApi) {}

  /**
   * Fetch alias rows. Returns the resolver-shaped subset
   * (`{ teamId, alias, aliasType }`); call `aliasesRaw()` if you need
   * the full wire shape including team display fields.
   */
  async aliases(opts: TeamsAliasesArgs = {}): Promise<TeamAlias[]> {
    const key = opts.sport ?? '';
    const now = Date.now();
    if (!opts.bypassCache) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > now) return hit.aliases;
    }
    const fetched = await this.api.aliases(opts.sport === undefined ? {} : { sport: opts.sport });
    const aliases: TeamAlias[] = fetched.map((a) => ({
      teamId: a.teamId,
      alias: a.alias,
      aliasType: a.aliasType,
    }));
    this.cache.set(key, { aliases, expiresAt: now + CACHE_TTL_MS });
    return aliases;
  }

  invalidateCache(): void {
    this.cache.clear();
  }
}
