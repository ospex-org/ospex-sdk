/**
 * Protocol SSE transport tests. A fake streaming `fetch` (injected into a real
 * ApiClient) hands back controllable byte streams, so the parser → state
 * machine → reconnect/resync path runs exactly as in prod without a socket.
 * Fake timers drive backoff + the idle watchdog deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import { OspexClient } from '../src/client.js';
import { OspexStreamError, OspexValidationError } from '../src/errors.js';
import { normalizeUint } from '../src/realtime/filters.js';
import { parseSseStream, subscribeToStream, type SseFrame } from '../src/realtime/stream.js';
import type { Position } from '../src/types/position.js';
import type { StreamStatus, StreamSubscribeHandlers } from '../src/types/stream.js';

const enc = new TextEncoder();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Advance fake time and flush the microtasks that resolve stream reads / promises. */
const settle = (ms = 1): Promise<void> => vi.advanceTimersByTimeAsync(ms);

// ── parser ────────────────────────────────────────────────────────────────

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]));
      else c.close();
    },
  });
}

async function collectFrames(chunks: string[]): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const f of parseSseStream(streamFromChunks(chunks))) out.push(f);
  return out;
}

describe('parseSseStream', () => {
  it('parses a single event with event + data', async () => {
    const frames = await collectFrames(['event: ready\ndata: {"resource":"commitments"}\n\n']);
    expect(frames).toEqual([
      { kind: 'event', event: 'ready', data: '{"resource":"commitments"}' },
    ]);
  });

  it('parses a delta with an id (cursor)', async () => {
    const frames = await collectFrames(['event: delta\ndata: {"a":1}\nid: cur-1\n\n']);
    expect(frames).toEqual([{ kind: 'event', event: 'delta', data: '{"a":1}', id: 'cur-1' }]);
  });

  it('emits comment frames for `:` lines (heartbeats)', async () => {
    const frames = await collectFrames([': connected\n', ': hb\n']);
    expect(frames).toEqual([{ kind: 'comment' }, { kind: 'comment' }]);
  });

  it('reassembles an event split across chunk boundaries', async () => {
    const frames = await collectFrames(['event: del', 'ta\ndata: {"a"', ':1}\n\n']);
    expect(frames).toEqual([{ kind: 'event', event: 'delta', data: '{"a":1}' }]);
  });

  it('joins multi-line data with newlines', async () => {
    const frames = await collectFrames(['data: a\ndata: b\n\n']);
    expect(frames).toEqual([{ kind: 'event', event: 'message', data: 'a\nb' }]);
  });

  it('handles CRLF line endings', async () => {
    const frames = await collectFrames(['event: ready\r\ndata: {}\r\n\r\n']);
    expect(frames).toEqual([{ kind: 'event', event: 'ready', data: '{}' }]);
  });
});

// ── transport harness ───────────────────────────────────────────────────────

interface Conn {
  url: string;
  push(s: string): void;
  close(): void;
  error(e?: unknown): void;
}

type Plan = (index: number, url: string) => 'sse' | { status: number; code?: string };

function fakeStreamingApi(plan?: Plan): { api: ApiClient; conns: Conn[]; urls: string[] } {
  const conns: Conn[] = [];
  const urls: string[] = [];
  let index = 0;
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const i = index++;
    const u = String(url);
    urls.push(u);
    const decision = plan ? plan(i, u) : 'sse';
    if (decision !== 'sse') {
      return {
        ok: false,
        status: decision.status,
        async json() {
          return { error: 'err', ...(decision.code !== undefined ? { code: decision.code } : {}) };
        },
      } as unknown as Response;
    }
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
    // Mirror real fetch: aborting the request signal errors the body stream
    // (so the idle watchdog / unsubscribe path actually tears down the read).
    const signal = init?.signal;
    const abortStream = (): void => {
      try {
        ctrl.error(new Error('aborted'));
      } catch {
        /* */
      }
    };
    if (signal?.aborted) abortStream();
    else signal?.addEventListener('abort', abortStream, { once: true });
    conns.push({
      url: u,
      push: (s) => {
        try {
          ctrl.enqueue(enc.encode(s));
        } catch {
          /* stream already torn down */
        }
      },
      close: () => {
        try {
          ctrl.close();
        } catch {
          /* */
        }
      },
      error: (e) => {
        try {
          ctrl.error(e ?? new Error('drop'));
        } catch {
          /* */
        }
      },
    });
    return { ok: true, status: 200, body: stream, async json() {} } as unknown as Response;
  };
  const api = new ApiClient({ apiUrl: 'http://test.local', fetch: fetchImpl as unknown as typeof fetch });
  return { api, conns, urls };
}

