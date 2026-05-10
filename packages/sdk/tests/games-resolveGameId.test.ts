/**
 * Unit tests for the `--game <slug-or-id>` resolver. Pure function
 * with a `listGames` dependency — tests inject synthetic Game arrays.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveGameId } from '../src/games/resolveGameId.js';
import { OspexValidationError } from '../src/errors.js';
import type { Game } from '../src/types/game.js';

const UUID_A = '6d3a90e1-6393-4afa-9b06-30f1308aac48';
const UUID_B = 'a783e37e-4ce1-4f42-9dd6-615568f73044';

function buildGame(overrides: Partial<Game> = {}): Game {
  return {
    gameId: UUID_A,
    slug: 'stl-sd-2026-05-08',
    sport: 'mlb',
    matchTime: '2026-05-08T02:00:00Z',
    status: 'upcoming',
    homeTeam: { name: 'San Diego Padres', abbreviation: 'SD' },
    awayTeam: { name: 'St. Louis Cardinals', abbreviation: 'STL' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: UUID_A, sportspage: '336545', rundown: 'rd1' },
    ...overrides,
  };
}

describe('resolveGameId', () => {
  it('passes UUID inputs through without listing games', async () => {
    const listGames = vi.fn(async () => [] as Game[]);
    const out = await resolveGameId(UUID_A, { listGames });
    expect(out).toEqual({ gameId: UUID_A, source: 'uuid', game: null });
    expect(listGames).not.toHaveBeenCalled();
  });

  it('passes uppercase / mixed-case UUIDs through (case-insensitive)', async () => {
    const listGames = vi.fn(async () => [] as Game[]);
    const upper = UUID_A.toUpperCase();
    const out = await resolveGameId(upper, { listGames });
    expect(out).toEqual({ gameId: upper, source: 'uuid', game: null });
  });

  it('passes whitespace-padded UUIDs through after trim', async () => {
    const listGames = vi.fn(async () => [] as Game[]);
    const out = await resolveGameId(`  ${UUID_A}  `, { listGames });
    expect(out).toEqual({ gameId: UUID_A, source: 'uuid', game: null });
    expect(listGames).not.toHaveBeenCalled();
  });

  it('resolves a slug to its gameId + Game via games.list', async () => {
    const game = buildGame({ gameId: UUID_A, slug: 'stl-sd-2026-05-08' });
    const listGames = vi.fn(async () => [
      game,
      buildGame({ gameId: UUID_B, slug: 'nyy-mil-2026-05-08' }),
    ]);
    const out = await resolveGameId('stl-sd-2026-05-08', { listGames });
    expect(out).toEqual({ gameId: UUID_A, source: 'slug', game });
    expect(listGames).toHaveBeenCalledTimes(1);
  });

  it('matches slugs case-insensitively', async () => {
    const game = buildGame({ gameId: UUID_A, slug: 'stl-sd-2026-05-08' });
    const listGames = vi.fn(async () => [game]);
    expect((await resolveGameId('STL-SD-2026-05-08', { listGames })).gameId).toBe(UUID_A);
    expect((await resolveGameId('  stl-sd-2026-05-08  ', { listGames })).gameId).toBe(UUID_A);
  });

  it('throws OspexValidationError when no slug matches', async () => {
    const listGames = vi.fn(async () => [
      buildGame({ slug: 'nyy-mil-2026-05-08' }),
    ]);
    await expect(resolveGameId('foo-bar-2026-05-08', { listGames })).rejects.toThrow(
      /did not match any upcoming game/,
    );
  });

  it('throws OspexValidationError when multiple games share a slug (defensive)', async () => {
    // Shouldn't happen given the (network, slug) UNIQUE constraint,
    // but the resolver is the wrong place to assume invariants hold.
    const listGames = vi.fn(async () => [
      buildGame({ gameId: UUID_A, slug: 'dup-2026-05-08' }),
      buildGame({ gameId: UUID_B, slug: 'dup-2026-05-08' }),
    ]);
    await expect(resolveGameId('dup-2026-05-08', { listGames })).rejects.toThrow(
      /matched multiple games/,
    );
  });

  it('rejects empty / whitespace-only / non-string input', async () => {
    const listGames = vi.fn(async () => [] as Game[]);
    await expect(resolveGameId('', { listGames })).rejects.toThrow(OspexValidationError);
    await expect(resolveGameId('   ', { listGames })).rejects.toThrow(OspexValidationError);
    await expect(
      resolveGameId(null as unknown as string, { listGames }),
    ).rejects.toThrow(OspexValidationError);
    // Whitespace-only must NOT trigger a network lookup.
    expect(listGames).not.toHaveBeenCalled();
  });
});
