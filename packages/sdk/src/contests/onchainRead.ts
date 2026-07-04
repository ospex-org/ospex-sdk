/**
 * Shared on-chain `ContestModule.getContest` read for the contests
 * wait/read family (`waitForVerified`, `waitForScored`, `scoreStatus`).
 *
 * On-chain (not core-api) by design: the indexer can park
 * CONTEST_VERIFIED / CONTEST_SCORES_SET in `pending_events` for up to
 * ~1 hour, so a projected read can be stale precisely when a caller asks
 * "is it verified / scored yet?". `getContest` is authoritative.
 *
 * This is a viem decode against a typed ABI, NOT an untrusted wire body,
 * so it uses the hand-checked-enum + `OspexChainError` pattern rather
 * than the zod `parseWire()` boundary (the zod rule is scoped to API
 * wire bodies). `getContest` returns a zero struct (Unverified, 0-0) for
 * an unknown contestId rather than reverting — callers that need to
 * distinguish "missing" from "genuinely unverified" cannot from this
 * read alone (identical to `waitForVerified`'s long-standing behavior).
 */
import type { PublicClient } from 'viem';
import { contestModuleAbi } from '../contracts/abi/index.js';
import { OspexChainError } from '../errors.js';
import type { ContestStatus } from '../types/contest.js';
import type { Hex } from '../types/signer.js';

/** On-chain `ContestStatus` enum ordering (OspexTypes.sol). */
export const STATUS_BY_ENUM: Record<number, ContestStatus> = {
  0: 'unverified',
  1: 'verified',
  2: 'scored',
  3: 'voided',
};

export interface OnChainContest {
  contestStatus: ContestStatus;
  /**
   * On-chain uint32 away/home scores. Default 0 until the atomic Scored
   * transition (`ContestModule.setScores`), so a 0 is meaningful ONLY
   * when `contestStatus === 'scored'` (a legitimate 0-0 final exists).
   * Callers MUST gate score display on the status, never infer Scored
   * from a nonzero value.
   */
  awayScore: number;
  homeScore: number;
}

interface RawContestStruct {
  contestStatus: number;
  awayScore?: number | bigint;
  homeScore?: number | bigint;
}

export async function readContestOnChain(
  publicClient: PublicClient,
  contestModule: Hex,
  contestId: bigint,
): Promise<OnChainContest> {
  let result: RawContestStruct;
  try {
    result = (await publicClient.readContract({
      address: contestModule,
      abi: contestModuleAbi,
      functionName: 'getContest',
      args: [contestId],
    })) as RawContestStruct;
  } catch (err) {
    throw new OspexChainError(`Failed to read contest ${contestId} from ContestModule.`, {
      cause: err,
    });
  }
  const contestStatus = STATUS_BY_ENUM[result.contestStatus];
  if (contestStatus === undefined) {
    throw new OspexChainError(
      `Contest ${contestId} returned unrecognized status enum ${result.contestStatus}.`,
    );
  }
  // uint32 decodes to a JS number in viem; `?? 0` guards the field being
  // absent (only in hand-built test fixtures — the real struct always
  // carries both). Scores are only surfaced by callers when Scored.
  return {
    contestStatus,
    awayScore: Number(result.awayScore ?? 0),
    homeScore: Number(result.homeScore ?? 0),
  };
}
