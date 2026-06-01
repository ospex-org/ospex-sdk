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
  OwnStateEventMeta,
  OwnerStateSubscribeHandlers,
  OwnerStateSubscribeStatus,
  PositionStatusEvent,
} from '../types/ownState.js';
import type { Subscription } from '../types/odds.js';
import type { ChainId } from '../types/protocol.js';
import type { Fill } from '../types/fill.js';
import type { Hex, Signer } from '../types/signer.js';
import type { OspexStreamErrorPhase } from '../errors.js';

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
  /**
   * Persisted cursor from a prior session — sent as `Last-Event-ID` on the
   * FIRST connect attempt. Lets a consumer (e.g. the market-maker) resume
   * server-side replay after a process restart without losing events.
   * Omit on first-ever connect.
   */
  initialCursor?: string;
}

export type ConnectOutcome = 'ended' | 'resync' | 'fatal';

export function subscribeToOwnState(
  args: SubscribeArgs,
  handlers: OwnerStateSubscribeHandlers,
): Subscription {
  let closed = false;
  /**
   * Opaque cursor — advances AFTER successful handler dispatch on each
   * event delivery (v0.5.2 dispatch model: decode → meta → invoke →
   * advance-only-after-success). Seeded with the consumer-provided
   * `initialCursor` so the first connect carries the persisted resume
   * position as `Last-Event-ID`.
   */
  let cursor: string | undefined = args.initialCursor;
  let attempt = 0;
  let lastStatus: OwnerStateSubscribeStatus | undefined;
  /**
   * Set after the first successful `event: ready` of the lifetime of this
   * subscription. Used to disambiguate `phase: 'token-mint'` (initial mint
   * before any successful baseline) from `phase: 'token-refresh'` (re-mint
   * during an active subscription) for consumer health gates that latch
   * differently on each — per own-state SSE plan §2.6 + Hermes Phase 3
   * v2-feedback amendment 3.
   */
  let hasEverConnected = false;
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
    status: number | undefined,
    cause: unknown,
    phase: OspexStreamErrorPhase | undefined,
  ): void => {
    if (closed) return;
    try {
      handlers.onError?.(
        new OspexStreamError(message, {
          reason,
          ...(status !== undefined ? { status } : {}),
          ...(cause !== undefined ? { cause } : {}),
          ...(phase !== undefined ? { phase } : {}),
        }),
      );
    } catch {
      /* ignore */
    }
  };

  /**
   * Dispatch a typed handler with cursor-advance-on-success semantics
   * (v0.5.2 dispatch model). Returns `true` if the handler succeeded (or
   * was absent — same effect), `false` if it threw. Callers gate the
   * cursor-advance on the return value so a thrown handler leaves the
   * running cursor at the prior position; on next reconnect the server
   * replays from there via Last-Event-ID overlap.
   */
  const dispatchTyped = <T>(
    handler: ((body: T, meta: OwnStateEventMeta) => void) | undefined,
    body: T,
    meta: OwnStateEventMeta,
    kindLabel: string,
  ): boolean => {
    if (handler === undefined) return true;
    try {
      handler(body, meta);
      return true;
    } catch (err) {
      emitError(
        'connection_failed',
        `own-state ${kindLabel} handler threw; cursor not advanced.`,
        undefined,
        err,
        'dispatch',
      );
      return false;
    }
  };

  /**
   * Fire `onFrame` for every parsed frame including SSE heartbeats. Caller
   * passes `kind` so a quiet wallet's heartbeats still drive the
   * `transportFresh` health predicate consumers like the market-maker
   * derive from `receivedAtMs`. A throw inside the consumer's `onFrame`
   * is surfaced via `onError({phase: 'dispatch'})` but does NOT block the
   * downstream typed-event dispatch.
   */
  const fireFrame = (kind: 'event' | 'heartbeat'): void => {
    if (handlers.onFrame === undefined) return;
    try {
      handlers.onFrame({ receivedAtMs: Date.now(), kind });
    } catch (err) {
      emitError(
        'connection_failed',
        'own-state onFrame handler threw.',
        undefined,
        err,
        'dispatch',
      );
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
        // Mid-paging token mint failure — classify as token-mint per
        // [[feedback_failure_envelope_mirror_success]]: the consumer's
        // health gate latches on `phase: 'token-mint'` whether the failure
        // happened on initial connect or mid-paging.
        emitError(
          'connection_failed',
          'own-state REST paging: token mint failed.',
          undefined,
          err,
          'token-mint',
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
          emitError(
            'connection_failed',
            'own-state REST paging auth failed.',
            401,
            err,
            'snapshot-page',
          );
          return null;
        }
        emitError(
          'connection_failed',
          'own-state REST paging failed.',
          err instanceof OspexAPIError ? err.status : undefined,
          err,
          'snapshot-page',
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
          'decode',
        );
        return null;
      }
      // REST snapshot pages have no SSE-level cursor — pass empty string
      // so consumers know not to use this meta.cursor as a Last-Event-ID
      // resume point. The SSE-level resume cursor is the running `cursor`
      // (last advanced AT a delivered SSE event/ready), not this REST page
      // boundary.
      //
      // v0.5.2 dispatch model: cursor-advance-on-success doesn't apply to
      // REST pages (no SSE cursor to advance), but a thrown consumer
      // handler still surfaces via onError({phase: 'dispatch'}) so the
      // consumer can latch a dispatch-failure health predicate.
      const restMeta: OwnStateEventMeta = { cursor: '' };
      dispatchTyped(handlers.onSnapshot, decoded, restMeta, 'REST snapshot');
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
      // Wrap the token resolution so we can classify a throw with the
      // right phase (mint vs refresh). Pre-first-ready throws are
      // 'token-mint'; post-ready throws are 'token-refresh' so the
      // consumer's health gate latches `tokenRefreshFailureInFlight`
      // only on the latter (per spec §2.6).
      let token: string | null;
      try {
        token = await getValidToken();
      } catch (err) {
        cleanupAbortListener();
        if (closed) return 'ended';
        if (lastStatus !== 'degraded') {
          emitError(
            'connection_failed',
            'own-state stream: token resolution failed.',
            undefined,
            err,
            hasEverConnected ? 'token-refresh' : 'token-mint',
          );
        }
        return 'ended';
      }
      if (closed) {
        cleanupAbortListener();
        return 'ended';
      }
      if (token === null) {
        // getValidToken returned null because `closed` was set during
        // the await — the connection is shutting down. Defensive.
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
          // `onFrame` fires for EVERY parsed frame including heartbeat
          // comments — the consumer's `transportFresh` health predicate
          // needs to stay fresh on a quiet wallet that produces no domain
          // events. Per-frame surfacing landed in v0.5.2.
          if (frame.kind === 'comment') {
            fireFrame('heartbeat');
            continue;
          }
          fireFrame('event');

          // v0.5.2 dispatch model — decode → meta → invoke → advance only
          // after successful handler return. A thrown handler does NOT
          // advance the running cursor; on next reconnect the server
          // replays from the prior cursor via Last-Event-ID overlap.
          // Pre-v0.5.2 advanced cursor BEFORE the handler and swallowed
          // throws — that combination silently dropped an event from the
          // SDK's restart-safety guarantee.
          const candidateCursor = frame.id;
          const meta: OwnStateEventMeta = { cursor: candidateCursor ?? cursor ?? '' };

          switch (frame.event) {
            case 'snapshot': {
              const wire = safeParseSnapshotBody(frame.data);
              if (wire === null) {
                emitError(
                  'connection_failed',
                  'own-state stream: failed to decode snapshot frame.',
                  undefined,
                  undefined,
                  'decode',
                );
                break;
              }
              const decoded = decodeSnapshot(wire);
              if (closed) break;
              const ok = dispatchTyped(handlers.onSnapshot, decoded, meta, 'snapshot');
              if (!ok) break; // handler threw — leave cursor at prior position
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
                // The REST paging path above promotes `cursor` to the
                // final k='live' value only AFTER `truncated:false`
                // arrives.
                pendingPagingCursor = decoded.cursor;
              } else {
                if (candidateCursor !== undefined) cursor = candidateCursor;
              }
              // Note: positionsTruncated may be true. Server will emit
              // `event: degraded` next; we let that drive the status
              // change rather than guessing here.
              break;
            }
            case 'ready': {
              if (closed) break;
              attempt = 0;
              hasEverConnected = true;
              // onReady runs through the same dispatch helper for
              // throw-discipline parity, even though there's no body to
              // decode. A throw here surfaces via onError({phase:
              // 'dispatch'}); the cursor advance is gated on success so a
              // consumer that performs the baseline-swap inside onReady
              // (per MM PR1 §4.3) gets the advance ↔ swap atomicity.
              const okReady = dispatchTyped<undefined>(
                handlers.onReady === undefined
                  ? undefined
                  : (_body, m) => handlers.onReady!(m),
                undefined,
                meta,
                'ready',
              );
              emitStatus('connected');
              if (okReady && candidateCursor !== undefined) cursor = candidateCursor;
              break;
            }
            case 'commitment': {
              const wire = safeParseCommitmentBody(frame.data);
              if (wire === null) {
                emitError(
                  'connection_failed',
                  'own-state stream: failed to decode commitment frame.',
                  undefined,
                  undefined,
                  'decode',
                );
                break;
              }
              if (closed) break;
              const decoded = toOwnerCommitment(wire);
              const ok = dispatchTyped(handlers.onCommitment, decoded, meta, 'commitment');
              if (ok && candidateCursor !== undefined) cursor = candidateCursor;
              break;
            }
            case 'fill': {
              const wire = safeParseJson(frame.data);
              if (wire === undefined) {
                emitError(
                  'connection_failed',
                  'own-state stream: failed to decode fill frame.',
                  undefined,
                  undefined,
                  'decode',
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
                  'decode',
                );
                break;
              }
              const ok = dispatchTyped(handlers.onFill, decoded, meta, 'fill');
              if (ok && candidateCursor !== undefined) cursor = candidateCursor;
              break;
            }
            case 'positionStatus': {
              const wire = safeParseJson(frame.data);
              if (wire === undefined) {
                emitError(
                  'connection_failed',
                  'own-state stream: failed to decode positionStatus frame.',
                  undefined,
                  undefined,
                  'decode',
                );
                break;
              }
              if (closed) break;
              // The wire body shape matches PositionStatusEvent 1:1
              // (core-api `positionStatus.ts:derivePositionStatus` emits
              // exactly this projection). No transformation needed.
              const ok = dispatchTyped(
                handlers.onPositionStatus,
                wire as PositionStatusEvent,
                meta,
                'positionStatus',
              );
              if (ok && candidateCursor !== undefined) cursor = candidateCursor;
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
            'connect',
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
        // Phase = token-refresh: we had a cached token + had already minted
        // at least once; this is a refresh path failure (the consumer's
        // health gate latches `tokenRefreshFailureInFlight` on it).
        cachedToken = undefined;
        if (lastStatus !== 'degraded') {
          emitError(
            'connection_failed',
            'own-state stream auth failed (token rejected).',
            401,
            err,
            'token-refresh',
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
          'connect',
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
          'connect',
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
            'connect',
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
          'connect',
        );
      }
      return 'ended';
    }
    if (lastStatus !== 'degraded') {
      emitError(
        'connection_failed',
        'own-state stream connect failed.',
        undefined,
        err,
        'connect',
      );
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
                'snapshot-page',
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
              'snapshot-page',
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
          'connect',
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
