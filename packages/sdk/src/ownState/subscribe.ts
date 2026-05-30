/**
 * Composite SSE consumer for `GET /v1/stream/own-state` (own-state SSE
 * plan v4 §2.1). Public surface: {@link OwnState.subscribe}.
 *
 * Connection flow:
 *
 *   COLD START (no cursor)
 *     1. Mint stream-auth bearer (cached + proactively refreshed).
 *     2. Open SSE with `Authorization: Bearer <token>` (no Last-Event-ID).
 *     3. Server emits `event: snapshot` inline. SDK delivers via
 *        `onSnapshot`. If `truncated:true`:
 *          a. Server ends the connection.
 *          b. SDK pages REST `/v1/own-state/snapshot?cursor=` until
 *             a page comes back with `truncated:false`, emitting
 *             `onSnapshot` per page.
 *          c. Reconnect path: outer loop starts a new SSE connection
 *             with `Last-Event-ID = final cursor` (resume path below).
 *     4. Server emits `event: ready`. SDK delivers via `onReady`,
 *        transitions status to `connected`, starts processing live
 *        deltas.
 *
 *   RESUME (cursor present, sent as Last-Event-ID)
 *     1. Bearer mint (cached) + SSE open with both headers.
 *     2. Server emits catchup deltas (`commitment` / `fill` /
 *        `positionStatus`) with their `id:` cursors. SDK delivers each
 *        and advances its running cursor.
 *     3. Server emits `event: ready`. SDK delivers + status → `connected`.
 *     4. Live deltas flow.
 *
 *   RESYNC (server sends `event: resync`)
 *     SDK drops its running cursor and transitions to `resync` status.
 *     Next reconnect is a fresh cold-start (no Last-Event-ID).
 *
 *   DEGRADED (server sends `event: degraded`, or persistent reconnect
 *   failures)
 *     SDK emits `degraded` status. The stream stays in this state until
 *     the next `connected` (server-side: until `positionsTruncated`
 *     clears; client-side: until a successful reconnect completes).
 *
 *   IDLE WATCHDOG
 *     If no SSE frame (event OR heartbeat) lands within
 *     {@link IDLE_TIMEOUT_MS}, the connection is aborted and the outer
 *     loop reconnects with backoff.
 *
 *   TOKEN LIFECYCLE
 *     Tokens cache locally. Each new connection attempt checks freshness
 *     (`now + REFRESH_LEAD_SEC < expiresAt`); stale → re-mint.
 *     401 AUTH_TOKEN_EXPIRED mid-attempt → drop cache + re-mint on the
 *     next attempt. No mid-stream refresh — the bearer is consumed at
 *     connection-open time; the connection is alive until disconnect
 *     regardless of token expiry.
 *
 *   LIFECYCLE INVARIANT
 *     Every async re-entry checks the `closed` flag BEFORE dispatching
 *     to a consumer handler. Per [[feedback_async_lifecycle_invariant]]:
 *     a handler MUST NEVER fire after `unsubscribe()` has been awaited.
 */

import { OspexAPIError, OspexOwnStateError, OspexStreamError } from '../errors.js';
import { mintStreamToken } from './auth.js';
import { OwnStateApi } from '../api/ownState.js';
import { decodeSnapshot, toOwnerCommitment } from './snapshot.js';
import { decodeFill } from '../realtime/decoders.js';
import {
  IDLE_TIMEOUT_MS,
  abortableSleep,
  backoffDelay,
  parseSseStream,
} from '../realtime/sse.js';
import type { ApiClient } from '../api/client.js';
import type {
  OwnerCommitmentBody,
  OwnerStateSnapshotBody,
} from '../api/types.js';
import type {
  OwnerStateSubscribeHandlers,
  OwnerStateSubscribeStatus,
  PositionStatusEvent,
} from '../types/ownState.js';
import type { Subscription } from '../types/odds.js';
import type { ChainId } from '../types/protocol.js';
import type { Fill } from '../types/fill.js';
import type { Hex, Signer } from '../types/signer.js';

/** Refresh the stream-auth token this many seconds before its `expiresAt`. */
const REFRESH_LEAD_SEC = 120;
/**
 * Defensive bound on REST snapshot paging during the truncated cold-start
 * handoff. Matches the per-`getCommitment` ceiling — the same rationale
 * applies (50 × 5000 commitments is well beyond any realistic single
 * maker, and a scan needing more pages signals an upstream pathology
 * rather than a real book size).
 */
