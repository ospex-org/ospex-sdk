/**
 * Odds SSE transport tests. A fake streaming `fetch` (injected into a real
 * ApiClient / OspexClient) hands back controllable byte streams, so the parser
 * → state machine → reconnect path runs exactly as in prod without a socket.
 * Fake timers drive backoff + the idle watchdog deterministically.
 *
 * Odds is latest-state: `snapshot` is the baseline (live), `change` / `refresh`
 * are deltas, `degraded` pauses until the next snapshot. No cursor, no replay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import { OspexClient } from '../src/client.js';
import { OspexStreamError } from '../src/errors.js';
import { decodeOddsEvent } from '../src/api/oddsMappers.js';
import { subscribeToOddsStream } from '../src/realtime/oddsStream.js';
import type { MarketType, MoneylineOdds, OddsSubscribeHandlers, Subscription } from '../src/types/odds.js';
import type { StreamStatus } from '../src/types/stream.js';

const enc = new TextEncoder();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Advance fake time and flush the microtasks that resolve stream reads / promises. */
const settle = (ms = 1): Promise<void> => vi.advanceTimersByTimeAsync(ms);

// ── transport harness ───────────────────────────────────────────────────────

interface Conn {
  url: string;
  push(s: string): void;
  close(): void;
  error(e?: unknown): void;
}

type Plan = (index: number, url: string) => 'sse' | { status: number; code?: string };

function fakeStreaming(plan?: Plan): {
  fetch: typeof globalThis.fetch;
  conns: Conn[];
  urls: string[];
} {
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
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, conns, urls };
}

function apiFrom(plan?: Plan): { api: ApiClient; conns: Conn[]; urls: string[] } {
  const { fetch, conns, urls } = fakeStreaming(plan);
  return { api: new ApiClient({ apiUrl: 'http://test.local', fetch }), conns, urls };
}

function oddsCollector(): {
  snapshots: (MoneylineOdds | null)[];
  changes: MoneylineOdds[];
  refreshes: MoneylineOdds[];
  statuses: StreamStatus[];
  errors: OspexStreamError[];
  handlers: OddsSubscribeHandlers<MoneylineOdds>;
} {
  const snapshots: (MoneylineOdds | null)[] = [];
  const changes: MoneylineOdds[] = [];
  const refreshes: MoneylineOdds[] = [];
  const statuses: StreamStatus[] = [];
  const errors: OspexStreamError[] = [];
  return {
    snapshots,
    changes,
    refreshes,
    statuses,
    errors,
    handlers: {
      onSnapshot: (o) => snapshots.push(o),
      onChange: (o) => changes.push(o),
      onRefresh: (o) => refreshes.push(o),
      onStatus: (s) => statuses.push(s),
      onError: (e) => errors.push(e),
    },
  };
}

const TS = { upstreamLastUpdated: 't', pollCapturedAt: 't', changedAt: 't' };
const ml = (away: number, home: number): Record<string, unknown> => ({
  market: 'moneyline',
  awayOddsAmerican: away,
  homeOddsAmerican: home,
  ...TS,
});

const frame = (event: string, odds: unknown, market: MarketType = 'moneyline'): string =>
  `event: ${event}\ndata: ${JSON.stringify({ contestId: '42', market, odds })}\n\n`;

function startMoneyline(
  api: ApiClient,
  handlers: OddsSubscribeHandlers<MoneylineOdds>,
): Subscription {
  return subscribeToOddsStream<MoneylineOdds>({
    api,
    query: { contestId: '42', market: 'moneyline' },
    decode: (b) => decodeOddsEvent('moneyline', b),
    handlers,
  });
}

