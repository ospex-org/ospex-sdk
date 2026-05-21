/**
 * Shared fetch-based SSE transport for the Ospex protocol streams
 * (commitments / positions / fills / speculations / contests). One transport
 * instance per subscription, all state closure-local — there is no module-level
 * state, so multiple `OspexClient` instances and multiple subscriptions are
 * fully isolated.
 *
 * Connect has two modes:
 *   fresh  (no cursor)  — open the stream, buffer incoming deltas, take a REST
 *                         snapshot, deliver `onSnapshot`, flush the buffer, go
 *                         live. The server sends `ready` then live deltas on a
 *                         no-cursor connect (it does not replay), so the client
 *                         owns the initial snapshot.
 *   resume (cursor)     — reconnect with the stored cursor; the server replays
 *                         missed deltas (catch-up), delivered straight through,
 *                         then `ready`.
 *
 * The cursor is the last `id:` seen — an opaque resume token, sent back
 * unchanged and never decoded. A `resync` (server event, or a rejected cursor)
 * drops the cursor and re-snapshots. A dropped connection reconnects in resume
 * mode with exponential backoff; a stalled stream (no event/heartbeat within the
 * idle window) is treated as dropped. Deltas are applied last-received-wins per
 * natural key by the consumer — the transport never orders or dedupes by cursor.
 */

import { OspexAPIError, OspexStreamError, type OspexStreamReason } from '../errors.js';
import type { ApiClient } from '../api/client.js';
import type { Subscription } from '../types/odds.js';
import type { StreamStatus, StreamSubscribeHandlers } from '../types/stream.js';

/** No event or heartbeat for this long ⇒ treat the stream as dead and reconnect.
 *  The server heartbeats ~20s; 60s tolerates a couple of missed beats. */
const IDLE_TIMEOUT_MS = 60_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

export interface StreamTransportConfig<T> {
  api: ApiClient;
  /** Path segment under `/v1/stream` (e.g. `'commitments'`). */
  resource: string;
  /** Identity/scope filters; `undefined` entries are dropped. */
  filters: Record<string, string | number | undefined>;
  /** Decode one delta `data:` JSON body into the public type. */
  decode: (body: unknown) => T;
  /**
   * Current-state snapshot (open-book list / detail). Omit for append-only or
   * no-current-state subscriptions — those stream from connect with no snapshot.
   */
  snapshot?: () => Promise<T[]>;
  handlers: StreamSubscribeHandlers<T>;
}

type ConnectOutcome = 'ended' | 'resync' | 'fatal';

export interface SseFrame {
  kind: 'event' | 'comment';
  event?: string;
  data?: string;
  id?: string;
}

const SKIP: unique symbol = Symbol('skip');

