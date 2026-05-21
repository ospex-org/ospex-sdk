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
  return {
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
}

export function decodeFill(body: unknown): Fill {
  const b = body as Fill;
  return {
    speculationId: b.speculationId,
    contestId: b.contestId,
    commitmentHash: b.commitmentHash,
    maker: b.maker,
    taker: b.taker,
    makerPositionType: b.makerPositionType,
    takerPositionType: b.takerPositionType,
    makerRiskAmount: b.makerRiskAmount,
    takerRiskAmount: b.takerRiskAmount,
    makerRiskUSDC: b.makerRiskUSDC,
    takerRiskUSDC: b.takerRiskUSDC,
    oddsTick: b.oddsTick,
    filledAt: b.filledAt,
    contestStarted: b.contestStarted,
    txHash: b.txHash,
    logIndex: b.logIndex,
  };
}

/**
 * Project a rich `Contest` (from `contests.get`) down to the lifecycle slice a
 * `contests.subscribe` snapshot delivers, so snapshot rows and stream deltas
 * are the same `ContestUpdate` shape. The detail endpoint's lifecycle fields
 * are optional; coerce absent ones to null to match the stream body.
 */
export function contestToUpdate(c: Contest): ContestUpdate {
  return {
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
}
