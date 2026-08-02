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

/** core-api positions recovery/stream body — `Position` plus the owner address
 *  and claim time the address-scoped REST read omits. */
interface PositionDeltaBody {
  speculationId: string;
  userAddress: string;
  positionType: 0 | 1 | null;
  riskAmountUSDC: number;
  profitAmountUSDC: number;
  claimed: boolean;
  positionCreatedAt: string | null;
  claimedAt: string | null;
}

export function decodePositionDelta(body: unknown): Position {
  const b = body as PositionDeltaBody;
  return {
    speculationId: b.speculationId,
    positionType: b.positionType,
    riskAmountUSDC: b.riskAmountUSDC,
    profitAmountUSDC: b.profitAmountUSDC,
    claimed: b.claimed,
    positionCreatedAt: b.positionCreatedAt,
    userAddress: b.userAddress,
    claimedAt: b.claimedAt,
  };
}

export function decodeContestUpdate(body: unknown): ContestUpdate {
  const b = body as ContestUpdate;
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
  return out;
}