function collector<T>(): {
  snapshots: T[][];
  deltas: T[];
  statuses: StreamStatus[];
  errors: OspexStreamError[];
  handlers: StreamSubscribeHandlers<T>;
} {
  const snapshots: T[][] = [];
  const deltas: T[] = [];
  const statuses: StreamStatus[] = [];
  const errors: OspexStreamError[] = [];
  return {
    snapshots,
    deltas,
    statuses,
    errors,
    handlers: {
      onSnapshot: (rows) => snapshots.push(rows),
      onDelta: (r) => deltas.push(r),
      onStatus: (s) => statuses.push(s),
      onError: (e) => errors.push(e),
    },
  };
}

const passthrough = <T,>(b: unknown): T => b as T;

describe('subscribeToStream — fresh connect', () => {
  it('connects without a cursor, delivers the snapshot, then live deltas, and goes connected', async () => {
    const { api, conns } = fakeStreamingApi();
    const c = collector<{ id: string }>();
    const snapshot = vi.fn(async () => [{ id: 's1' }]);
    subscribeToStream({
      api,
      resource: 'commitments',
      filters: { contestId: '42' },
      decode: passthrough,
      snapshot,
      handlers: c.handlers,
    });
    await settle();

    expect(conns).toHaveLength(1);
    expect(conns[0]?.url).toContain('/v1/stream/commitments');
    expect(conns[0]?.url).toContain('contestId=42');
    expect(conns[0]?.url).not.toContain('cursor=');

    conns[0]?.push('event: ready\ndata: {"resource":"commitments"}\n\n');
    await settle();
    conns[0]?.push('event: delta\ndata: {"id":"d1"}\nid: cur-1\n\n');
    await settle();

    expect(c.snapshots).toEqual([[{ id: 's1' }]]);
    expect(c.deltas).toEqual([{ id: 'd1' }]);
    expect(c.statuses).toContain('connected');
  });

  it('buffers deltas that arrive before the snapshot resolves, flushing them after onSnapshot', async () => {
    const { api, conns } = fakeStreamingApi();
    const c = collector<{ id: string }>();
    let resolveSnap!: (rows: Array<{ id: string }>) => void;
    const snapshot = (): Promise<Array<{ id: string }>> =>
      new Promise((r) => {
        resolveSnap = r;
      });
    subscribeToStream({ api, resource: 'commitments', filters: {}, decode: passthrough, snapshot, handlers: c.handlers });
    await settle();

    conns[0]?.push('event: ready\ndata: {}\n\n');
    conns[0]?.push('event: delta\ndata: {"id":"d1"}\nid: c1\n\n');
    await settle();
    // Snapshot still pending ⇒ nothing delivered yet.
    expect(c.snapshots).toEqual([]);
    expect(c.deltas).toEqual([]);

    resolveSnap([{ id: 's1' }]);
    await settle();
    // Snapshot first, then the buffered delta.
    expect(c.snapshots).toEqual([[{ id: 's1' }]]);
    expect(c.deltas).toEqual([{ id: 'd1' }]);
    expect(c.statuses).toContain('connected');
  });

  it('streams from connect with no snapshot for an append-only resource (fills)', async () => {
    const { api, conns } = fakeStreamingApi();
    const c = collector<{ id: string }>();
    subscribeToStream({ api, resource: 'fills', filters: {}, decode: passthrough, handlers: c.handlers });
    await settle();
    conns[0]?.push('event: ready\ndata: {}\n\n');
    conns[0]?.push('event: delta\ndata: {"id":"f1"}\nid: c1\n\n');
    await settle();
    expect(c.snapshots).toEqual([]);
    expect(c.deltas).toEqual([{ id: 'f1' }]);
    expect(c.statuses).toContain('connected');
  });
});

