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
import { match, type MatchArgs, type MatchResult } from './match.js';
import { submit, type SubmitArgs, type SubmitResult } from './submit.js';

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

  submit(args: SubmitArgs): Promise<SubmitResult> {
    return submit(this.ctx, args);
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
}

export type { ApproveArgs, ApproveResult } from './approve.js';
export type { CancelResult } from './cancel.js';
export type { MatchArgs, MatchResult } from './match.js';
export type { SubmitArgs, SubmitResult } from './submit.js';
