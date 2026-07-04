/**
 * `client.contests.scoreStatus(contestId)` — a single, non-blocking
 * on-chain read of a contest's scoring state + final scores from
 * `ContestModule.getContest`. Signer-free (needs only an rpcUrl).
 *
 * Never throws on "not scored yet" — it reports whatever the current
 * status is (only rpc failure / an unrecognized status enum throw, via
 * `readContestOnChain`). Scores are gated on `status === 'scored'` and
 * returned `null` otherwise — the on-chain uint32 scores default to 0
 * pre-Scored and a legitimate 0-0 final exists, so Scored must never be
 * inferred from a nonzero value.
 */
import { OspexValidationError } from '../errors.js';
import type { ContestStatus } from '../types/contest.js';
import type { ContestsContext } from './context.js';
import { readContestOnChain } from './onchainRead.js';

export interface ScoreStatusResult {
  contestId: bigint;
  status: ContestStatus;
  /** `status === 'scored'` — the authoritative "final score is set" flag. */
  scored: boolean;
  /** Final away score, or `null` unless scored. */
  awayScore: number | null;
  /** Final home score, or `null` unless scored. */
  homeScore: number | null;
}

export async function scoreStatus(
  ctx: ContestsContext,
  contestId: bigint | string | number,
): Promise<ScoreStatusResult> {
  const id = typeof contestId === 'bigint' ? contestId : BigInt(contestId);
  if (id <= 0n) {
    throw new OspexValidationError('contestId must be a positive integer.', { field: 'contestId' });
  }

  const publicClient = ctx.requireChainClient();
  const contestModule = ctx.getAddresses().contestModule;
  const { contestStatus, awayScore, homeScore } = await readContestOnChain(
    publicClient,
    contestModule,
    id,
  );
  const scored = contestStatus === 'scored';
  return {
    contestId: id,
    status: contestStatus,
    scored,
    awayScore: scored ? awayScore : null,
    homeScore: scored ? homeScore : null,
  };
}
