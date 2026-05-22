/**
 * fetch-based SSE transport for the Ospex odds stream
 * (`client.odds.subscribe`). One transport per subscription; all state is
 * closure-local (no module-level state), so multiple clients and multiple
 * subscriptions are fully isolated.
 *
 * Odds is latest-state, not a durable log. The server sends a `snapshot`
 * baseline once the source is confirmed live, then classified `change` /
 * `refresh` deltas; `degraded` means the upstream source fell behind and
 * updates are paused until the next `snapshot`. There is no cursor, no replay,
 * and no resync — on a dropped connection the transport reconnects (full-jitter
 * backoff) and the server re-sends a fresh `snapshot`. A stalled stream (no
 * event or heartbeat within the idle window) is treated as dropped.
 *
 * Lifecycle invariant: once the subscription is closed, no handler fires again.
 * A consumer may unsubscribe from inside any handler, so every handler-call
 * site is guarded — including the gap between the snapshot delivery and the
 * `connected` status that follows it.
 */

import { OspexAPIError, OspexStreamError, type OspexStreamReason } from '../errors.js';
import type { ApiClient } from '../api/client.js';
import type { OddsSubscribeHandlers, Subscription } from '../types/odds.js';
import type { StreamStatus } from '../types/stream.js';
import { IDLE_TIMEOUT_MS, abortableSleep, backoffDelay, parseSseStream } from './sse.js';

const STREAM_PATH = '/v1/stream/odds';

export interface OddsStreamTransportConfig<T> {
  api: ApiClient;
  /** Stream scope — serialized into the `contestId` + `market` query params. */
  query: { contestId: string; market: string };
  /** Decode an event `data:` body into the public odds shape, or null (no odds). */
  decode: (body: unknown) => T | null;
  handlers: OddsSubscribeHandlers<T>;
}

type ConnectOutcome = 'ended' | 'fatal';

const SKIP: unique symbol = Symbol('skip');

export function subscribeToOddsStream<T>(config: OddsStreamTransportConfig<T>): Subscription {
  const { api, query, decode, handlers } = config;

  let closed = false;
  let attempt = 0;
  let lastStatus: StreamStatus | undefined;
  // Aborting `lifecycle` tears down the in-flight connection and wakes a
  // pending backoff sleep — the single unsubscribe signal.
  const lifecycle = new AbortController();

  // Once closed, no handler fires again (a consumer may unsubscribe from inside
  // any handler — that must immediately stop all further delivery).
  const emitStatus = (s: StreamStatus): void => {
    if (closed || lastStatus === s) return;
    lastStatus = s;
    try {
      handlers.onStatus?.(s);
    } catch {
      /* a consumer handler threw — never let it break the transport */
    }
  };

  const emitError = (
    reason: OspexStreamReason,
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

  const decodeOdds = (data: string | undefined): T | null | typeof SKIP => {
    try {
      const body: unknown = data === undefined || data === '' ? null : JSON.parse(data);
      return decode(body);
    } catch (err) {
      emitError('connection_failed', 'Failed to decode an odds event.', undefined, err);
      return SKIP;
    }
  };

  const classifyConnectError = (err: unknown): ConnectOutcome => {
    if (closed) return 'ended';
    if (err instanceof OspexAPIError) {
      const status = err.status;
      if (status === 429) {
        emitError('capacity_exceeded', 'Odds stream capacity reached.', status, err);
        return 'ended';
      }
      if (status === 404 || status === 400) {
        // Unknown contest/market, or a malformed request the SDK itself built —
        // a retry can't fix it, so stop rather than spin.
        emitError(
          'fatal',
          `Odds stream request was rejected (${status}); not retrying.`,
          status,
          err,
        );
        closed = true;
        return 'fatal';
      }
      emitError('connection_failed', 'Odds stream connect failed.', status, err);
      return 'ended';
    }
    emitError('connection_failed', 'Odds stream connect failed.', undefined, err);
    return 'ended';
  };

  // ── one connection attempt ─────────────────────────────────────────────
  const connectOnce = async (): Promise<ConnectOutcome> => {
    const ctrl = new AbortController();
    if (lifecycle.signal.aborted) return 'ended';
    const onLifecycleAbort = (): void => ctrl.abort();
    lifecycle.signal.addEventListener('abort', onLifecycleAbort, { once: true });

    let res: Response;
    try {
      res = await api.openStream(STREAM_PATH, { query, signal: ctrl.signal });
    } catch (err) {
      lifecycle.signal.removeEventListener('abort', onLifecycleAbort);
      return classifyConnectError(err);
    }
    if (closed) {
      lifecycle.signal.removeEventListener('abort', onLifecycleAbort);
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return 'ended';
    }

    // Idle watchdog: reset on every frame (events + heartbeats); abort on stall.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };

    armIdle();
    try {
      for await (const frame of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
        if (closed) break;
        armIdle();
        if (frame.kind === 'comment') continue;
        if (frame.event === 'snapshot') {
          const odds = decodeOdds(frame.data);
          if (odds === SKIP) continue;
          // A snapshot means "you are live with this baseline" — reset backoff,
          // deliver the baseline, then mark connected. emitStatus is guarded, so
          // if onSnapshot unsubscribes the 'connected' transition is suppressed.
          attempt = 0;
          try {
            handlers.onSnapshot?.(odds);
          } catch {
            /* ignore */
          }
          emitStatus('connected');
        } else if (frame.event === 'change') {
          const odds = decodeOdds(frame.data);
          if (odds === SKIP || odds === null) continue;
          try {
            handlers.onChange(odds);
          } catch {
            /* ignore */
          }
        } else if (frame.event === 'refresh') {
          const odds = decodeOdds(frame.data);
          if (odds === SKIP || odds === null) continue;
          try {
            handlers.onRefresh?.(odds);
          } catch {
            /* ignore */
          }
        } else if (frame.event === 'degraded') {
          // Source is behind; updates paused until the next snapshot. The
          // connection stays open — just surface the status.
          emitStatus('degraded');
        }
        // unknown event names: ignore (forward-compat)
      }
    } catch (err) {
      // The stream read aborted or errored. An unsubscribe aborts via
      // `lifecycle`; otherwise it's a genuine mid-stream transport drop.
      if (!closed) {
        emitError('connection_failed', 'Odds stream connection dropped.', undefined, err);
      }
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      lifecycle.signal.removeEventListener('abort', onLifecycleAbort);
    }
    return 'ended';
  };

  // ── reconnect loop ──────────────────────────────────────────────────────
  void (async (): Promise<void> => {
    while (!closed) {
      const outcome = await connectOnce();
      if (closed || outcome === 'fatal') break;
      emitStatus('reconnecting');
      await abortableSleep(backoffDelay(attempt), lifecycle.signal);
      attempt += 1;
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
