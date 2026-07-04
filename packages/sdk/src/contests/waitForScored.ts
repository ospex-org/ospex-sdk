/**
 * `client.contests.waitForScored(contestId)` — polls
 * ContestModule.getContest on-chain until the contest reaches Scored,
 * mirroring waitForVerified (same authoritative on-chain read, same
 * bounded-poll + injectable-sleep shape).
 *
 * Terminal logic is stricter than waitForVerified: only `scored` is the
 * awaited outcome, but `voided` also RESOLVES (a Voided contest can
 * never become Scored — `setScores` requires Verified — so spinning out
 * the full timeout on it would be wrong). The CLI distinguishes the
 * `voided` resolution from a timeout THROW to decide whether to
 * re-request scoring. `unverified` / `verified` keep polling. On the
 * poll bound WITHOUT a terminal answer this throws a typed
 * `OspexChainError` (an UNKNOWN/timeout — never a sentinel).
 */
import {
  DEFAULT_SCORING_POLL_INTERVAL_MS,
  DEFAULT_SCORING_TIMEOUT_MS,
} from '../contracts/constants.js';
import { OspexChainError } from '../errors.js';
import type { ContestsContext } from './context.js';
import { readContestOnChain } from './onchainRead.js';

export interface WaitForScoredOptions {
  /** Default 120_000 ms (~2x typical CRE report latency). */
  timeoutMs?: number;
  /** Default 4_000 ms. */
  pollIntervalMs?: number;
  /** Test seam — defaults to setTimeout-based wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitForScoredResult {
  contestId: bigint;
  /** `'scored'` (with real scores) or `'voided'` (terminal, scores null). */
  status: 'scored' | 'voided';
  /** Final away score — populated only when `status === 'scored'`. */
  awayScore: number | null;
  /** Final home score — populated only when `status === 'scored'`. */
  homeScore: number | null;
}

export async function waitForScored(
  ctx: ContestsContext,
  contestId: bigint | string | number,
  options: WaitForScoredOptions = {},
): Promise<WaitForScoredResult> {
  const id = typeof contestId === 'bigint' ? contestId : BigInt(contestId);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCORING_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SCORING_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;

  const publicClient = ctx.requireChainClient();
  const contestModule = ctx.getAddresses().contestModule;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const { contestStatus, awayScore, homeScore } = await readContestOnChain(
      publicClient,
      contestModule,
      id,
    );
    if (contestStatus === 'scored') {
      return { contestId: id, status: 'scored', awayScore, homeScore };
    }
    if (contestStatus === 'voided') {
      // Terminal for scoring — resolve immediately with null scores
      // rather than polling to the timeout for an impossible transition.
      return { contestId: id, status: 'voided', awayScore: null, homeScore: null };
    }
    // unverified / verified — keep polling until Scored, Voided, or timeout.
    if (Date.now() + pollIntervalMs > deadline) {
      throw new OspexChainError(
        `Contest ${id} did not reach Scored within ${timeoutMs} ms. ` +
          'Re-request scoring with `ospex contests score <id>` (idempotent + free) ' +
          'or run `ospex contests wait-scored <id>` again. An unscored contest ' +
          'auto-voids and refunds after the void cooldown, so funds are never locked.',
      );
    }
    await sleep(pollIntervalMs);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
