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
import { z } from 'zod';
import { OspexAPIError } from '../errors.js';
import { parseWire } from '../wireSchema.js';
import type { ApiClient } from './client.js';
import type {
  Game,
  GameSport,
  GameStatus,
  GamesListOptions,
} from '../types/game.js';

/* ── wire schema: the `/v1/games` decode boundary ─────────────────────────
 *
 * Both endpoints share ONE row schema, because core-api serves the detail
 * body through the same serializer as a list row.
 *
 * Types only, deliberately. Four content rules are available here and every
 * one of them is an outage:
 *
 *   - `.datetime()` on any of the five timestamps refuses EVERY row.
 *     PostgREST renders `timestamptz` as `2026-05-29T15:00:00.123456+00:00`;
 *     zod v3's `.datetime()` defaults to Z-only. Measured: it rejects both the
 *     `+00:00` form and its fractionless variant.
 *   - `z.enum([...sports])` on `sport` fails a whole page on one row. The
 *     column has no CHECK constraint and the handler casts it unvalidated;
 *     the `?sport=` filter is validated but optional.
 *   - `z.enum([...statuses])` on `status` is exact against today's CHECK and
 *     becomes wrong the moment the writer's proposed status change lands —
 *     and the SDK ships independently of migrations.
 *   - `.min(1)` on `externalIds.{sportspage,rundown}` refuses a row core-api
 *     serves deliberately: its own `canCreateContest` computation treats `''`
 *     as a value the column holds, while the list query excludes only NULL.
 *
 * `.strict()` is likewise wrong: core-api emits a `probablePitchers` block
 * that `GameBody` does not declare. Default strip is what keeps a new server
 * field from breaking a deployed SDK, and it is what the mapper's explicit
 * copy already assumed.
 */
const GameTeamBodySchema = z.object({
  name: z.string(),
  abbreviation: z.string(),
});

const GameBodySchema = z.object({
  gameId: z.string(),
  slug: z.string(),
  sport: z.string(),
  /**
   * The earliest start currently held for this game — on servers that carry
   * the diagnostic fields below, the minimum of the raw feed value, the
   * retained floor, and whichever provider snapshots the server considered
   * fresh (a conservative safety bound); the raw feed value on older core-api
   * builds, which omit them.
   */
  matchTime: z.string(),
  // The four diagnostics are `.optional()` because a core-api build predating
  // them omits the keys, and the last three are additionally `.nullable()`
  // because they pass a nullable column straight through — `null` means "floor
  // unset" / "no snapshot captured", which is a VALUE distinct from the key
  // being absent, and the mapper's guarded copies preserve that difference.
  // Note this is the opposite of the contest surface, which coalesces the same
  // three ideas to `''`. The two conventions must not be unified.
  /** The raw current feed value, unminimised. Diagnostic. */
  gameMatchTime: z.string().optional(),
  /**
   * The retained monotone floor, or `null` when the underlying column is
   * unset. Diagnostic: when this is below `gameMatchTime`, it is what is
   * driving `matchTime`. (Nullable here, unlike the `""` sentinel on contest
   * surfaces — mirrors the wire.)
   */
  earliestMatchTime: z.string().nullable().optional(),
  /**
   * Provider start-time snapshots (`games.rundown_match_time` /
   * `games.sportspage_match_time`), or `null` when the underlying column is
   * unset. Nullable for the same reason as `earliestMatchTime` above: this
   * endpoint passes the column through, while the contest projections
   * coalesce it to `""`.
   */
  rundownMatchTime: z.string().nullable().optional(),
  sportspageMatchTime: z.string().nullable().optional(),
  status: z.string(),
  homeTeam: GameTeamBodySchema,
  awayTeam: GameTeamBodySchema,
  hasOdds: z.boolean(),
  contestCreated: z.boolean(),
  contestId: z.string().nullable(),
  canCreateContest: z.boolean(),
  externalIds: z.object({
    jsonodds: z.string(),
    sportspage: z.string().nullable(),
    rundown: z.string().nullable(),
  }),
});

