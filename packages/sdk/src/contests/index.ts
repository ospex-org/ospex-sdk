/**
 * Contests namespace — composes the R5/CRE contest lifecycle
 * (create, score, requestMarketUpdate) with read helpers (get, list,
 * waitForVerified) on a single `client.contests` object.
 *
 * Reads work without `rpcUrl` or `signer`. Write methods (create, score,
 * requestMarketUpdate, waitForVerified) throw `OspexConfigError` if either is
 * missing — they resolve dependencies through ContestsContext lazily so the
 * parent OspexClient doesn't construct a chain client until a write fires.
 */
import type {
  Contest,
  ContestsListOptions,
  ContestUpdate,
} from '../types/contest.js';
import type { ContestsContext } from './context.js';
import type { Subscription } from '../types/odds.js';
import type { ContestsSubscribeFilters, StreamSubscribeHandlers } from '../types/stream.js';
import { subscribeToStream } from '../realtime/stream.js';
import { contestToUpdate, decodeContestUpdate } from '../realtime/decoders.js';
import { normalizeUint } from '../realtime/filters.js';
import {
  approveFee,
  type ApproveArgs,
  type ApproveResult,
} from './approve.js';
import { create, type CreateContestArgs, type CreateContestResult } from './create.js';
import { get } from './get.js';
import { list } from './list.js';
import {
  requestMarketUpdate,
  type RequestMarketUpdateArgs,
  type RequestMarketUpdateResult,
} from './marketUpdate.js';
import { score, type ScoreContestArgs, type ScoreContestResult } from './score.js';
import {
  waitForVerified,
  type WaitForVerifiedOptions,
  type WaitForVerifiedResult,
} from './waitForVerified.js';

export class Contests {
  constructor(private readonly ctx: ContestsContext) {}

  // ── Reads ─────────────────────────────────────────────────────────

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
    const contestId = normalizeUint(filters.contestId, 'contestId');
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
    return create(this.ctx, args);
  }

  score(args: ScoreContestArgs): Promise<ScoreContestResult> {
    return score(this.ctx, args);
  }

  /**
   * Request a market-line refresh for a Verified contest (permissionless,
   * free). Bumps the contest's market nonce and emits a CRE request; the
   * refreshed odds land asynchronously via the CRE oracle report.
   */
  requestMarketUpdate(args: RequestMarketUpdateArgs): Promise<RequestMarketUpdateResult> {
    return requestMarketUpdate(this.ctx, args);
  }

  /** Approve TreasuryModule to spend USDC for the contest creation fee. */
  approveFee(amount: ApproveArgs): Promise<ApproveResult> {
    return approveFee(this.ctx, amount);
  }
}

export type { ApproveArgs, ApproveResult } from './approve.js';
export type { CreateContestArgs, CreateContestResult } from './create.js';
export type { RequestMarketUpdateArgs, RequestMarketUpdateResult } from './marketUpdate.js';
export type { ScoreContestArgs, ScoreContestResult } from './score.js';
export type { WaitForVerifiedOptions, WaitForVerifiedResult } from './waitForVerified.js';