export function subscribeToStream<T>(config: StreamTransportConfig<T>): Subscription {
  const { api, resource, filters, decode, snapshot, handlers } = config;
  const path = `/v1/stream/${resource}`;

  let closed = false;
  let cursor: string | undefined;
  let attempt = 0;
  let lastStatus: StreamStatus | undefined;
  // Aborting `lifecycle` tears down the in-flight connection and wakes a
  // pending backoff sleep — the single unsubscribe signal.
  const lifecycle = new AbortController();

  const emitStatus = (s: StreamStatus): void => {
    if (lastStatus === s) return;
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

  const buildQuery = (
    withCursor: string | undefined,
  ): Record<string, string | number | undefined> => {
    const q: Record<string, string | number | undefined> = {};
    for (const [k, v] of Object.entries(filters)) if (v !== undefined) q[k] = v;
    if (withCursor !== undefined) q.cursor = withCursor;
    return q;
  };

  const tryDecode = (data: string | undefined): T | typeof SKIP => {
    try {
      const body: unknown = data === undefined || data === '' ? null : JSON.parse(data);
      return decode(body);
    } catch (err) {
      emitError('connection_failed', `Failed to decode a ${resource} delta.`, undefined, err);
      return SKIP;
    }
  };

  const classifyConnectError = (err: unknown): ConnectOutcome => {
    if (closed) return 'ended';
    if (err instanceof OspexAPIError) {
      const status = err.status;
      if (status === 429) {
        emitError('capacity_exceeded', `Stream capacity reached for ${resource}.`, status, err);
        return 'ended';
      }
      if (status === 400 && err.apiCode === 'INVALID_CURSOR') {
        // Stale / rejected cursor ⇒ re-snapshot from scratch.
        cursor = undefined;
        emitStatus('resync');
        return 'resync';
      }
      if (status === 404 || status === 400) {
        // Unknown resource, or a malformed request the SDK itself built — a
        // retry can't fix it, so stop rather than spin.
        emitError(
          'fatal',
          `Stream request for ${resource} was rejected (${status}); not retrying.`,
          status,
          err,
        );
        closed = true;
        return 'fatal';
      }
      emitError('connection_failed', `Stream connect to ${resource} failed.`, status, err);
      return 'ended';
    }
    emitError('connection_failed', `Stream connect to ${resource} failed.`, undefined, err);
    return 'ended';
  };

  // ── one connection attempt ─────────────────────────────────────────────
  const connectOnce = async (): Promise<ConnectOutcome> => {
    const fresh = cursor === undefined;
    const ctrl = new AbortController();
    if (lifecycle.signal.aborted) return 'ended';
    const onLifecycleAbort = (): void => ctrl.abort();
    lifecycle.signal.addEventListener('abort', onLifecycleAbort, { once: true });

    let res: Response;
    try {
      res = await api.openStream(path, { query: buildQuery(cursor), signal: ctrl.signal });
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

    // Emit `connected` once the live tail is established (`ready`) AND, on a
    // fresh connect, the snapshot has been delivered + flushed.
    let readyReceived = false;
    let snapshotDone = !(fresh && snapshot !== undefined);
    const maybeConnected = (): void => {
      if (readyReceived && snapshotDone) {
        attempt = 0;
        emitStatus('connected');
      }
    };

    // Fresh connect with a snapshot: buffer live deltas until the snapshot is
    // delivered, so the consumer always sees snapshot-then-deltas with no gap.
    let buffering = fresh && snapshot !== undefined;
    const buffer: T[] = [];
    const deliver = (row: T): void => {
      if (buffering) {
        buffer.push(row);
      } else {
        try {
          handlers.onDelta(row);
        } catch {
          /* ignore */
        }
      }
    };

    // Run the snapshot concurrently with reading the stream.
    let snapshotFailed = false;
    const snapshotTask = (async (): Promise<void> => {
      if (!(fresh && snapshot !== undefined)) return;
      let rows: T[];
      try {
        rows = await snapshot();
      } catch (err) {
        snapshotFailed = true;
        emitError(
          'connection_failed',
          `Stream snapshot failed for ${resource}.`,
          err instanceof OspexAPIError ? err.status : undefined,
          err,
        );
        // No baseline ⇒ reconnect fresh: discard buffer + cursor, drop the stream.
        cursor = undefined;
        buffer.length = 0;
        ctrl.abort();
        return;
      }
      try {
        handlers.onSnapshot?.(rows);
      } catch {
        /* ignore */
      }
      buffering = false;
      for (const row of buffer) {
        try {
          handlers.onDelta(row);
        } catch {
          /* ignore */
        }
      }
      buffer.length = 0;
      snapshotDone = true;
      maybeConnected();
    })();

    // Idle watchdog: reset on every frame (events + heartbeats); abort on stall.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };

    let outcome: ConnectOutcome = 'ended';
    armIdle();
    try {
      for await (const frame of parseSseStream(res.body as ReadableStream<Uint8Array>)) {
        if (closed) break;
        armIdle();
        if (frame.kind === 'comment') continue;
        if (frame.event === 'delta') {
          if (frame.id !== undefined) cursor = frame.id;
          const row = tryDecode(frame.data);
          if (row !== SKIP) deliver(row);
        } else if (frame.event === 'ready') {
          readyReceived = true;
          maybeConnected();
        } else if (frame.event === 'resync') {
          cursor = undefined;
          emitStatus('resync');
          outcome = 'resync';
          ctrl.abort();
          break;
        }
        // unknown event names: ignore (forward-compat)
      }
    } catch (err) {
      // The stream read aborted or errored. When we triggered the abort
      // (resync, snapshot failure, unsubscribe) the flags already reflect it;
      // otherwise it's a genuine mid-stream transport drop.
      if (!closed && outcome !== 'resync' && !snapshotFailed) {
        emitError('connection_failed', `Stream connection to ${resource} dropped.`, undefined, err);
      }
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      lifecycle.signal.removeEventListener('abort', onLifecycleAbort);
    }

    await snapshotTask.catch(() => {
      /* failure already surfaced above */
    });
    if (snapshotFailed) return 'ended';
    return outcome;
  };

  // ── reconnect loop ──────────────────────────────────────────────────────
  void (async (): Promise<void> => {
    while (!closed) {
      const outcome = await connectOnce();
      if (closed || outcome === 'fatal') break;
      if (outcome === 'resync') {
        // Re-snapshot promptly — no backoff; status is already 'resync'.
        attempt = 0;
        continue;
      }
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

/** Full-jitter exponential backoff. */
function backoffDelay(attempt: number): number {
  const ceil = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceil);
}

/** Sleep that resolves early if `signal` aborts (e.g. unsubscribe). */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Incremental Server-Sent Events parser over a fetch byte stream. Yields one
 * frame per dispatched event (blank-line terminated) and one per `:` comment
 * (heartbeats — so the idle watchdog sees them). Handles chunk boundaries,
 * CRLF, multi-line `data:`, and a single optional space after each field colon.
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventType = '';
  let data = '';
  let id: string | undefined;
  let sawField = false;
  const reset = (): void => {
    eventType = '';
    data = '';
    id = undefined;
    sawField = false;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          if (sawField) {
            const frame: SseFrame = { kind: 'event', event: eventType || 'message', data };
            if (id !== undefined) frame.id = id;
            yield frame;
          }
          reset();
          continue;
        }
        if (line.startsWith(':')) {
          yield { kind: 'comment' };
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        switch (field) {
          case 'event':
            eventType = value;
            sawField = true;
            break;
          case 'data':
            data = data === '' ? value : `${data}\n${value}`;
            sawField = true;
            break;
          case 'id':
            id = value;
            sawField = true;
            break;
          default:
            // 'retry' (we own backoff) and unknown fields: ignore.
            break;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* a pending read may already have errored on abort */
    }
  }
}
