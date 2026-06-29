/**
 * create() input validation (R5/CRE). The full happy path requires a viem
 * PublicClient + Signer + on-chain readContract chain that's prohibitive
 * to mock for unit tests. We cover the pre-flight validation that runs
 * before any signer / chain interaction:
 *   - missing gameId → throws OspexValidationError
 *   - game.canCreateContest=false → throws with descriptive reason
 * Integration of the full pipeline is exercised manually per
 * docs/MANUAL_INTEGRATION_TESTING.md.
 */
import { describe, expect, it } from 'vitest';
import { create } from '../src/contests/create.js';
import { OspexValidationError } from '../src/errors.js';
import type { ContestsContext } from '../src/contests/context.js';
import type { Game } from '../src/types/game.js';
import type { GamesApi } from '../src/api/games.js';

function buildGame(overrides: Partial<Game> = {}): Game {
  return {
    gameId: 'abc',
    slug: 'aaa-bbb-2026-05-05',
    sport: 'mlb',
    matchTime: '2026-05-05T23:00:00+00:00',
    status: 'upcoming',
    homeTeam: { name: 'Home', abbreviation: 'HM' },
    awayTeam: { name: 'Away', abbreviation: 'AW' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: 'abc', sportspage: 'sp1', rundown: 'rd1' },
    ...overrides,
  };
}

function makeCtx(game: Game = buildGame()): ContestsContext {
  const gamesApi = {
    get: async () => game,
  } as unknown as GamesApi;
  return {
    gamesApi,
    getChainId: () => 137 as const,
  } as unknown as ContestsContext;
}

describe('contests.create — validation', () => {
  it('throws OspexValidationError when gameId is missing', async () => {
    const ctx = makeCtx();
    // @ts-expect-error — exercising the runtime guard for callers that
    // ignore the type and pass {} (e.g. JS consumers).
    await expect(create(ctx, {})).rejects.toBeInstanceOf(OspexValidationError);
  });

  it('throws OspexValidationError when game.canCreateContest is false', async () => {
    const ctx = makeCtx(
      buildGame({ canCreateContest: false, contestCreated: true, contestId: '12' }),
    );
    await expect(create(ctx, { gameId: 'abc' })).rejects.toBeInstanceOf(OspexValidationError);
  });
});