const MAX_SNAPSHOT_PAGES = 50;
/**
 * Consecutive failed-reconnect attempts before status flips from
 * `reconnecting` to `degraded`. The transport keeps retrying past this
 * threshold — the status change is a signal to consumers that the
 * baseline has been unreachable long enough to warrant quote-hold per
 * spec §2.6, even though we never gave up. Mirrors `POLL_FALLBACK_THRESHOLD`
 * in `realtime/stream.ts` (3) so the two protocol surfaces present a
 * consistent degraded model.
 */
const PERSISTENT_FAILURE_THRESHOLD = 3;

export interface SubscribeArgs {
  api: ApiClient;
  signer: Signer;
  address: Hex;
  chainId: ChainId;
  matchingModule: Hex;
}

export type ConnectOutcome = 'ended' | 'resync' | 'fatal';

export function subscribeToOwnState(
  args: SubscribeArgs,
  handlers: OwnerStateSubscribeHandlers,
): Subscription {
  let closed = false;
  /** Opaque cursor — set when a `id:` lands on a delivered event. */
  let cursor: string | undefined;
  let attempt = 0;
  let lastStatus: OwnerStateSubscribeStatus | undefined;
  /** Cached bearer; refreshed proactively or after 401. */
  let cachedToken: { token: string; expiresAt: number } | undefined;
  /**
   * After receiving a truncated `event: snapshot`, the SDK must page REST
   * until drained. This handoff is one-shot per cold start; the cursor
   * to start paging from lands here.
   */
  let pendingPagingCursor: string | undefined;

  const lifecycle = new AbortController();

  const emitStatus = (s: OwnerStateSubscribeStatus): void => {
    if (closed || lastStatus === s) return;
    lastStatus = s;
    try {
      handlers.onStatus?.(s);
    } catch {
      /* consumer handler threw — never let it break the transport */
    }
  };

  const emitError = (
    reason: import('../errors.js').OspexStreamReason,
    message: string,
    status?: number,
    cause?: unknown,
  ): void => {
    if (closed) return;
    try {
      handlers.onError?.(
        new OspexStreamError(message, {
          reason,
          ...(status !== undefined ? { status } : {}),
          ...(cause !== undefined ? { cause } : {}),
        }),
      );
    } catch {
      /* ignore */
    }
  };

  /**
   * Resolve a fresh-enough bearer token, minting if missing or near
   * expiry. The cached token survives across reconnect attempts so a
   * mid-stream drop doesn't burn a fresh challenge mint every time.
   */
  const getValidToken = async (): Promise<string | null> => {
    if (closed) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (cachedToken && nowSec + REFRESH_LEAD_SEC < cachedToken.expiresAt) {
      return cachedToken.token;
    }
    const minted = await mintStreamToken({
      api: args.api,
      signer: args.signer,
      address: args.address,
      chainId: args.chainId,
      matchingModule: args.matchingModule,
    });
    if (closed) return null;
    cachedToken = { token: minted.token, expiresAt: minted.expiresAt };
    return minted.token;
  };

  /**
   * Page REST `/v1/own-state/snapshot?cursor=` from `startCursor` until
   * `truncated:false`. Emits `onSnapshot` per page. Returns the final
   * `k='live'` cursor for the next SSE reconnect.
   *
   * Throws `OspexOwnStateError({reason:'scan_limit_exceeded'})` if the
   * `MAX_SNAPSHOT_PAGES` defensive bound fires while the server is
   * still returning `truncated:true` — same UNKNOWN-vs-null discipline
   * as `getOwnerCommitment` per [[feedback_defensive_bounds_unknown_not_null]].
   */
  const pageRestUntilLive = async (startCursor: string): Promise<string | null> => {
    let pageCursor = startCursor;
    const ownStateApi = new OwnStateApi(args.api);
    for (let i = 0; i < MAX_SNAPSHOT_PAGES; i += 1) {
      if (closed) return null;

      // Token mint must be wrapped — `mintStreamToken` can throw on
      // signer / challenge-mint failure, and a throw mid-paging used to
      // propagate out as an unhandled rejection and kill the subscriber
      // silently. Surface via onError and signal "paging failed" so the
      // outer loop clears state and cold-starts.
      let token: string | null;
      try {
        token = await getValidToken();
      } catch (err) {
        if (closed) return null;
        emitError(
          'connection_failed',
          'own-state REST paging: token mint failed.',
          undefined,
          err,
        );
        return null;
      }
      if (token === null || closed) return null;

      let wire: OwnerStateSnapshotBody;
      try {
        wire = await ownStateApi.snapshot(token, { cursor: pageCursor });
      } catch (err) {
        if (closed) return null;
        if (err instanceof OspexAPIError && err.status === 401) {
          // Token rejected — drop cache so the next iteration re-mints.
          cachedToken = undefined;
          // Don't retry indefinitely; surface this loop as failed so the
          // outer reconnect can decide.
          emitError('connection_failed', 'own-state REST paging auth failed.', 401, err);
          return null;
        }
        emitError(
          'connection_failed',
          'own-state REST paging failed.',
          err instanceof OspexAPIError ? err.status : undefined,
          err,
        );
        return null;
      }
      if (closed) return null;

      // Decoder may throw on malformed wire (missing fields, BigInt of
      // junk, etc.). Same recovery as a transport failure — clear state
      // and let the outer loop cold-start.
      let decoded;
      try {
        decoded = decodeSnapshot(wire);
      } catch (err) {
        if (closed) return null;
        emitError(
          'connection_failed',
          'own-state REST paging: failed to decode snapshot body.',
          undefined,
          err,
        );
        return null;
      }
      try {
        handlers.onSnapshot?.(decoded);
      } catch {
        /* ignore */
      }
      if (closed) return null;
      if (!decoded.truncated) return decoded.cursor;
      pageCursor = decoded.cursor;
    }
    // Page bound fired with the server still saying truncated:true. This
    // is UNKNOWN, not a successful drain — surface it as a typed error
    // and stop the loop. Consumers can re-subscribe; the persistent-
    // truncation case is a server pathology rather than a recoverable
    // client-side condition.
    throw new OspexOwnStateError(
      `own-state subscribe truncated-snapshot paging exceeded the defensive page bound (${MAX_SNAPSHOT_PAGES} pages) ` +
        'while the server was still returning truncated:true. The result is UNKNOWN.',
      { reason: 'scan_limit_exceeded', pagesScanned: MAX_SNAPSHOT_PAGES },
    );
  };

  const connectOnce = async (): Promise<ConnectOutcome> => {
    if (closed) return 'ended';

    const ctrl = new AbortController();
    const onLifecycleAbort = (): void => ctrl.abort();
    lifecycle.signal.addEventListener('abort', onLifecycleAbort, { once: true });

    const cleanupAbortListener = (): void => {
      lifecycle.signal.removeEventListener('abort', onLifecycleAbort);
    };

    try {
      const token = await getValidToken();
      if (closed) {
        cleanupAbortListener();
        return 'ended';
      }
      if (token === null) {
        // mintStreamToken threw — should already be caught below; this
        // branch is defensive for the closed-during-mint case.
        cleanupAbortListener();
        return 'ended';
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      };
      if (cursor !== undefined) {
        headers['Last-Event-ID'] = cursor;
      }

      let res: Response;
      try {
        res = await args.api.openStream('/v1/stream/own-state', {
          query: {},
          signal: ctrl.signal,
          headers,
        });
      } catch (err) {
        cleanupAbortListener();
        return classifyConnectError(err);
      }
      if (closed) {
        cleanupAbortListener();
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        return 'ended';
      }

      // Idle watchdog — reset on every frame (events + heartbeats); abort on stall.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
        idleTimer.unref?.();
      };
      armIdle();

      let outcome: ConnectOutcome = 'ended';
      try {
        for await (const frame of parseSseStream(
          res.body as ReadableStream<Uint8Array>,
        )) {
          if (closed) break;
          armIdle();
          if (frame.kind === 'comment') continue;

          switch (frame.event) {
            case 'snapshot': {
              const wire = safeParseSnapshotBody(frame.data);
              if (wire === null) {
                emitError(
                  'connection_failed',
                  'own-state stream: failed to decode snapshot frame.',
                );
                break;
              }
              const decoded = decodeSnapshot(wire);
              if (closed) break;
              try {
                handlers.onSnapshot?.(decoded);
              } catch {
                /* ignore */
              }
              if (decoded.truncated) {
                // CRITICAL: do NOT advance the running cursor on a
                // truncated snapshot frame. The frame's `id:` is a
                // `k='page-*'` cursor (server's response cursor when
                // commitments saturated the per-page bound), NOT a
                // `k='live'` cursor — and the stream handler explicitly
                // 400s on non-live cursors as `Last-Event-ID`. Worse:
                // resuming SSE from a partial baseline (page 1 only)
                // would let `ready` fire with omitted commitments /
                // positions the consumer never saw, breaking the
                // contract in `OwnerStateSubscribeHandlers.onReady`.
                // The REST paging path below promotes `cursor` to the
                // final k='live' value only AFTER `truncated:false`
                // arrives.
                pendingPagingCursor = decoded.cursor;
              } else {
                if (frame.id !== undefined) cursor = frame.id;
              }
              // Note: positionsTruncated may be true. Server will emit
              // `event: degraded` next; we let that drive the status
              // change rather than guessing here.
              break;
            }
            case 'ready': {
              if (closed) break;
              attempt = 0;
              try {
                handlers.onReady?.();
              } catch {
                /* ignore */
              }
              emitStatus('connected');
              break;
            }
            case 'commitment': {
              const wire = safeParseCommitmentBody(frame.data);
              if (wire === null) {
                emitError(
                  'connection_failed',
                  'own-state stream: failed to decode commitment frame.',
                );
                break;
              }
              if (closed) break;
              const decoded = toOwnerCommitment(wire);
              if (frame.id !== undefined) cursor = frame.id;
              try {
                handlers.onCommitment?.(decoded);
              } catch {
                /* ignore */
              }
              break;
            }
            case 'fill': {
              const wire = safeParseJson(frame.data);
              if (wire === undefined) {
                emitError(
                  'connection_failed',
                  'own-state stream: failed to decode fill frame.',
                );
                break;
              }
              if (closed) break;
              let decoded: Fill;
              try {
                decoded = decodeFill(wire);
              } catch (err) {
                emitError(
                  'connection_failed',
                  'own-state stream: failed to decode fill body.',
                  undefined,
                  err,
                );
                break;
              }
              if (frame.id !== undefined) cursor = frame.id;
              try {
                handlers.onFill?.(decoded);
              } catch {
                /* ignore */
              }
              break;
            }
            case 'positionStatus': {
              const wire = safeParseJson(frame.data);
              if (wire === undefined) {
                emitError(
                  'connection_failed',
                  'own-state stream: failed to decode positionStatus frame.',
                );
                break;
              }
              if (closed) break;
              // The wire body shape matches PositionStatusEvent 1:1
              // (core-api `positionStatus.ts:derivePositionStatus` emits
              // exactly this projection). No transformation needed.
              if (frame.id !== undefined) cursor = frame.id;
              try {
                handlers.onPositionStatus?.(wire as PositionStatusEvent);
              } catch {
                /* ignore */
              }
              break;
            }
            case 'resync': {
              // Synchronously latch the cursor-drop so a delivered frame
              // arriving during the abort's await can't re-use the stale
              // cursor.
              cursor = undefined;
              emitStatus('resync');
              outcome = 'resync';
              ctrl.abort();
              break;
            }
            case 'degraded': {
              emitStatus('degraded');
              break;
            }
            default:
              // Unknown event names: ignore (forward-compat with later spec extensions).
              break;
          }
          if (outcome === 'resync') break;
        }
      } catch (err) {
        if (!closed && outcome !== 'resync' && lastStatus !== 'degraded') {
          emitError(
            'connection_failed',
            'own-state stream dropped.',
            undefined,
            err,
          );
        }
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        cleanupAbortListener();
      }

      return outcome;
    } catch (err) {
      cleanupAbortListener();
      return classifyConnectError(err);
    }
  };

  const classifyConnectError = (err: unknown): ConnectOutcome => {
    if (closed) return 'ended';
    if (err instanceof OspexAPIError) {
      const status = err.status;
      if (status === 401) {
        // Bearer rejected. Drop the cached token so the next attempt re-mints.
        cachedToken = undefined;
        if (lastStatus !== 'degraded') {
          emitError(
            'connection_failed',
            'own-state stream auth failed (token rejected).',
            401,
            err,
          );
        }
        return 'ended';
      }
      if (status === 429) {
        emitError(
          'capacity_exceeded',
          'own-state stream capacity reached.',
          status,
          err,
        );
        return 'ended';
      }
      if (status === 400 && err.apiCode === 'INVALID_CURSOR') {
        // Server rejected our cursor — drop it and force a re-snapshot
        // via a cold reconnect. Same recovery as `event: resync`.
        cursor = undefined;
        emitStatus('resync');
        return 'resync';
      }
      if (status === 404) {
        emitError(
          'fatal',
          'own-state stream not available (404). Verify core-api version.',
          status,
          err,
        );
        closed = true;
        return 'fatal';
      }
      if (status === 503) {
        // Server not ready (stream-auth env not configured). Keep
        // reconnecting; this should clear once the operator finishes
        // deploy.
        if (lastStatus !== 'degraded') {
          emitError(
            'connection_failed',
            'own-state stream not ready (503).',
            status,
            err,
          );
        }
        return 'ended';
      }
      if (lastStatus !== 'degraded') {
        emitError(
          'connection_failed',
          `own-state stream connect failed (${status ?? 'unknown'}).`,
          status,
          err,
        );
      }
      return 'ended';
    }
    if (lastStatus !== 'degraded') {
      emitError('connection_failed', 'own-state stream connect failed.', undefined, err);
    }
    return 'ended';
  };

  // Compute the next-reconnect status. Once the consecutive failed
  // attempts cross the persistent-failure threshold, we promote
  // `reconnecting` → `degraded` so consumers know the baseline has
  // been unreachable long enough to warrant quote-hold per spec §2.6.
  // Reset to `connected` on a successful `ready`.
  const nextRetryStatus = (): OwnerStateSubscribeStatus =>
    attempt + 1 >= PERSISTENT_FAILURE_THRESHOLD ? 'degraded' : 'reconnecting';

  // ── reconnect loop ──────────────────────────────────────────────────────
  void (async (): Promise<void> => {
    try {
      while (!closed) {
        // Drain pending REST paging FIRST (cold-start truncation handoff).
        if (pendingPagingCursor !== undefined) {
          const startCursor = pendingPagingCursor;
          pendingPagingCursor = undefined;
          let resumeCursor: string | null;
          try {
            resumeCursor = await pageRestUntilLive(startCursor);
          } catch (err) {
            if (closed) break;
            if (err instanceof OspexOwnStateError) {
              // Persistent server-side truncation. Surface as a fatal-ish
              // error and stop — we don't have a recovery story here.
              emitError(
                'fatal',
                'own-state truncated-snapshot paging exceeded its page bound; subscription stopping.',
                undefined,
                err,
              );
              closed = true;
              break;
            }
            // Any other throw out of REST paging (signer / decoder /
            // unexpected) — surface as a transport error and fall
            // through to clear state + cold-restart, instead of
            // escaping the loop as an unhandled rejection.
            emitError(
              'connection_failed',
              'own-state REST paging crashed unexpectedly.',
              undefined,
              err,
            );
            resumeCursor = null;
          }
          if (closed) break;
          if (resumeCursor === null) {
            // Paging failed mid-flight (auth / transport / decoder /
            // mint). MUST clear `cursor` too — leaving it set to the
            // truncated page-* cursor would (a) get 400 INVALID_CURSOR
            // on the next SSE attempt's Last-Event-ID, AND (b) risk
            // `ready` firing on a partial baseline if the server's
            // resume path tolerated it. Force a clean cold-start.
            cursor = undefined;
            emitStatus(nextRetryStatus());
            await abortableSleep(backoffDelay(attempt), lifecycle.signal);
            attempt += 1;
            continue;
          }
          cursor = resumeCursor;
          // Loop back to reconnect with the new cursor as Last-Event-ID.
          continue;
        }

        const outcome = await connectOnce();
        if (closed || outcome === 'fatal') break;
        if (outcome === 'resync') {
          attempt = 0;
          // Cursor already cleared synchronously at the resync branch.
          continue;
        }
        // outcome === 'ended'. If a snapshot was truncated this round, the
        // pendingPagingCursor is set and the next loop iteration drains
        // REST before reconnecting — handled at the top of the loop.
        if (pendingPagingCursor === undefined) {
          emitStatus(nextRetryStatus());
          await abortableSleep(backoffDelay(attempt), lifecycle.signal);
          attempt += 1;
        }
      }
    } catch (err) {
      // Top-level safety net: any unhandled throw from the loop becomes
      // an `onError(fatal)` instead of escaping as an unhandled
      // rejection (which Node may print as an UnhandledPromiseRejection
      // warning AND leaves the subscription silently dead). Per
      // [[feedback_async_lifecycle_invariant]] — guard every async exit.
      if (!closed) {
        emitError(
          'fatal',
          'own-state subscribe loop crashed unexpectedly; stopping.',
          undefined,
          err,
        );
        closed = true;
      }
    }
  })();

  return {
    async unsubscribe(): Promise<void> {
      if (closed) return;
      closed = true;
      lifecycle.abort();
    },
  };
}

function safeParseJson(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function safeParseSnapshotBody(raw: string | undefined): OwnerStateSnapshotBody | null {
  const v = safeParseJson(raw);
  if (typeof v !== 'object' || v === null) return null;
  // Trust the wire shape — the decoder downstream tolerates pre-effective-status
  // builds and explicit type-check would be heavy for every frame.
  return v as OwnerStateSnapshotBody;
}

function safeParseCommitmentBody(raw: string | undefined): OwnerCommitmentBody | null {
  const v = safeParseJson(raw);
  if (typeof v !== 'object' || v === null) return null;
  return v as OwnerCommitmentBody;
}