describe('subscribeToStream — reconnect & resync', () => {
  it('reconnects with the last cursor after a drop and delivers catch-up deltas', async () => {
    const { api, conns } = fakeStreamingApi();
    const c = collector<{ id: string }>();
    subscribeToStream({ api, resource: 'fills', filters: {}, decode: passthrough, handlers: c.handlers });
    await settle();
    conns[0]?.push('event: ready\ndata: {}\n\n');
    conns[0]?.push('event: delta\ndata: {"id":"d1"}\nid: cur-1\n\n');
    await settle();
    expect(c.deltas).toEqual([{ id: 'd1' }]);

    conns[0]?.error(); // drop
    await settle(600); // backoff (≤500ms) elapses → reconnect

    expect(conns).toHaveLength(2);
    expect(conns[1]?.url).toContain('cursor=cur-1');
    expect(c.statuses).toContain('reconnecting');

    conns[1]?.push('event: delta\ndata: {"id":"d2"}\nid: cur-2\n\n');
    conns[1]?.push('event: ready\ndata: {}\n\n');
    await settle();
    expect(c.deltas).toEqual([{ id: 'd1' }, { id: 'd2' }]);
  });

  it('on a resync event: drops the cursor, re-snapshots, and reconnects without a cursor', async () => {
    const { api, conns, urls } = fakeStreamingApi();
    const c = collector<{ id: string }>();
    const snapshot = vi.fn(async () => [{ id: 'snap' }]);
    subscribeToStream({ api, resource: 'commitments', filters: {}, decode: passthrough, snapshot, handlers: c.handlers });
    await settle();
    conns[0]?.push('event: ready\ndata: {}\n\n');
    conns[0]?.push('event: delta\ndata: {"id":"d1"}\nid: cur-1\n\n');
    await settle();
    expect(snapshot).toHaveBeenCalledTimes(1);

    conns[0]?.push('event: resync\ndata: {"reason":"backlog_too_large"}\n\n');
    await settle(600);

    expect(c.statuses).toContain('resync');
    expect(urls).toHaveLength(2);
    expect(urls[1]).not.toContain('cursor=');
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('treats a rejected cursor (400 INVALID_CURSOR) as a resync and reconnects fresh', async () => {
    const plan: Plan = (i) => (i === 1 ? { status: 400, code: 'INVALID_CURSOR' } : 'sse');
    const { api, conns, urls } = fakeStreamingApi(plan);
    const c = collector<{ id: string }>();
    const snapshot = vi.fn(async () => []);
    subscribeToStream({ api, resource: 'commitments', filters: {}, decode: passthrough, snapshot, handlers: c.handlers });
    await settle();
    conns[0]?.push('event: ready\ndata: {}\n\n');
    conns[0]?.push('event: delta\ndata: {"id":"d1"}\nid: cur-1\n\n');
    await settle();

    conns[0]?.error(); // drop → reconnect (idx 1) carries the cursor → 400 → resync → reconnect (idx 2) fresh
    await settle(600);

    expect(c.statuses).toContain('resync');
    expect(urls[1]).toContain('cursor=cur-1');
    expect(urls[2]).toBeDefined();
    expect(urls[2]).not.toContain('cursor=');
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
});

describe('subscribeToStream — connect errors', () => {
  it('429: surfaces capacity_exceeded and keeps reconnecting', async () => {
    const plan: Plan = (i) => (i === 0 ? { status: 429, code: 'RATE_LIMIT_EXCEEDED' } : 'sse');
    const { api, conns } = fakeStreamingApi(plan);
    const c = collector<{ id: string }>();
    subscribeToStream({ api, resource: 'fills', filters: {}, decode: passthrough, handlers: c.handlers });
    await settle(600);
    expect(c.errors.some((e) => e.reason === 'capacity_exceeded' && e.status === 429)).toBe(true);
    expect(conns.length).toBeGreaterThanOrEqual(1); // the reconnect succeeded
  });

  it('404: surfaces fatal and stops (no further connect attempts)', async () => {
    const plan: Plan = () => ({ status: 404 });
    const { api, urls } = fakeStreamingApi(plan);
    const c = collector<{ id: string }>();
    subscribeToStream({ api, resource: 'commitments', filters: {}, decode: passthrough, handlers: c.handlers });
    await settle(5000);
    expect(c.errors.some((e) => e.reason === 'fatal' && e.status === 404)).toBe(true);
    expect(urls).toHaveLength(1);
  });

  it('surfaces a decode error and skips the row without killing the stream', async () => {
    const { api, conns } = fakeStreamingApi();
    const c = collector<{ id: string }>();
    const decode = (b: unknown): { id: string } => {
      const o = b as { id?: string };
      if (o.id === undefined) throw new Error('bad row');
      return { id: o.id };
    };
    subscribeToStream({ api, resource: 'fills', filters: {}, decode, handlers: c.handlers });
    await settle();
    conns[0]?.push('event: ready\ndata: {}\n\n');
    conns[0]?.push('event: delta\ndata: {"nope":1}\nid: c1\n\n');
    conns[0]?.push('event: delta\ndata: {"id":"ok"}\nid: c2\n\n');
    await settle();
    expect(c.errors.some((e) => e.reason === 'connection_failed')).toBe(true);
    expect(c.deltas).toEqual([{ id: 'ok' }]);
  });
});

describe('subscribeToStream — idle watchdog & unsubscribe', () => {
  it('reconnects when the stream goes idle past the heartbeat window', async () => {
    const { api, conns } = fakeStreamingApi();
    const c = collector<{ id: string }>();
    subscribeToStream({ api, resource: 'fills', filters: {}, decode: passthrough, handlers: c.handlers });
    await settle();
    conns[0]?.push('event: ready\ndata: {}\n\n');
    await settle();
    expect(c.statuses).toContain('connected');

    await settle(61_000); // no heartbeat → watchdog aborts → reconnect
    expect(conns.length).toBeGreaterThanOrEqual(2);
    expect(c.statuses).toContain('reconnecting');
  });

  it('unsubscribe aborts the stream, stops delivery, and is idempotent', async () => {
    const { api, conns } = fakeStreamingApi();
    const c = collector<{ id: string }>();
    const sub = subscribeToStream({ api, resource: 'fills', filters: {}, decode: passthrough, handlers: c.handlers });
    await settle();
    conns[0]?.push('event: ready\ndata: {}\n\n');
    conns[0]?.push('event: delta\ndata: {"id":"d1"}\nid: c1\n\n');
    await settle();
    expect(c.deltas).toHaveLength(1);

    await sub.unsubscribe();
    await sub.unsubscribe(); // idempotent

    conns[0]?.push('event: delta\ndata: {"id":"d2"}\nid: c2\n\n');
    await settle(5000);
    expect(c.deltas).toHaveLength(1); // nothing after unsubscribe
    expect(conns).toHaveLength(1); // no reconnect
  });
});

describe('subscribeToStream — in-flight snapshot suppression', () => {
  it('suppresses an in-flight snapshot (and buffered deltas) when unsubscribed before it resolves', async () => {
    const { api, conns } = fakeStreamingApi();
    const c = collector<{ id: string }>();
    let resolveSnap!: (rows: Array<{ id: string }>) => void;
    const snapshot = (): Promise<Array<{ id: string }>> =>
      new Promise((r) => {
        resolveSnap = r;
      });
    const sub = subscribeToStream({
      api,
      resource: 'commitments',
      filters: {},
      decode: passthrough,
      snapshot,
      handlers: c.handlers,
    });
    await settle();
    conns[0]?.push('event: ready\ndata: {}\n\n'); // live, but snapshot still pending
    conns[0]?.push('event: delta\ndata: {"id":"d1"}\nid: c1\n\n'); // buffered
    await settle();
    expect(c.snapshots).toEqual([]);

    await sub.unsubscribe();
    resolveSnap([{ id: 'after-unsubscribe' }]); // resolves AFTER unsubscribe
    await settle(2000);

    expect(c.snapshots).toEqual([]); // suppressed
    expect(c.deltas).toEqual([]); // buffered delta never flushed
    expect(c.statuses).not.toContain('connected');
    expect(conns).toHaveLength(1); // no reconnect
  });

  it('discards an in-flight snapshot on resync; only the fresh attempt snapshots and the reconnect is not blocked', async () => {
    const { api, conns, urls } = fakeStreamingApi();
    const c = collector<{ id: string }>();
    const resolvers: Array<(rows: Array<{ id: string }>) => void> = [];
    const snapshot = (): Promise<Array<{ id: string }>> =>
      new Promise((r) => {
        resolvers.push(r);
      });
    subscribeToStream({
      api,
      resource: 'commitments',
      filters: {},
      decode: passthrough,
      snapshot,
      handlers: c.handlers,
    });
    await settle();
    conns[0]?.push('event: ready\ndata: {}\n\n');
    conns[0]?.push('event: delta\ndata: {"id":"d1"}\nid: c1\n\n'); // buffered (snapshot pending)
    await settle();

    // resync arrives while attempt 1's snapshot is still pending
    conns[0]?.push('event: resync\ndata: {"reason":"backlog_too_large"}\n\n');
    await settle(600);

    // Reconnect happened immediately — not blocked on the pending snapshot.
    expect(c.statuses).toContain('resync');
    expect(conns).toHaveLength(2);
    expect(urls[1]).not.toContain('cursor='); // fresh
    expect(resolvers).toHaveLength(2); // attempt 2 started its own snapshot

    // The stale (attempt-1) snapshot resolves now → must be discarded.
    resolvers[0]?.([{ id: 'stale-pre-resync' }]);
    await settle();
    expect(c.snapshots).toEqual([]);

    // The fresh (attempt-2) snapshot resolves → delivered; connected follows ready.
    conns[1]?.push('event: ready\ndata: {}\n\n');
    resolvers[1]?.([{ id: 'fresh' }]);
    await settle();
    expect(c.snapshots).toEqual([[{ id: 'fresh' }]]);
    expect(c.statuses).toContain('connected');
  });
});

describe('subscribeToStream — polling fallback (degraded)', () => {
  function fallbackHarness(): {
    api: ApiClient;
    recoverySince: string[];
    setSseFail: (v: boolean) => void;
    live: () => { push: (s: string) => void; error: () => void } | undefined;
  } {
    const recoverySince: string[] = [];
    let sseShouldFail = false;
    let liveStream: { push: (s: string) => void; error: () => void } | undefined;
    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.includes('/v1/stream/')) {
        if (sseShouldFail) {
          return { ok: false, status: 503, async json() {
            return { error: 'down' };
          } } as unknown as Response;
        }
        let ctrl!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
        init?.signal?.addEventListener('abort', () => {
          try {
            ctrl.error(new Error('aborted'));
          } catch {
            /* */
          }
        }, { once: true });
        liveStream = {
          push: (s) => {
            try {
              ctrl.enqueue(enc.encode(s));
            } catch {
              /* */
            }
          },
          error: () => {
            try {
              ctrl.error(new Error('drop'));
            } catch {
              /* */
            }
          },
        };
        return { ok: true, status: 200, body: stream, async json() {} } as unknown as Response;
      }
      // Recovery: GET /v1/<resource>?since=...
      recoverySince.push(new URL(u).searchParams.get('since') ?? '');
      const since = recoverySince[recoverySince.length - 1];
      return { ok: true, status: 200, async json() {
        return { fills: [{ id: `rec-${since}` }], nextCursor: `${since}+1`, hasMore: false };
      } } as unknown as Response;
    };
    const api = new ApiClient({ apiUrl: 'http://test.local', fetch: fetchImpl as unknown as typeof fetch });
    return { api, recoverySince, setSseFail: (v) => (sseShouldFail = v), live: () => liveStream };
  }

  it('falls back to REST polling after repeated SSE failures, then recovers when the stream returns', async () => {
    const h = fallbackHarness();
    const c = collector<{ id: string }>();
    subscribeToStream({ api: h.api, resource: 'fills', filters: {}, decode: passthrough, handlers: c.handlers });
    await settle();
    // connect 1: live — deliver a delta to establish the resume cursor.
    h.live()?.push('event: ready\ndata: {}\n\n');
    h.live()?.push('event: delta\ndata: {"id":"d1"}\nid: cur-1\n\n');
    await settle();
    expect(c.statuses).toContain('connected');
    expect(c.deltas).toEqual([{ id: 'd1' }]);

    // SSE now fails on every reconnect; drop the live stream.
    h.setSseFail(true);
    h.live()?.error();
    await settle(15_000); // through reconnect backoffs + into degraded + a poll cycle

    expect(c.statuses).toContain('degraded');
    expect(h.recoverySince[0]).toBe('cur-1'); // polled from the live cursor
    expect(c.deltas).toContainEqual({ id: 'rec-cur-1' }); // a recovery row was delivered
    expect(h.recoverySince).toContain('cur-1+1'); // cursor advanced across poll cycles

    // SSE recovers.
    h.setSseFail(false);
    await settle(6000); // next loop iteration re-establishes the stream
    h.live()?.push('event: ready\ndata: {}\n\n');
    await settle();
    expect(c.statuses[c.statuses.length - 1]).toBe('connected');
  });

  it('does not fall back to polling without a resume cursor', async () => {
    const plan: Plan = () => ({ status: 503 }); // every SSE connect fails, never connects
    const { api, urls } = fakeStreamingApi(plan);
    const c = collector<{ id: string }>();
    subscribeToStream({ api, resource: 'fills', filters: {}, decode: passthrough, handlers: c.handlers });
    await settle(60_000);
    expect(c.statuses).toContain('reconnecting');
    expect(c.statuses).not.toContain('degraded'); // no cursor ⇒ never degraded
    expect(urls.every((u) => u.includes('/v1/stream/'))).toBe(true); // recovery never polled
  });

  // Recovery fetch is a deferred the test resolves/rejects, so the
  // unsubscribe-vs-in-flight-poll race can be driven deterministically.
  function deferredRecoveryHarness(): {
    api: ApiClient;
    setSseFail: (v: boolean) => void;
    live: () => { push: (s: string) => void; error: () => void } | undefined;
    recoveryDeferreds: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }>;
  } {
    let sseShouldFail = false;
    let liveStream: { push: (s: string) => void; error: () => void } | undefined;
    const recoveryDeferreds: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.includes('/v1/stream/')) {
        if (sseShouldFail) {
          return { ok: false, status: 503, async json() {
            return { error: 'down' };
          } } as unknown as Response;
        }
        let ctrl!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
        init?.signal?.addEventListener('abort', () => {
          try {
            ctrl.error(new Error('aborted'));
          } catch {
            /* */
          }
        }, { once: true });
        liveStream = {
          push: (s) => {
            try {
              ctrl.enqueue(enc.encode(s));
            } catch {
              /* */
            }
          },
          error: () => {
            try {
              ctrl.error(new Error('drop'));
            } catch {
              /* */
            }
          },
        };
        return { ok: true, status: 200, body: stream, async json() {} } as unknown as Response;
      }
      return new Promise<Response>((resolve, reject) => {
        recoveryDeferreds.push({ resolve, reject });
      });
    };
    const api = new ApiClient({ apiUrl: 'http://test.local', fetch: fetchImpl as unknown as typeof fetch });
    return { api, setSseFail: (v) => (sseShouldFail = v), live: () => liveStream, recoveryDeferreds };
  }

  async function reachDegradedWithPendingPoll(
    h: ReturnType<typeof deferredRecoveryHarness>,
    c: ReturnType<typeof collector<{ id: string }>>,
  ): Promise<Subscription> {
    const sub = subscribeToStream({ api: h.api, resource: 'fills', filters: {}, decode: passthrough, handlers: c.handlers });
    await settle();
    h.live()?.push('event: ready\ndata: {}\n\n');
    h.live()?.push('event: delta\ndata: {"id":"d1"}\nid: cur-1\n\n');
    await settle();
    h.setSseFail(true);
    h.live()?.error();
    await settle(15_000); // → degraded; the first recovery poll is now in flight
    expect(c.statuses).toContain('degraded');
    expect(h.recoveryDeferreds.length).toBeGreaterThanOrEqual(1);
    return sub;
  }

  it('a recovery poll that rejects after unsubscribe does not emit a late onError', async () => {
    const h = deferredRecoveryHarness();
    const c = collector<{ id: string }>();
    const sub = await reachDegradedWithPendingPoll(h, c);

    const errorsBefore = c.errors.length;
    await sub.unsubscribe();
    h.recoveryDeferreds[0]?.reject(new Error('aborted')); // in-flight fetch rejects post-unsubscribe
    await settle(2000);

    expect(c.errors.length).toBe(errorsBefore); // no late onError
  });

  it('a recovery poll that resolves after unsubscribe does not call onDelta', async () => {
    const h = deferredRecoveryHarness();
    const c = collector<{ id: string }>();
    const sub = await reachDegradedWithPendingPoll(h, c);

    const deltasBefore = c.deltas.length;
    await sub.unsubscribe();
    h.recoveryDeferreds[0]?.resolve({
      ok: true,
      status: 200,
      async json() {
        return { fills: [{ id: 'after-unsubscribe' }], nextCursor: 'x', hasMore: false };
      },
    } as unknown as Response);
    await settle(2000);

    expect(c.deltas.length).toBe(deltasBefore); // no onDelta after unsubscribe
    expect(c.deltas).not.toContainEqual({ id: 'after-unsubscribe' });
  });
});

