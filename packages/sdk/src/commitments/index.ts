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
import { OspexValidationError } from '../errors.js';
import type { CommitmentsContext } from './context.js';
import type { Commitment, CommitmentsListOptions } from '../types/commitment.js';
import type { Hex } from '../types/signer.js';
import type { HighLevelSubmitArgs, SubmitPreview } from '../types/preview.js';
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
import { prepareSubmit } from './prepareSubmit.js';
import {
  raiseMinNonce,
  type RaiseMinNonceArgs,
  type RaiseMinNonceResult,
} from './raiseMinNonce.js';
import { submitPrepared } from './submitPrepared.js';
import { submitRaw, type RawSubmitArgs, type SubmitResult } from './submitRaw.js';

/**
 * Optional confirmation hook on the convenience `submit(args, opts)`.
 * Receives the resolved preview before signing; returning false aborts
 * with `OspexValidationError('cancelled')`. Suitable for CLI prompts
 * and agent decision-makers.
 */
export interface SubmitConfirmHook {
  confirm?: (preview: SubmitPreview) => Promise<boolean>;
}

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
   * Resolve high-level args into a structured preview without signing.
   * The CLI uses this to render the confirmation prompt; agents use it
   * to inspect the full resolved tuple (sides, line, economics, raw
   * EIP-712 fields, allowance state, win/lose/push outcomes) before
   * committing.
   */
  prepareSubmit(args: HighLevelSubmitArgs): Promise<SubmitPreview> {
    return prepareSubmit(this.ctx, args);
  }

  /**
   * Sign + post a previously-prepared submit. Signs `preview.raw`
   * exactly; does NOT silently change nonce / expiry / tuple fields.
   * On `NONCE_TOO_LOW` from the API, throws OspexAPIError so the
   * caller can re-run prepareSubmit and re-confirm.
   */
  submitPrepared(preview: SubmitPreview): Promise<SubmitResult> {
    return submitPrepared(this.ctx, preview);
  }

  /**
   * Convenience: prepareSubmit → optional confirm callback →
   * submitPrepared in one call. The confirm hook is the CLI's seam
   * for the `[Y/n]` prompt; agents pass `confirm: async () => true`
   * (or omit `confirm` entirely) to skip.
   */
  async submit(args: HighLevelSubmitArgs & SubmitConfirmHook): Promise<SubmitResult> {
    const { confirm, ...rest } = args;
    const preview = await this.prepareSubmit(rest);
    if (confirm !== undefined) {
      const ok = await confirm(preview);
      if (!ok) {
        throw new OspexValidationError('Submit cancelled by user.');
      }
    }
    return this.submitPrepared(preview);
  }

  /**
   * Protocol-level escape hatch for advanced operators with canonical
   * tuple values already in hand. Most callers should use the
   * high-level `submit(args)` which renders a domain-language preview
   * before signing.
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
