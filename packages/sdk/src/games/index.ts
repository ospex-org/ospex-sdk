/**
 * Games namespace — read-only surface for the writer-managed `games`
 * table. The two methods are thin wrappers over `GamesApi`; they exist
 * as a namespace primarily so consumers see `client.games.list()`
 * parallel to `client.contests.list()` etc., and so future write or
 * subscribe methods can land here without a public-API rename.
 *
 * `client.contests.create({ gameId })` uses the same `GamesApi`
 * directly (via ContestsContext) to resolve the three external IDs
 * needed for the contract call.
 */
import type { GamesApi } from '../api/games.js';
import type { Game, GamesListOptions } from '../types/game.js';
import { resolveGameId } from './resolveGameId.js';

export interface GamesContext {
  gamesApi: GamesApi;
}

export class Games {
  constructor(private readonly ctx: GamesContext) {}

  list(options: GamesListOptions = {}): Promise<Game[]> {
    return this.ctx.gamesApi.list(options);
  }

  get(gameId: string): Promise<Game> {
    return this.ctx.gamesApi.get(gameId);
  }

  /**
   * Resolve a `--game <slug-or-id>` input to a canonical `gameId`
   * (the row's `jsonodds_id`). UUID inputs short-circuit; slug
   * inputs walk the full paginated games window so a slug on page
   * 2+ doesn't silently miss. Returns a discriminated result so
   * callers (notably the CLI) can show a confirmation block on the
   * slug path. See `resolveGameId.ts` for the algorithm.
   */
  resolveGameId(input: string): Promise<import('./resolveGameId.js').ResolveGameIdResult> {
    return resolveGameId(input, {
      listGames: () => this.ctx.gamesApi.listAll({ hours: 720, availableOnly: false }),
    });
  }
}
