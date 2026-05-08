/**
 * Resolve a `--game <slug-or-id>` input into a canonical `gameId`
 * (the row's `jsonodds_id`).
 *
 * UUID-shaped inputs are returned as-is — they're already canonical
 * and a slug lookup would be a wasted round trip. Anything else is
 * matched against `games.slug` for the configured network via the
 * SDK's GamesApi. Multiple matches fail closed (shouldn't happen
 * given the `(network, slug)` uniqueness constraint, but the
 * resolver is the wrong place to assume the indexer never violates
 * an invariant).
 *
 * Slug is mutable (writer renames doubleheaders), so the resolved
 * gameId is only stable for the duration of one CLI invocation.
 * Anything that needs to persist a reference between sessions must
 * use the gameId directly.
 *
 * The function is split out from the `Games` class so future agents
 * in other languages (or tests with synthetic game lists) can
 * reuse the same algorithm against any games-listing surface.
 */

import { OspexValidationError } from '../errors.js';
import type { Game } from '../types/game.js';

/** RFC-4122 hex UUID, any version. Case-insensitive. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolveGameIdDeps {
  /**
   * List candidate games to scan for slug matches. Implementations
   * should walk the full paginated games API (not just one page)
   * so a slug on page 2+ doesn't silently miss. The resolver itself
   * is pagination-blind; it trusts the dep to return the complete
   * candidate set.
   */
  listGames: () => Promise<Game[]>;
}

/**
 * Resolution result. `source` discriminates the path the resolver
 * took so the caller can decide whether to surface a confirmation
 * block (CLI does this for slug, not for UUID).
 */
export type ResolveGameIdResult =
  | { gameId: string; source: 'uuid'; game: null }
  | { gameId: string; source: 'slug'; game: Game };

export async function resolveGameId(
  input: string,
  deps: ResolveGameIdDeps,
): Promise<ResolveGameIdResult> {
  if (typeof input !== 'string') {
    throw new OspexValidationError('--game requires a non-empty string.');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new OspexValidationError('--game requires a non-empty string.');
  }
  if (UUID_REGEX.test(trimmed)) {
    return { gameId: trimmed, source: 'uuid', game: null };
  }

  const slug = trimmed.toLowerCase();
  const games = await deps.listGames();
  const matches = games.filter((g) => g.slug.toLowerCase() === slug);

  if (matches.length === 0) {
    throw new OspexValidationError(
      `--game "${input}" did not match any upcoming game by slug. ` +
        'Run `ospex games list --all` to see available slugs, or pass --game-id with a gameId directly.',
    );
  }
  if (matches.length > 1) {
    // Defensive: the writer enforces a unique (network, slug)
    // constraint, but if the indexer ever violates that we'd rather
    // fail closed than silently pick one. Surface candidate ids for
    // operator triage.
    const ids = matches.map((g) => g.gameId).join(', ');
    throw new OspexValidationError(
      `--game "${input}" matched multiple games (${ids}). ` +
        'Pass --game-id with the canonical gameId to disambiguate, and file a triage ticket — the (network, slug) uniqueness constraint should make this unreachable.',
    );
  }
  return { gameId: matches[0]!.gameId, source: 'slug', game: matches[0]! };
}