const GamesListBodySchema = z.object({
  sport: z.string().nullable(),
  windowHours: z.number().finite(),
  availableOnly: z.boolean(),
  // Never `.nonempty()`: an empty page is an ordinary 200, and `listAll`'s
  // stall detector below depends on being able to parse one.
  games: z.array(GameBodySchema),
  pagination: z.object({
    limit: z.number().finite(),
    offset: z.number().finite(),
    total: z.number().finite(),
    // `hasMore` MUST stay enumerated. Dropping it is not a type error and
    // throws nothing: zod strips the key, `!undefined` is `true`, and
    // `listAll` returns page one as if it were the whole slate — defeating
    // the fail-closed stall guard a few lines below it and handing
    // `resolveGameId` a partial candidate list, which turns a real slug into
    // "did not match any upcoming game". Silent, and the only symptom is a
    // wrong answer.
    hasMore: z.boolean(),
  }),
});

export class GamesApi {
  constructor(private readonly client: ApiClient) {}

  async list(options: GamesListOptions = {}): Promise<Game[]> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (options.sport !== undefined) query.sport = options.sport;
    if (options.hours !== undefined) query.windowHours = options.hours;
    if (options.availableOnly !== undefined) query.availableOnly = options.availableOnly;
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.offset !== undefined) query.offset = options.offset;
    const raw = await this.client.request<unknown>('/v1/games', { query });
    const body = parseWire(GamesListBodySchema, raw);
    return body.games.map(toGame);
  }

  /**
   * Fetch every games row matching the options, walking the API's
   * pagination until `hasMore=false`. Used by `resolveGameId` so a
   * slug on page 2+ doesn't silently miss. Pagination cap is the
   * API's max limit (200) per request.
   *
   * Fails closed on stalled pagination — same pattern as
   * `TeamsApi.aliases`. Returning a partial set could let a slug
   * lookup miss a real match; better to surface the server bug.
   */
  async listAll(options: GamesListOptions = {}): Promise<Game[]> {
    const all: Game[] = [];
    const pageLimit = 200;
    let offset = options.offset ?? 0;
    const MAX_PAGES = 100; // 100 × 200 = 20k games — above any realistic forward window.
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Record<string, string | number | boolean | undefined> = {
        limit: pageLimit,
        offset,
      };
      if (options.sport !== undefined) query.sport = options.sport;
      if (options.hours !== undefined) query.windowHours = options.hours;
      if (options.availableOnly !== undefined) query.availableOnly = options.availableOnly;
      const raw = await this.client.request<unknown>('/v1/games', { query });
      const body = parseWire(GamesListBodySchema, raw);
      all.push(...body.games.map(toGame));
      if (!body.pagination.hasMore) return all;
      if (body.games.length === 0) {
        throw new OspexAPIError(
          'Games pagination stalled: server returned hasMore=true with an empty page. ' +
            'Refusing to return a partial games set — slug resolution requires the complete candidate list.',
          { path: '/v1/games' },
        );
      }
      offset += body.games.length;
    }
    throw new OspexAPIError(
      `Games pagination exceeded ${MAX_PAGES} pages while the server still reported hasMore=true. ` +
        'Refusing to return a partial games set.',
      { path: '/v1/games' },
    );
  }

  async get(gameId: string): Promise<Game> {
    const raw = await this.client.request<unknown>(
      `/v1/games/${encodeURIComponent(gameId)}`,
    );
    return toGame(parseWire(GameBodySchema, raw));
  }
}

/**
 * The wire row, derived from the schema rather than declared beside it.
 *
 * This is what makes the schema load-bearing. While a hand-written `GameBody`
 * existed and the parsed value was cast to it, the two could disagree in
 * silence: widening `gameId` to `z.string().nullable()` passed `tsc` and all
 * 1,096 tests, and a `null` reached `Game.gameId`, which is declared `string`.
 * With the input inferred, that same widening is a compile error at the
 * assignment below — the schema cannot drift from the shape the mapper reads.
 */
type GameWireRow = z.infer<typeof GameBodySchema>;

function toGame(body: GameWireRow): Game {
  const out: Game = {
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
  // Conditional copy per `exactOptionalPropertyTypes`: absent against
  // core-api builds predating the start-time diagnostic fields. Note
  // `earliestMatchTime` is nullable when present — `null` is a real served
  // value ("floor unset"), distinct from the key being absent. The same holds
  // for the two provider snapshots below ("no snapshot captured").
  if (body.gameMatchTime !== undefined) out.gameMatchTime = body.gameMatchTime;
  if (body.earliestMatchTime !== undefined) out.earliestMatchTime = body.earliestMatchTime;
  if (body.rundownMatchTime !== undefined) out.rundownMatchTime = body.rundownMatchTime;
  if (body.sportspageMatchTime !== undefined) {
    out.sportspageMatchTime = body.sportspageMatchTime;
  }
  return out;
}
