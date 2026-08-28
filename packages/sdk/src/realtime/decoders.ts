/**
 * Delta decoders for the protocol streams — map an SSE `data:` JSON body
 * (the core-api recovery/stream body, already camelCase) into the public SDK
 * type. Commitments and speculations reuse the existing list mappers
 * (`toCommitment`, `toSpeculation`) since their stream body equals their list
 * body; positions, contests, and fills get dedicated decoders here because
 * their stream body diverges from the rich read shape.
 *
 * Fields are copied explicitly (not spread) so an unexpected server field
 * can't leak onto the public type — same discipline as the `api/*` mappers.
 */

import { z } from 'zod';
import { parseWire } from '../wireSchema.js';
import type { Contest, ContestUpdate } from '../types/contest.js';
import type { Fill } from '../types/fill.js';
import type { Position } from '../types/position.js';

/**
 * core-api positions recovery/stream body — `Position` plus the owner address
 * and claim time the address-scoped REST read omits. Eight flat scalars, built
 * key by key by the server, so zod's default unknown-key strip reproduces the
 * explicit-copy guarantee this file's header describes.
 *
 * Types only, no content rules. `.min(1)` on `userAddress`, a `/^\d+$/` on
 * `speculationId`, `.nonnegative()` on the amounts and a `claimed`↔`claimedAt`
 * refinement would all hold against today's rows — and each buys a way to
 * DROP a frame. A decode failure here is caught by the stream runner
 * (`stream.ts:131`), which emits `connection_failed` and skips the delta; it
 * does not tear the subscription down. So a schema that is too strict loses
 * real position updates silently for any consumer not listening on `onError`,
 * which is strictly worse than the pass-through it replaces. The invariants
 * those rules would restate are already enforced by CHECK constraints on the
 * table, which is where they belong.
 */
const PositionDeltaSchema = z.object({
  speculationId: z.string(),
  userAddress: z.string(),
  // `.nullable()` is load-bearing: core-api's serializer has a branch that
  // emits null here. The column is NOT NULL today, so the branch is currently
  // unreachable — but the public `Position` type declares `0 | 1 | null`, and
  // the cost of guessing wrong is a silently dropped delta.
  positionType: z.union([z.literal(0), z.literal(1)]).nullable(),
  riskAmountUSDC: z.number().finite(),
  profitAmountUSDC: z.number().finite(),
  claimed: z.boolean(),
  positionCreatedAt: z.string().nullable(),
  claimedAt: z.string().nullable(),
});

export function decodePositionDelta(body: unknown): Position {
  return parseWire(PositionDeltaSchema, body);
}

/**
 * core-api contest `delta` frame body — the 18 flat scalars of
 * {@link ContestUpdate}. No nested object and no array: the stream body
 * deliberately omits `speculations[]`, the game identity pair, and the
 * detail-only enrichment, so the strip hazard that the contests-LIST schema
 * has to manage around its `speculations` array does not exist here.
 *
 * **No `.min(1)`, anywhere, and that is the whole point of this schema.**
 * {@link FillSchema} below puts `.min(1)` on nine strings, and that is right
 * for a fill — an immutable event row with no partial state. It is wrong here
 * on nine of the ten strings: `""` is this surface's documented encoding of
 * "not verified yet" / "no games row linked", minted by core-api's own `?? ''`
 * coalescing. Only `contestId` could carry it safely (a `bigint NOT NULL`
 * column), and singling it out would buy nothing but an inconsistency. The
 * fixture matrix in `tests/fixtures/start-times.ts` already drives `''`
 * through this decoder, so the mistake reddens rather than ships.
 *
 * Plain `z.string()` on the timestamps for a second reason: PostgREST renders
 * `timestamptz` as `2026-05-29T15:00:00.123456+00:00`, and zod's
 * `.datetime()` defaults to Z-only — it refuses every row core-api serves.
 *
 * The five start-time companions are `.optional()` because a core-api build
 * predating them omits the keys entirely, which is a different state from the
 * `''` they carry when present-but-unset.
 */
const ContestUpdateSchema = z.object({
  contestId: z.string(),
  awayTeam: z.string(),
  homeTeam: z.string(),
  sport: z.string(),
  sportId: z.number().finite(),
  matchTime: z.string(),
  chainStartTime: z.string().optional(),
  gameMatchTime: z.string().optional(),
  gameEarliestMatchTime: z.string().optional(),
  gameRundownMatchTime: z.string().optional(),
  gameSportspageMatchTime: z.string().optional(),
  status: z.string(),
  awayScore: z.number().finite().nullable(),
  homeScore: z.number().finite().nullable(),
  verifiedAt: z.string().nullable(),
  scoredAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  contestCreatedAt: z.string().nullable(),
});

