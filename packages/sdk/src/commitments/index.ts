/**
 * Commitments namespace — composes the M1 read methods (`list`,
 * `get`) with the M2 write methods (`submit`, `match`, `approve`,
 * `cancel`) on a single `client.commitments` object.
 *
 * Reads work without `rpcUrl` or `signer`. Write methods throw
 * `OspexConfigError` if either is missing — they look up their
 * dependencies through the CommitmentsContext lazily so the parent
 * `OspexClient` doesn't have to construct a chain client until a
 * write actually fires.
 */

import { CommitmentsApi } from '../api/commitments.js';
import type { CommitmentsContext } from './context.js';
import type { Commitment, CommitmentsListOptions } from '../types/commitment.js';
import type { Hex } from '../types/signer.js';
import { approve, type ApproveArgs, type ApproveResult } from './approve.js';
import { cancel, type CancelResult } from './cancel.js';
import {
  cancelAllOnSpeculation,
  type CancelAllOnSpeculationArgs,
  type CancelAllOnSpeculationResult,
} from './cancelAllOnSpeculation.js';
import {
  cancelOnchain,
  type CancelOnchainResult,
} from './cancelOnchain.js';
import { getNonceFloor, type GetNonceFloorArgs } from './getNonceFloor.js';
import { match, type MatchArgs, type MatchResult } from './match.js';
import {
  raiseMinNonce,
  type RaiseMinNonceArgs,
  type RaiseMinNonceResult,
} from './raiseMinNonce.js';
import { submitRaw, type RawSubmitArgs, type SubmitResult } from './submitRaw.js';

export class Commitments {
  private readonly api: CommitmentsApi;

  constructor(private readonly ctx: CommitmentsContext) {
    this.api = new CommitmentsApi(ctx.api);
  }

  // ── Reads (M1 carry-over + M2 fetch-by-hash) ──────────────────────

  list(options: CommitmentsListOptions = {}): Promise<Commitment[]> {
    return this.api.list(options);
  }

  get(hash: Hex): Promise<Commitment> {
    return this.api.get(hash);
  }

  // ── Writes (M2) ───────────────────────────────────────────────────

  /**
   * Protocol-level escape hatch for advanced operators with canonical
   * tuple values already in hand. Most callers should use the high-level
   * `submit` (PR C) which renders a domain-language preview before
   * signing.
   */
  submitRaw(args: RawSubmitArgs): Promise<SubmitResult> {
    return submitRaw(this.ctx, args);
  }

  match(hash: Hex, opts: MatchArgs = {}): Promise<MatchResult> {
    return match(this.ctx, hash, opts);
  }

  approve(amount: ApproveArgs): Promise<ApproveResult> {
    return approve(this.ctx, amount);
  }

  cancel(hash: Hex): Promise<CancelResult> {
    return cancel(this.ctx, hash);
  }

  // ── On-chain cancel + nonce floor (M2.5) ──────────────────────────

  cancelOnchain(hash: Hex): Promise<CancelOnchainResult> {
    return cancelOnchain(this.ctx, hash);
  }

  raiseMinNonce(args: RaiseMinNonceArgs): Promise<RaiseMinNonceResult> {
    return raiseMinNonce(this.ctx, args);
  }

  cancelAllOnSpeculation(
    args: CancelAllOnSpeculationArgs,
  ): Promise<CancelAllOnSpeculationResult> {
    return cancelAllOnSpeculation(this.ctx, args);
  }

  getNonceFloor(args: GetNonceFloorArgs): Promise<bigint> {
    return getNonceFloor(this.ctx, args);
  }
}

export type { ApproveArgs, ApproveResult } from './approve.js';
export type { CancelResult } from './cancel.js';
export type {
  CancelAllOnSpeculationArgs,
  CancelAllOnSpeculationResult,
} from './cancelAllOnSpeculation.js';
export type { CancelOnchainResult } from './cancelOnchain.js';
export type { GetNonceFloorArgs } from './getNonceFloor.js';
export type { MatchArgs, MatchResult } from './match.js';
export type { RaiseMinNonceArgs, RaiseMinNonceResult } from './raiseMinNonce.js';
export type { RawSubmitArgs, SubmitResult } from './submitRaw.js';