describe('subscribeToOddsStream — baseline + deltas', () => {
  it('opens the odds stream scoped to (contestId, market) and has no cursor', async () => {
    const { api, conns, urls } = apiFrom();
    startMoneyline(api, oddsCollector().handlers);
    await settle();
    expect(conns).toHaveLength(1);
    expect(urls[0]).toContain('/v1/stream/odds');
    expect(urls[0]).toContain('contestId=42');
    expect(urls[0]).toContain('market=moneyline');
    expect(urls[0]).not.toContain('cursor=');
  });

  it('delivers the snapshot baseline, then goes connected', async () => {
    const { api, conns } = apiFrom();
    const c = oddsCollector();
    startMoneyline(api, c.handlers);
    await settle();
    conns[0]?.push(frame('snapshot', ml(148, -167)));
    await settle();
    expect(c.snapshots).toHaveLength(1);
    expect(c.snapshots[0]).toMatchObject({ market: 'moneyline', awayOddsAmerican: 148, homeOddsAmerican: -167 });
    expect(c.statuses).toContain('connected');
  });

  it('routes change to onChange and refresh to onRefresh', async () => {
    const { api, conns } = apiFrom();
    const c = oddsCollector();
    startMoneyline(api, c.handlers);
    await settle();
    conns[0]?.push(frame('snapshot', ml(148, -167)));
    await settle();
    conns[0]?.push(frame('change', ml(150, -170)));
    await settle();
    conns[0]?.push(frame('refresh', ml(150, -170)));
    await settle();
    expect(c.changes).toEqual([
      { market: 'moneyline', awayOddsAmerican: 150, homeOddsAmerican: -170, ...TS },
    ]);
    expect(c.refreshes).toEqual([
      { market: 'moneyline', awayOddsAmerican: 150, homeOddsAmerican: -170, ...TS },
    ]);
  });

  it('delivers a null baseline (live, but no odds yet) and still goes connected', async () => {
    const { api, conns } = apiFrom();
    const c = oddsCollector();
    startMoneyline(api, c.handlers);
    await settle();
    conns[0]?.push(frame('snapshot', null));
    await settle();
    expect(c.snapshots).toEqual([null]);
    expect(c.statuses).toContain('connected');
  });

  it('decodes per-market shapes from the wire (spread)', async () => {
    const { api, conns } = apiFrom();
    const snaps: unknown[] = [];
    subscribeToOddsStream({
      api,
      query: { contestId: '42', market: 'spread' },
      decode: (b) => decodeOddsEvent('spread', b),
      handlers: { onChange: () => {}, onSnapshot: (o) => snaps.push(o) },
    });
    await settle();
    conns[0]?.push(
      frame(
        'snapshot',
        { market: 'spread', awayLine: 1.5, homeLine: -1.5, awayOddsAmerican: -147, homeOddsAmerican: 127, ...TS },
        'spread',
      ),
    );
    await settle();
    expect(snaps[0]).toMatchObject({ market: 'spread', awayLine: 1.5, homeLine: -1.5 });
  });
});

describe('subscribeToOddsStream — degraded + recovery', () => {
  it('surfaces degraded, then returns to connected on the next snapshot', async () => {
    const { api, conns } = apiFrom();
    const c = oddsCollector();
    startMoneyline(api, c.handlers);
    await settle();
    conns[0]?.push(frame('snapshot', ml(148, -167)));
    await settle();
    conns[0]?.push('event: degraded\ndata: {"reason":"source_down"}\n\n');
    await settle();
    expect(c.statuses).toContain('degraded');
    // Recovery snapshot re-baselines and flips back to connected.
    conns[0]?.push(frame('snapshot', ml(149, -168)));
    await settle();
    expect(c.snapshots).toHaveLength(2);
    expect(c.statuses[c.statuses.length - 1]).toBe('connected');
  });
});