export function decodeContestUpdate(body: unknown): ContestUpdate {
  // Parsed, then copied by the SAME explicit block as before — not returned
  // directly like `decodePositionDelta` above. `z.infer` widens an
  // `.optional()` key to `?: string | undefined`, which
  // `exactOptionalPropertyTypes` refuses to assign to `ContestUpdate`'s exact-
  // optional companions; the guarded copies below already express that
  // distinction correctly, so validating in place keeps the one property that
  // matters — an ABSENT key stays absent rather than becoming a present-but-
  // undefined one, which is what makes a delta row and a projected snapshot
  // row from the same server build comparable.
  const b = parseWire(ContestUpdateSchema, body);
  const out: ContestUpdate = {
    contestId: b.contestId,
    awayTeam: b.awayTeam,
    homeTeam: b.homeTeam,
    sport: b.sport,
    sportId: b.sportId,
    matchTime: b.matchTime,
    status: b.status,
    awayScore: b.awayScore,
    homeScore: b.homeScore,
    verifiedAt: b.verifiedAt,
    scoredAt: b.scoredAt,
    voidedAt: b.voidedAt,
    contestCreatedAt: b.contestCreatedAt,
  };
  // Start-time companions (conditional copy per `exactOptionalPropertyTypes`):
  // carried on the stream/recovery body so a floor raise or feed reschedule
  // reaches subscribers as a delta; absent against older core-api builds.
  if (b.chainStartTime !== undefined) out.chainStartTime = b.chainStartTime;
  if (b.gameMatchTime !== undefined) out.gameMatchTime = b.gameMatchTime;
  if (b.gameEarliestMatchTime !== undefined) {
    out.gameEarliestMatchTime = b.gameEarliestMatchTime;
  }
  if (b.gameRundownMatchTime !== undefined) {
    out.gameRundownMatchTime = b.gameRundownMatchTime;
  }
  if (b.gameSportspageMatchTime !== undefined) {
    out.gameSportspageMatchTime = b.gameSportspageMatchTime;
  }
  return out;
}

/**
 * Structural schema for a `fill` SSE frame body — the 16 `Fill` fields,
 * all required. Unknown extra fields are stripped (zod default), so the
 * decoded value carries only the public `Fill` shape.
 */
const FillSchema = z.object({
  speculationId: z.string().min(1),
  contestId: z.string().min(1),
  commitmentHash: z.string().min(1),
  maker: z.string().min(1),
  taker: z.string().min(1),
  makerPositionType: z.union([z.literal(0), z.literal(1)]),
  takerPositionType: z.union([z.literal(0), z.literal(1)]),
  makerRiskAmount: z.string().min(1),
  takerRiskAmount: z.string().min(1),
  makerRiskUSDC: z.number().finite(),
  takerRiskUSDC: z.number().finite(),
  oddsTick: z.number().finite(),
  filledAt: z.string().min(1),
  contestStarted: z.boolean(),
  txHash: z.string().min(1),
  logIndex: z.number().finite(),
});

/**
 * Decode a `fill` SSE frame body into the public {@link Fill} type. Every
 * required field is validated against {@link FillSchema}; a malformed body
 * (e.g. `{}` or a partial body) throws {@link OspexValidationError}. The
 * own-state SSE subscribe path catches and triggers `frameAborted` teardown
 * so cursor never advances past an undecoded frame.
 */
export function decodeFill(body: unknown): Fill {
  return parseWire(FillSchema, body);
}

/**
 * Project a rich `Contest` (from `contests.get`) down to the lifecycle slice a
 * `contests.subscribe` snapshot delivers, so snapshot rows and stream deltas
 * are the same `ContestUpdate` shape. The detail endpoint's lifecycle fields
 * are optional; coerce absent ones to null to match the stream body.
 */
export function contestToUpdate(c: Contest): ContestUpdate {
  const out: ContestUpdate = {
    contestId: c.contestId,
    awayTeam: c.awayTeam,
    homeTeam: c.homeTeam,
    sport: c.sport,
    sportId: c.sportId,
    matchTime: c.matchTime,
    status: c.status,
    awayScore: c.awayScore ?? null,
    homeScore: c.homeScore ?? null,
    verifiedAt: c.verifiedAt ?? null,
    scoredAt: c.scoredAt ?? null,
    voidedAt: c.voidedAt ?? null,
    contestCreatedAt: c.contestCreatedAt ?? null,
  };
  // Start-time companions stay conditional (absent, not null-coerced) so the
  // projected snapshot row matches what the stream body would carry from the
  // same server build.
  if (c.chainStartTime !== undefined) out.chainStartTime = c.chainStartTime;
  if (c.gameMatchTime !== undefined) out.gameMatchTime = c.gameMatchTime;
  if (c.gameEarliestMatchTime !== undefined) {
    out.gameEarliestMatchTime = c.gameEarliestMatchTime;
  }
  if (c.gameRundownMatchTime !== undefined) {
    out.gameRundownMatchTime = c.gameRundownMatchTime;
  }
  if (c.gameSportspageMatchTime !== undefined) {
    out.gameSportspageMatchTime = c.gameSportspageMatchTime;
  }
  return out;
}