describe('normalizeUint', () => {
  it('canonicalizes numbers and numeric strings; passes undefined through', () => {
    expect(normalizeUint(7, 'speculationId')).toBe('7');
    expect(normalizeUint('7', 'speculationId')).toBe('7');
    expect(normalizeUint('007', 'speculationId')).toBe('7');
    expect(normalizeUint(undefined, 'contestId')).toBeUndefined();
  });

  it('rejects negatives and non-integers with OspexValidationError', () => {
    expect(() => normalizeUint(-1, 'speculationId')).toThrow(OspexValidationError);
    expect(() => normalizeUint('abc', 'speculationId')).toThrow(OspexValidationError);
    expect(() => normalizeUint(1.5, 'speculationId')).toThrow(OspexValidationError);
  });
});

describe('positions.subscribe — snapshot/stream filter parity (regression)', () => {
  function clientServingPositions(positions: Position[]): { client: OspexClient; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/v1/stream/positions')) {
        let ctrl!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
        init?.signal?.addEventListener(
          'abort',
          () => {
            try {
              ctrl.error(new Error('aborted'));
            } catch {
              /* */
            }
          },
          { once: true },
        );
        return { ok: true, status: 200, body: stream, async json() {} } as unknown as Response;
      }
      if (u.includes('/v1/positions/')) {
        return { ok: true, status: 200, async json() {
          return { positions };
        } } as unknown as Response;
      }
      return { ok: false, status: 404, async json() {
        return { error: 'not found' };
      } } as unknown as Response;
    };
    const client = new OspexClient({
      apiUrl: 'http://test.local',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    return { client, urls };
  }

  it('an address+speculationId subscription snapshots only that speculation', async () => {
    const positions: Position[] = [
      { speculationId: '7', positionType: 0, riskAmountUSDC: 1, profitAmountUSDC: 0, claimed: false, positionCreatedAt: 't' },
      { speculationId: '8', positionType: 1, riskAmountUSDC: 2, profitAmountUSDC: 0, claimed: false, positionCreatedAt: 't' },
    ];
    const { client, urls } = clientServingPositions(positions);
    const c = collector<Position>();
    const addr = '0x1111111111111111111111111111111111111111';
    await client.positions.subscribe({ address: addr, speculationId: 7 }, c.handlers);
    await settle();

    // Snapshot is filtered to the stream's speculation, with userAddress injected.
    expect(c.snapshots).toHaveLength(1);
    expect(c.snapshots[0]?.map((p) => p.speculationId)).toEqual(['7']);
    expect(c.snapshots[0]?.[0]?.userAddress).toBe(addr);

    // The stream is scoped to the same speculation (parity).
    const streamUrl = urls.find((u) => u.includes('/v1/stream/positions'));
    expect(streamUrl).toContain('speculationId=7');
  });
});