describe('subscribeToOddsStream — reconnect & fatal', () => {
  it('reconnects with backoff after a mid-stream drop', async () => {
    const { api, conns } = apiFrom();
    const c = oddsCollector();
    startMoneyline(api, c.handlers);
    await settle();
    conns[0]?.push(frame('snapshot', ml(148, -167)));
    await settle();
    conns[0]?.error(new Error('drop'));
    await settle();
    expect(c.statuses).toContain('reconnecting');
    // First backoff is full-jitter in [0, 500); advancing 500ms guarantees it fires.
    await settle(500);
    expect(conns.length).toBeGreaterThanOrEqual(2);
  });

  it('stops (fatal) on a 404 and does not reconnect', async () => {
    const { api, conns, urls } = apiFrom((i) => (i === 0 ? { status: 404 } : 'sse'));
    const c = oddsCollector();
    startMoneyline(api, c.handlers);
    await settle();
    await settle(1000);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]?.reason).toBe('fatal');
    expect(conns).toHaveLength(0);
    expect(urls).toHaveLength(1);
  });

  it('reports capacity_exceeded on a 429', async () => {
    const { api } = apiFrom((i) => (i === 0 ? { status: 429 } : 'sse'));
    const c = oddsCollector();
    startMoneyline(api, c.handlers);
    await settle();
    expect(c.errors[0]?.reason).toBe('capacity_exceeded');
  });
});

describe('subscribeToOddsStream — lifecycle invariant (no delivery after unsubscribe)', () => {
  it('suppresses the connected status when onSnapshot unsubscribes', async () => {
    const { api, conns } = apiFrom();
    const snaps: (MoneylineOdds | null)[] = [];
    const statuses: StreamStatus[] = [];
    let sub!: Subscription;
    sub = startMoneyline(api, {
      onSnapshot: (o) => {
        snaps.push(o);
        void sub.unsubscribe();
      },
      onChange: () => {},
      onStatus: (s) => statuses.push(s),
    });
    await settle();
    conns[0]?.push(frame('snapshot', ml(148, -167)));
    await settle();
    expect(snaps).toHaveLength(1);
    expect(statuses).not.toContain('connected');
  });

  it('stops delivering deltas once a handler unsubscribes mid-stream', async () => {
    const { api, conns } = apiFrom();
    const changes: MoneylineOdds[] = [];
    let sub!: Subscription;
    sub = startMoneyline(api, {
      onSnapshot: () => {},
      onChange: (o) => {
        changes.push(o);
        void sub.unsubscribe();
      },
    });
    await settle();
    conns[0]?.push(frame('snapshot', ml(148, -167)));
    await settle();
    conns[0]?.push(frame('change', ml(150, -170)));
    await settle();
    conns[0]?.push(frame('change', ml(151, -171)));
    await settle();
    expect(changes).toHaveLength(1);
  });

  it('delivers nothing when unsubscribed before the first snapshot arrives', async () => {
    const { api, conns } = apiFrom();
    const c = oddsCollector();
    const sub = startMoneyline(api, c.handlers);
    await settle();
    await sub.unsubscribe();
    await settle();
    conns[0]?.push(frame('snapshot', ml(148, -167)));
    await settle();
    expect(c.snapshots).toEqual([]);
    expect(c.changes).toEqual([]);
    expect(c.statuses).toEqual([]);
  });
});

describe('client.odds.subscribe — integration', () => {
  it('builds the contest-id query and decodes the market shape', async () => {
    const { fetch, conns, urls } = fakeStreaming();
    const client = new OspexClient({ apiUrl: 'http://test.local', fetch });
    const snaps: unknown[] = [];
    await client.odds.subscribe(
      { contestId: 42, market: 'moneyline' },
      { onChange: () => {}, onSnapshot: (o) => snaps.push(o) },
    );
    await settle();
    expect(urls[0]).toContain('/v1/stream/odds');
    expect(urls[0]).toContain('contestId=42');
    expect(urls[0]).toContain('market=moneyline');
    conns[0]?.push(frame('snapshot', ml(148, -167)));
    await settle();
    expect(snaps[0]).toMatchObject({ market: 'moneyline', awayOddsAmerican: 148 });
  });

  it('rejects a non-integer contestId before opening a stream', async () => {
    const { fetch, urls } = fakeStreaming();
    const client = new OspexClient({ apiUrl: 'http://test.local', fetch });
    await expect(
      client.odds.subscribe({ contestId: 'abc', market: 'moneyline' }, { onChange: () => {} }),
    ).rejects.toThrow(/contestId/);
    expect(urls).toHaveLength(0);
  });
});
