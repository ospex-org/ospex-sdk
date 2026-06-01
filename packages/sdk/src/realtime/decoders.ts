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
import { OspexValidationError } from '../errors.js';

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

/**
 * Decode a `fill` SSE frame body into the public {@link Fill} type. Pre-
 * v0.5.2-round-4 this was a structural pass-through that silently
 * produced a Fill of mostly-undefined fields on a malformed wire body
 * (e.g. `{}` or a partial body missing required fields). Round-4 hardens
 * it: every required field is validated and a malformed body throws
 * {@link OspexValidationError}. The own-state SSE subscribe path catches
 * and triggers `frameAborted` teardown so cursor never advances past an
 * undecoded frame.
 */
export function decodeFill(body: unknown): Fill {
  if (typeof body !== 'object' || body === null) {
    throw new OspexValidationError('Fill body must be a non-null object', { field: 'body' });
  }
  const b = body as Record<string, unknown>;
  const requireFillString = (field: string): string => {
    const v = b[field];
    if (typeof v !== 'string' || v.length === 0) {
      throw new OspexValidationError(
        `Fill body is missing or has invalid \`${field}\``,
        { field },
      );
    }
    return v;
  };
  const requireFillNumber = (field: string): number => {
    const v = b[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new OspexValidationError(
        `Fill body is missing or has invalid \`${field}\``,
        { field },
      );
    }
    return v;
  };
  const requireFillPositionType = (field: string): 0 | 1 => {
    const v = b[field];
    if (v !== 0 && v !== 1) {
      throw new OspexValidationError(
        `Fill body is missing or has invalid \`${field}\``,
        { field },
      );
    }
    return v;
  };
  const speculationId = requireFillString('speculationId');
  const contestId = requireFillString('contestId');
  const commitmentHash = requireFillString('commitmentHash');
  const maker = requireFillString('maker');
  const taker = requireFillString('taker');
  const makerPositionType = requireFillPositionType('makerPositionType');
  const takerPositionType = requireFillPositionType('takerPositionType');
  const makerRiskAmount = requireFillString('makerRiskAmount');
  const takerRiskAmount = requireFillString('takerRiskAmount');
  const makerRiskUSDC = requireFillNumber('makerRiskUSDC');
  const takerRiskUSDC = requireFillNumber('takerRiskUSDC');
  const oddsTick = requireFillNumber('oddsTick');
  const filledAt = requireFillString('filledAt');
  if (typeof b.contestStarted !== 'boolean') {
    throw new OspexValidationError(
      'Fill body is missing or has invalid `contestStarted`',
      { field: 'contestStarted' },
    );
  }
  const contestStarted = b.contestStarted;
  const txHash = requireFillString('txHash');
  const logIndex = requireFillNumber('logIndex');
  return {
    speculationId,
    contestId,
    commitmentHash,
    maker,
    taker,
    makerPositionType,
    takerPositionType,
    makerRiskAmount,
    takerRiskAmount,
    makerRiskUSDC,
    takerRiskUSDC,
    oddsTick,
    filledAt,
    contestStarted,
    txHash,
    logIndex,
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
