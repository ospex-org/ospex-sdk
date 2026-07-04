/**
 * `client.contests.waitForVerified(contestId)` — polls
 * ContestModule.getContest on-chain until the status reaches Verified
 * (or beyond — Scored / Voided also resolve so the call never spins
 * after a contest has terminal-progressed past the CRE report).
 *
 * On-chain (not Supabase) by design: pre-flight §3 noted the indexer
 * can race with games and park CONTEST_VERIFIED in pending_events for
 * up to ~1 hour; the on-chain read is authoritative.
 */
import {
  DEFAULT_VERIFICATION_POLL_INTERVAL_MS,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
} from '../contracts/constants.js';
import { OspexChainError } from '../errors.js';
import type { ContestStatus } from '../types/contest.js';
import type { ContestsContext } from './context.js';
import { readContestOnChain } from './onchainRead.js';

export interface WaitForVerifiedOptions {
  /** Default 120_000 ms (~2x typical CRE report latency). */
  timeoutMs?: number;
  /** Default 4_000 ms. */
  pollIntervalMs?: number;
  /** Test seam — defaults to setTimeout-based wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitForVerifiedResult {
  contestId: bigint;
  status: ContestStatus;
}

export async function waitForVerified(
  ctx: ContestsContext,
  contestId: bigint | string | number,
  options: WaitForVerifiedOptions = {},
): Promise<WaitForVerifiedResult> {
  const id = typeof contestId === 'bigint' ? contestId : BigInt(contestId);
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_VERIFICATION_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;

  const publicClient = ctx.requireChainClient();
  const contestModule = ctx.getAddresses().contestModule;
  const deadline = Date.now() + timeoutMs;

  // First read short-circuits if the contest is already past Unverified.
  // Then we sleep + re-read in a loop until verified-or-better, or
  // timeout.
  while (true) {
    const { contestStatus } = await readContestOnChain(publicClient, contestModule, id);
    if (contestStatus !== 'unverified') {
      return { contestId: id, status: contestStatus };
    }
    if (Date.now() + pollIntervalMs > deadline) {
      throw new OspexChainError(
        `Contest ${id} did not reach Verified within ${timeoutMs} ms. ` +
          'Run `ospex contests wait-verified <id>` again or check the CRE oracle report status.',
      );
    }
    await sleep(pollIntervalMs);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
