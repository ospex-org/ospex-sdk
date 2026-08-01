/**
 * `client.ownState` — owner-authenticated maker view (own-state SSE plan
 * §2.4). The SDK boundary for the M3+M4 backend pieces (token mint +
 * snapshot REST + composite SSE stream).
 *
 * `snapshot` + `getCommitment` are one-shot REST calls — a fresh token
 * mint per call is the explicit trade-off (see `auth.ts` JSDoc).
 * `subscribe` (M5/PR3c) owns the proactive-refresh state machine
 * because that's the only place a long-lived token actually matters
 * for cost; the cached bearer survives across reconnects and refreshes
 * ~120 s before expiry.
 *
 * The address argument is INTENTIONAL on every method: `client.ownState`
 * is bound to the configured signer, but spec §2.4 takes `{address}` so
 * an integrator that manages multiple wallets through one process can
 * scope reads explicitly. The bearer-token's `address` claim binds to
 * what was passed here (server verifies the signature recovers to it);
 * a mismatched signer is caught server-side with `AUTH_SIGNATURE_INVALID`.
 */

import type { ApiClient } from '../api/client.js';
import type { OspexAddresses } from '../contracts/addresses.js';
import type { ChainId } from '../types/protocol.js';
import type { Hex, Signer } from '../types/signer.js';
import type {
  OwnerCommitment,
  OwnerStateSnapshot,
  OwnerStateSubscribeHandlers,
  OwnStateHealth,
  OwnStateSubscribeOptions,
} from '../types/ownState.js';
import type { Subscription } from '../types/odds.js';
import { loadOwnStateSnapshot } from './snapshot.js';
import { getOwnerCommitment } from './getCommitment.js';
import { loadOwnStateHealth } from './health.js';
import { subscribeToOwnState } from './subscribe.js';

export interface OwnStateContext {
  api: ApiClient;
  requireSigner: () => Signer;
  getChainId: () => ChainId;
  getAddresses: () => OspexAddresses;
}

export interface OwnStateSnapshotOptions {
  /**
   * Wallet address the snapshot is scoped to. The signer MUST own this
   * address — server-side recovery rejects otherwise. Required (no implicit
   * resolve-from-signer) so the call is explicit at every site.
   */
  address: Hex;
  /**
   * Opaque cursor from a prior `snapshot()` call. Pass back to page
   * through a truncated snapshot. Omit for the first call.
   */
  cursor?: string;
}

export interface OwnStateGetCommitmentOptions {
  /** Wallet address — see {@link OwnStateSnapshotOptions.address}. */
  address: Hex;
  /** 0x-prefixed 32-byte EIP-712 commitment hash. */
  hash: Hex;
}

export class OwnState {
  constructor(private readonly ctx: OwnStateContext) {}

  /**
   * Fetch ONE PAGE of the maker's owner-auth state snapshot. Mints a fresh
   * bearer token per call. When `result.truncated === true`, call again
   * with `{cursor: result.cursor}` to drain remaining pages — callers
   * that need the FULL commitment set MUST loop until `truncated:false`
   * (a single-page read can leave higher-nonce hidden commitments off
   * the result; see {@link OwnerStateSnapshot} for the canonical loop).
   *
   * Returns: owner commitments on this page (visible + hidden + recently-
   * terminal-since-cursor, with full payload regardless of `book_visible`),
   * the page's categorized positions (active / pendingSettle / claimable
   * / claimed), and the cursor for the next page (or for the next
   * subscribe-reconnect via `Last-Event-ID`).
   */
  async snapshot(options: OwnStateSnapshotOptions): Promise<OwnerStateSnapshot> {
    const { matchingModule } = this.ctx.getAddresses();
    const args: Parameters<typeof loadOwnStateSnapshot>[0] = {
      api: this.ctx.api,
      signer: this.ctx.requireSigner(),
      address: options.address,
      chainId: this.ctx.getChainId(),
      matchingModule,
    };
    if (options.cursor !== undefined) args.cursor = options.cursor;
    return loadOwnStateSnapshot(args);
  }

