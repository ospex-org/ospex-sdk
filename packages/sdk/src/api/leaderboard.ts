import type { ApiClient } from './client.js';
import type { LeaderboardEntry } from '../types/leaderboard.js';
import { OspexAPIError } from '../errors.js';
import type { LeaderboardBody } from './types.js';

export class LeaderboardApi {
  constructor(private readonly client: ApiClient) {}

  /**
   * Returns the entries of the soonest-ending leaderboard whose window
   * has started. Throws OspexAPIError with apiCode `NOT_FOUND` (404)
   * when no leaderboard is currently active.
   */
  async active(): Promise<LeaderboardEntry[]> {
    try {
      const body = await this.client.request<LeaderboardBody>('/v1/leaderboard');
      return body.entries;
    } catch (err) {
      // Surface the 404 transparently — callers may want to differentiate.
      if (err instanceof OspexAPIError) throw err;
      throw err;
    }
  }
}
