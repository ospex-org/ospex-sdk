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
   * inputs scan the widest forward games window the API will serve.
   * See `resolveGameId.ts` for the algorithm + failure modes.
   */
  resolveGameId(input: string): Promise<string> {
    return resolveGameId(input, {
      listGames: () => this.ctx.gamesApi.list({ hours: 720, availableOnly: false }),
    });
  }
}