  /**
   * Owner-authenticated low-frequency recovery helper. Returns the full
   * {@link OwnerCommitment} for `hash` IF it's in the maker's own-state
   * snapshot scope (active + recently-terminal-since-prior-cursor), OR
   * `null` when the snapshot fully drained without containing it.
   *
   * **`null` is NOT "doesn't exist"** — it's "outside the drained
   * snapshot scope". For arbitrary owner-auth-by-hash over the full
   * maker history, a dedicated `/v1/own-state/commitments/:hash`
   * endpoint is the future answer (not in this PR).
   *
   * Throws `OspexOwnStateError({reason: 'scan_limit_exceeded'})` when
   * the defensive page bound is reached and the server is still
   * returning `truncated:true` — the result is UNKNOWN, not `null`.
   *
   * Pages the snapshot internally up to a defensive cap; mints exactly
   * one bearer token regardless of page count.
   */
  async getCommitment(
    options: OwnStateGetCommitmentOptions,
  ): Promise<OwnerCommitment | null> {
    const { matchingModule } = this.ctx.getAddresses();
    return getOwnerCommitment({
      api: this.ctx.api,
      signer: this.ctx.requireSigner(),
      address: options.address,
      chainId: this.ctx.getChainId(),
      matchingModule,
      hash: options.hash,
    });
  }

  /**
   * Composite SSE subscription to the maker's own-state stream
   * (`GET /v1/stream/own-state`). Delivers:
   *
   *   - `onSnapshot` — for every snapshot page (cold-start inline + any
   *     REST paging triggered by `truncated:true`);
   *   - `onReady` — after the final untruncated snapshot page (cold-
   *     start) or after server catchup (resume reconnect) — "safe to
   *     resume trading" signal;
   *   - `onCommitment` / `onFill` / `onPositionStatus` — per-resource
   *     deltas (full owner-auth payload on commitment);
   *   - `onStatus` — `'connected' | 'reconnecting' | 'degraded' | 'resync'`;
   *   - `onError` — non-fatal transport errors (transient drops; SDK
   *     keeps reconnecting unless fatal).
   *
   * Token lifecycle is internal: the SDK caches the bearer minted via
   * the M3 challenge/token flow and proactively refreshes ~120 s before
   * expiry, NON-INTERACTIVELY (BYO posture — `KeystoreSigner` has its
   * passphrase already resolved). On 401 mid-stream the cached token is
   * dropped and re-minted on the next reconnect attempt.
   *
   * Reconnects with `Last-Event-ID = <running cursor>` and resumes
   * server catchup. A server-side `event: resync` drops the cursor and
   * the next reconnect is a fresh cold-start.
   *
   * The returned `Subscription.unsubscribe()` is the ONLY way to close
   * — handlers NEVER fire after `await sub.unsubscribe()` returns.
   */
  /**
   * Fetch the protocol's current indexer-lag health for the own-state surface
   * (own-state SSE plan §2.6 + §3.3). PUBLIC — no signer / token, takes no
   * arguments: lag is a global, wallet-independent signal. Consumers building
   * a stream-health gate poll this once per tick (the reference market-maker
   * uses 60s by default) and hold quoting when `indexerLagSeconds` crosses
   * their threshold. Note the value sawtooths roughly 0 → 15s when the indexer
   * is caught up, so a threshold inside that band can read as degraded on a
   * healthy indexer — see {@link OwnStateHealth}.
   */
  async health(): Promise<OwnStateHealth> {
    return loadOwnStateHealth(this.ctx.api);
  }

  subscribe(
    options: OwnStateSubscribeOptions,
    handlers: OwnerStateSubscribeHandlers,
  ): Subscription {
    const { matchingModule } = this.ctx.getAddresses();
    const args: Parameters<typeof subscribeToOwnState>[0] = {
      api: this.ctx.api,
      signer: this.ctx.requireSigner(),
      address: options.address,
      chainId: this.ctx.getChainId(),
      matchingModule,
    };
    if (options.initialCursor !== undefined) {
      args.initialCursor = options.initialCursor;
    }
    return subscribeToOwnState(args, handlers);
  }
}
