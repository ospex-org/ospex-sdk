/**
 * Typed wrapper around the games endpoints on core-api:
 *
 *   - `GET /v1/games`             → list of upcoming games
 *   - `GET /v1/games/:gameId`     → single game by jsonodds_id
 *
 * `gameId` here is the row's `jsonodds_id` — stable for the row's
 * lifetime. The writer's `slug` is exposed in the response for display
 * but is mutable; do NOT use it as a lookup key.
 */
import type { ApiClient } from './client.js';
import type {
  Game,
  GameSport,
  GameStatus,
  GamesListOptions,
} from '../types/game.js';
import type { GameBody, GamesListBody } from './types.js';

export class GamesApi {
  constructor(private readonly client: ApiClient) {}

  async list(options: GamesListOptions = {}): Promise<Game[]> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (options.sport !== undefined) query.sport = options.sport;
    if (options.hours !== undefined) query.windowHours = options.hours;
    if (options.availableOnly !== undefined) query.availableOnly = options.availableOnly;
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.offset !== undefined) query.offset = options.offset;
    const body = await this.client.request<GamesListBody>('/v1/games', { query });
    return body.games.map(toGame);
  }

  /**
   * Fetch every games row matching the options, walking the API's
   * pagination until `hasMore=false`. Used by `resolveGameId` so a
   * slug on page 2+ doesn't silently miss. Pagination cap is the
   * API's max limit (200) per request.
   */
  async listAll(options: GamesListOptions = {}): Promise<Game[]> {
    const all: Game[] = [];
    const pageLimit = 200;
    let offset = options.offset ?? 0;
    // Loop guard: 100 pages × 200 = 20k games, comfortably above
    // any realistic forward window of upcoming games. Bounded so
    // a misbehaving server can't spin forever.
    const MAX_PAGES = 100;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string | number | boolean | undefined> = {
        limit: pageLimit,
        offset,
      };
      if (options.sport !== undefined) query.sport = options.sport;
      if (options.hours !== undefined) query.windowHours = options.hours;
      if (options.availableOnly !== undefined) query.availableOnly = options.availableOnly;
      const body = await this.client.request<GamesListBody>('/v1/games', { query });
      all.push(...body.games.map(toGame));
      if (!body.pagination.hasMore) return all;
      if (body.games.length === 0) return all;
      offset += body.games.length;
    }
    return all;
  }

  async get(gameId: string): Promise<Game> {
    const body = await this.client.request<GameBody>(
      `/v1/games/${encodeURIComponent(gameId)}`,
    );
    return toGame(body);
  }
}

function toGame(body: GameBody): Game {
  return {
    gameId: body.gameId,
    slug: body.slug,
    sport: body.sport as GameSport,
    matchTime: body.matchTime,
    status: body.status as GameStatus,
    homeTeam: { name: body.homeTeam.name, abbreviation: body.homeTeam.abbreviation },
    awayTeam: { name: body.awayTeam.name, abbreviation: body.awayTeam.abbreviation },
    hasOdds: body.hasOdds,
    contestCreated: body.contestCreated,
    contestId: body.contestId,
    canCreateContest: body.canCreateContest,
    externalIds: {
      jsonodds: body.externalIds.jsonodds,
      sportspage: body.externalIds.sportspage,
      rundown: body.externalIds.rundown,
    },
  };
}
