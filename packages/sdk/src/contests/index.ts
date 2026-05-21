/**
 * Contests namespace — composes the M4 contest creation lifecycle
 * (scripts, create, score) with read helpers (get, list, waitForVerified)
 * on a single `client.contests` object.
 *
 * Reads work without `rpcUrl` or `signer`. Write methods (create, score,
 * waitForVerified) throw `OspexConfigError` if either is missing — they
 * resolve dependencies through ContestsContext lazily so the parent
 * OspexClient doesn't construct a chain client until a write fires.
 */
import type {
  ApprovedScripts,
  Contest,
  ContestsListOptions,
  ContestUpdate,
} from '../types/contest.js';
import type { ContestsContext } from './context.js';
import type { Subscription } from '../types/odds.js';
import type { ContestsSubscribeFilters, StreamSubscribeHandlers } from '../types/stream.js';
import { subscribeToStream } from '../realtime/stream.js';
import { contestToUpdate, decodeContestUpdate } from '../realtime/decoders.js';
import {
  approveFee,
  approveLink,
  type ApproveArgs,
  type ApproveResult,
} from './approve.js';
import { create, type CreateContestArgs, type CreateContestResult } from './create.js';
import { get } from './get.js';
import { list } from './list.js';
import { score, type ScoreContestArgs, type ScoreContestResult } from './score.js';
import { ScriptsCache } from './scripts.js';
import {
  waitForVerified,
  type WaitForVerifiedOptions,
  type WaitForVerifiedResult,
} from './waitForVerified.js';

export class Contests {
  private readonly cache = new ScriptsCache();

  constructor(private readonly ctx: ContestsContext) {}

  // ── Reads ─────────────────────────────────────────────────────────

  scripts(): Promise<ApprovedScripts> {
    return this.cache.get(this.ctx);
  }

  /** Drop the cached scripts() result — useful right after a re-sign. */
  invalidateScriptsCache(): void {
    this.cache.invalidate();
  }

  get(contestId: string | number | bigint): Promise<Contest> {
    return get(this.ctx, contestId);
  }

  list(options: ContestsListOptions = {}): Promise<Contest[]> {
    return list(this.ctx, options);
  }

  /**
   * Subscribe to live contest lifecycle deltas (SSE), optionally scoped to a
   * `contestId`. Delivers `ContestUpdate` rows — status / score / verified /
   * scored / voided transitions — NOT the full `Contest` (speculations have
   * their own stream; detail enrichment stays on `contests.get`). Apply
   * last-received-wins per `contestId`.
   *
   * `onSnapshot` fires only when scoped to a `contestId` (projected from the
   * detail endpoint); an unscoped subscription streams from connect with no
   * snapshot.
   */
  async subscribe(
    filters: ContestsSubscribeFilters,
    handlers: StreamSubscribeHandlers<ContestUpdate>,
  ): Promise<Subscription> {
    const contestId = filters.contestId;
    return subscribeToStream<ContestUpdate>({
      api: this.ctx.api,
      resource: 'contests',
      filters: { contestId },
      decode: decodeContestUpdate,
      handlers,
      ...(contestId !== undefined
        ? {
            snapshot: async (): Promise<ContestUpdate[]> => [
              contestToUpdate(await this.get(contestId)),
            ],
          }
        : {}),
    });
  }

  waitForVerified(
    contestId: bigint | string | number,
    options: WaitForVerifiedOptions = {},
  ): Promise<WaitForVerifiedResult> {
    return waitForVerified(this.ctx, contestId, options);
  }

  // ── Writes ────────────────────────────────────────────────────────

  create(args: CreateContestArgs): Promise<CreateContestResult> {
    return create(this.ctx, args, this.cache);
  }

  score(args: ScoreContestArgs): Promise<ScoreContestResult> {
    return score(this.ctx, args, this.cache);
  }

  /** Approve OracleModule to spend LINK from the connected wallet. */
  approveLink(amount: ApproveArgs): Promise<ApproveResult> {
    return approveLink(this.ctx, amount);
  }

  /** Approve TreasuryModule to spend USDC for the contest creation fee. */
  approveFee(amount: ApproveArgs): Promise<ApproveResult> {
    return approveFee(this.ctx, amount);
  }
}

export type { ApproveArgs, ApproveResult } from './approve.js';
export type { CreateContestArgs, CreateContestResult } from './create.js';
export type { ScoreContestArgs, ScoreContestResult } from './score.js';
export type { WaitForVerifiedOptions, WaitForVerifiedResult } from './waitForVerified.js';
