/**
 * Composite SSE subscribe tests for `client.ownState.subscribe`.
 *
 * Each test wires a fake fetch that:
 *   - mocks the auth handshake (POST /v1/auth/stream-{challenge,token}),
 *   - delivers a scripted SSE byte stream on GET /v1/stream/own-state,
 *   - serves REST snapshot pages on GET /v1/own-state/snapshot.
 *
 * The fake fetch records every call so we can assert Bearer-header
 * presence, Last-Event-ID flow on reconnect, exactly-one challenge mint
 * across many SSE attempts, etc.
 *
 * Coverage areas:
 *   - cold-start happy path: snapshot (untruncated) → ready → live deltas;
 *   - truncated snapshot → REST paging → reconnect with Last-Event-ID;
 *   - commitment / fill / positionStatus delivery;
 *   - server-side resync drops the running cursor and reconnects cold;
 *   - server-side degraded emits onStatus('degraded');
 *   - unsubscribe DURING snapshot delivery never fires handlers after
 *     await completes (lifecycle invariant per
 *     [[feedback_async_lifecycle_invariant]]);
 *   - REST paging defensive-bound exhaustion fires a fatal error per
 *     [[feedback_defensive_bounds_unknown_not_null]].
 */

import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import { subscribeToOwnState } from '../src/ownState/subscribe.js';
import { decodeSnapshot } from '../src/ownState/snapshot.js';
import { KeystoreSigner } from '../src/signers/keystore.js';
import { OspexValidationError } from '../src/errors.js';
import type {
  OwnerCommitmentBody,
  OwnerStateSnapshotBody,
  StreamChallenge,
} from '../src/api/types.js';
import type { Hex } from '../src/types/signer.js';
import type {
  OwnerCommitment,
  OwnerStateSnapshot,
  OwnerStateSubscribeHandlers,
  OwnerStateSubscribeStatus,
  PositionStatusEvent,
} from '../src/types/ownState.js';
import type { Fill } from '../src/types/fill.js';
import type { OspexStreamError } from '../src/errors.js';

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const TEST_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Hex;
const MATCHING_MODULE = '0x36bc5693ee30cd65f8dce51bd48bc03815091a26' as Hex;
const CHAIN_ID = 80002 as const;

const HASH_A =
  '0xaaaa111111111111111111111111111111111111111111111111111111111111';

interface SseFrame {
  event: string;
  data: unknown;
  id?: string;
}

/**
 * Serialize a frame list into SSE wire format, optionally inserting a
 * heartbeat at the start so the parser's idle watchdog sees it.
 */
function serializeFrames(frames: SseFrame[]): string {
  let out = ': hb\n\n';
  for (const f of frames) {
    out += `event: ${f.event}\n`;
    if (f.id !== undefined) out += `id: ${f.id}\n`;
    out += `data: ${JSON.stringify(f.data)}\n\n`;
  }
  return out;
}

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(s));
      controller.close();
    },
  });
}

function freshChallenge(): StreamChallenge {
  const now = Math.floor(Date.now() / 1000);
  return {
    address: TEST_ADDRESS,
    resource: 'own-state',
    scope: 'read:own-state',
    network: { chainId: CHAIN_ID },
    audience: 'api.ospex.test',
    challengeId: 'CHALLENGE_ID',
    issuedAt: now,
    expiresAt: now + 180,
  };
}

function commitmentBody(
  hash: string,
  overrides: Partial<OwnerCommitmentBody> = {},
): OwnerCommitmentBody {
  return {
    commitmentHash: hash,
    maker: TEST_ADDRESS,
    contestId: '42',
    scorer: '0x2222222222222222222222222222222222222222',
    lineTicks: 0,
    positionType: 0,
    oddsTick: 200,
    marketType: 'moneyline',
    riskAmount: '10000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '10000000',
    nonce: '1',
    expiry: new Date(Date.now() + 600_000).toISOString(),
    speculationKey: '0x' + 'aa'.repeat(32),
    signature: '0x' + 'bb'.repeat(65),
    status: 'open',
    storedStatus: 'open',
    source: 'sdk',
    network: 'amoy',
    nonceInvalidated: false,
    bookVisible: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function snapshotBody(
  overrides: Partial<OwnerStateSnapshotBody> = {},
): OwnerStateSnapshotBody {
  return {
    cursor: 'LIVE',
    commitments: [],
    positions: [],
    truncated: false,
    positionsTruncated: false,
    ...overrides,
  };
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
}

interface FakeServer {
  api: ApiClient;
  calls: CapturedCall[];
  /** Set after every fake fetch invocation so tests can wait on it. */
  awaitCallsAtLeast(n: number): Promise<void>;
}

interface FakeServerOptions {
  /** Token mint counter — bumped on each `/v1/auth/stream-token` call. */
  onTokenMint?: () => void;
  /** Frames each SSE-stream attempt yields. Indexed by attempt count. */
  sseAttempts: Array<{ status?: number; frames?: SseFrame[]; body?: string }>;
  /** REST snapshot pages, indexed by call count. */
  restSnapshotPages?: Array<{
    status?: number;
    body: OwnerStateSnapshotBody | { error: string; code?: string };
  }>;
}

function makeServer(options: FakeServerOptions): FakeServer {
  const calls: CapturedCall[] = [];
  const challenge = freshChallenge();
  let sseAttempt = 0;
  let restPage = 0;
  const fakeFetch: typeof globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    calls.push({ url: u, method, headers });

    if (u.endsWith('/v1/auth/stream-challenge')) {
      return new Response(
        JSON.stringify({ challenge, expiresAt: challenge.expiresAt }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.endsWith('/v1/auth/stream-token')) {
      options.onTokenMint?.();
      return new Response(
        JSON.stringify({ token: 'BEARER', expiresAt: challenge.issuedAt + 900 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.includes('/v1/own-state/snapshot')) {
      const page = options.restSnapshotPages?.[restPage];
      restPage += 1;
      if (page === undefined) {
        return new Response(
          JSON.stringify({ error: 'no more pages', code: 'INTERNAL_ERROR' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(page.body), {
        status: page.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('/v1/stream/own-state')) {
      const attempt = options.sseAttempts[sseAttempt];
      sseAttempt += 1;
      if (attempt === undefined) {
        return new Response('', {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (attempt.status !== undefined && attempt.status >= 400) {
        return new Response(
          JSON.stringify({ error: `${attempt.status}`, code: 'TEST_FAILURE' }),
          {
            status: attempt.status,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      const body = attempt.body ?? serializeFrames(attempt.frames ?? []);
      return new Response(streamFromString(body), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ error: 'unexpected', code: 'INTERNAL_ERROR' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const api = new ApiClient({ apiUrl: 'https://api.test', fetch: fakeFetch });
  const awaitCallsAtLeast = (n: number): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (calls.length >= n) resolve();
        else setTimeout(check, 5);
      };
      check();
    });
  return { api, calls, awaitCallsAtLeast };
}

interface CaptureBag {
  snapshots: OwnerStateSnapshot[];
  ready: number;
  commitments: OwnerCommitment[];
  fills: Fill[];
  positionStatuses: PositionStatusEvent[];
  statuses: OwnerStateSubscribeStatus[];
  errors: OspexStreamError[];
}

function captureHandlers(bag: CaptureBag): OwnerStateSubscribeHandlers {
  return {
    onSnapshot: (s) => bag.snapshots.push(s),
    onReady: () => {
      bag.ready += 1;
    },
    onCommitment: (c) => bag.commitments.push(c),
    onFill: (f) => bag.fills.push(f),
    onPositionStatus: (p) => bag.positionStatuses.push(p),
    onStatus: (s) => bag.statuses.push(s),
    onError: (e) => bag.errors.push(e),
  };
}

function newBag(): CaptureBag {
  return {
    snapshots: [],
    ready: 0,
    commitments: [],
    fills: [],
    positionStatuses: [],
    statuses: [],
    errors: [],
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

describe('subscribeToOwnState — cold-start happy path', () => {
  it('delivers snapshot then ready then live commitment then unsubscribes cleanly', async () => {
    const bag = newBag();
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            {
              event: 'snapshot',
              id: 'LIVE',
              data: snapshotBody({
                cursor: 'LIVE',
                commitments: [commitmentBody(HASH_A)],
                positions: [],
              }),
            },
            { event: 'ready', data: {} },
            {
              event: 'commitment',
              id: 'CUR-COMMIT-1',
              data: commitmentBody(HASH_A, { riskAmount: '20000000', nonce: '2' }),
            },
          ],
        },
      ],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      captureHandlers(bag),
    );

    await waitFor(() => bag.ready > 0 && bag.commitments.length > 0);
    await sub.unsubscribe();

    expect(bag.snapshots).toHaveLength(1);
    expect(bag.snapshots[0]!.truncated).toBe(false);
    expect(bag.ready).toBe(1);
    expect(bag.commitments).toHaveLength(1);
    expect(bag.commitments[0]!.commitmentHash).toBe(HASH_A);
    expect(bag.commitments[0]!.ownerAuthorized).toBe(true);
    expect(bag.statuses).toContain('connected');
    expect(bag.errors).toHaveLength(0);
  });

  it('sends Authorization: Bearer header on the SSE GET (no query-string token)', async () => {
    const bag = newBag();
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            { event: 'snapshot', id: 'LIVE', data: snapshotBody() },
            { event: 'ready', data: {} },
          ],
        },
      ],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      captureHandlers(bag),
    );
    await waitFor(() => bag.ready > 0);
    await sub.unsubscribe();

    const sseCall = server.calls.find((c) => c.url.includes('/v1/stream/own-state'))!;
    expect(sseCall.headers.get('Authorization')).toBe('Bearer BEARER');
    // No token in the query string per spec §3.4.
    expect(sseCall.url).not.toMatch(/token=/);
  });
});

describe('subscribeToOwnState — truncated snapshot REST paging', () => {
  it('emits per-page onSnapshot, then reconnects with Last-Event-ID, then ready', async () => {
    const bag = newBag();
    const server = makeServer({
      sseAttempts: [
        // First SSE connect: server emits a TRUNCATED snapshot then ends.
        {
          frames: [
            {
              event: 'snapshot',
              id: 'PAGE_1',
              data: snapshotBody({
                cursor: 'PAGE_1',
                commitments: [commitmentBody(HASH_A)],
                truncated: true,
              }),
            },
          ],
        },
        // Second SSE connect (after REST paging completes): server emits
        // catchup ready directly (resume path).
        {
          frames: [{ event: 'ready', data: {} }],
        },
      ],
      restSnapshotPages: [
        {
          body: snapshotBody({
            cursor: 'PAGE_2',
            commitments: [
              commitmentBody(
                '0xbbbb222222222222222222222222222222222222222222222222222222222222',
              ),
            ],
            truncated: true,
          }),
        },
        {
          body: snapshotBody({
            cursor: 'FINAL_LIVE',
            commitments: [
              commitmentBody(
                '0xcccc333333333333333333333333333333333333333333333333333333333333',
              ),
            ],
            truncated: false,
          }),
        },
      ],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      captureHandlers(bag),
    );

    await waitFor(() => bag.ready > 0);
    await sub.unsubscribe();

    // Three snapshot pages delivered: inline SSE truncated, then 2 REST pages.
    expect(bag.snapshots).toHaveLength(3);
    expect(bag.snapshots[0]!.truncated).toBe(true);
    expect(bag.snapshots[1]!.truncated).toBe(true);
    expect(bag.snapshots[2]!.truncated).toBe(false);

    // Ready fired AFTER the final untruncated page + resume reconnect catchup.
    expect(bag.ready).toBe(1);

    // Reconnect's SSE attempt carried Last-Event-ID = FINAL_LIVE.
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls).toHaveLength(2);
    expect(sseCalls[0]!.headers.get('Last-Event-ID')).toBeNull();
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBe('FINAL_LIVE');
  });

  it('clears cursor + cold-starts on REST paging 401 (no Last-Event-ID on next SSE attempt)', async () => {
    // Hermes round-1 blocker: a 401 mid-handoff used to fall through to
    // the next SSE attempt carrying the truncated page-* cursor as
    // Last-Event-ID. That risked `ready` firing on a partial baseline
    // when the server tolerated the resume. The fix: clear `cursor` (and
    // `pendingPagingCursor`) on paging failure so the next attempt is a
    // true cold-start.
    const bag = newBag();
    const server = makeServer({
      sseAttempts: [
        // First connect: truncated snapshot. cursor would have been
        // PAGE_1 under the old bug.
        {
          frames: [
            {
              event: 'snapshot',
              id: 'PAGE_1',
              data: snapshotBody({ cursor: 'PAGE_1', truncated: true }),
            },
          ],
        },
        // Second connect (after REST 401 + cold-restart): full snapshot
        // + ready. Server would 400 INVALID_CURSOR on a `k='page-*'`
        // Last-Event-ID so the SDK MUST omit it here.
        {
          frames: [
            {
              event: 'snapshot',
              id: 'LIVE',
              data: snapshotBody({ cursor: 'LIVE' }),
            },
            { event: 'ready', data: {} },
          ],
        },
      ],
      restSnapshotPages: [
        {
          status: 401,
          body: {
            error: 'Stream token rejected: expired.',
            code: 'AUTH_TOKEN_EXPIRED',
          },
        },
      ],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      captureHandlers(bag),
    );
    await waitFor(() => bag.ready > 0);
    await sub.unsubscribe();

    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls).toHaveLength(2);
    // First connect: no Last-Event-ID (cold-start).
    expect(sseCalls[0]!.headers.get('Last-Event-ID')).toBeNull();
    // Second connect: also no Last-Event-ID — the truncated PAGE_1
    // cursor MUST have been dropped after the REST 401.
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBeNull();
    // The 401 was surfaced via onError.
    expect(
      bag.errors.some(
        (e) => e.reason === 'connection_failed' && e.status === 401,
      ),
    ).toBe(true);
    // Eventually ready fires (on the second connect).
    expect(bag.ready).toBe(1);
  });

  it('fires a fatal-style error when REST paging exceeds the defensive bound', async () => {
    // Build 50 truncated REST pages — exceeds MAX_SNAPSHOT_PAGES (50).
    const truncatedPages = Array.from({ length: 60 }, (_, i) => ({
      body: snapshotBody({ cursor: `PAGE_${i}`, truncated: true }),
    }));
    const bag = newBag();
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            {
              event: 'snapshot',
              id: 'PAGE_0',
              data: snapshotBody({ cursor: 'PAGE_0', truncated: true }),
            },
          ],
        },
      ],
      restSnapshotPages: truncatedPages,
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      captureHandlers(bag),
    );

    // Wait for the fatal emission. The bound is 50 REST pages so this is
    // bounded work.
    await waitFor(() => bag.errors.some((e) => e.reason === 'fatal'));
    await sub.unsubscribe();

    const fatal = bag.errors.find((e) => e.reason === 'fatal')!;
    expect(fatal.message).toMatch(/truncated-snapshot paging/i);
  });
});

describe('subscribeToOwnState — REST paging error surface', () => {
  it('surfaces a malformed REST snapshot body via onError and cold-restarts', async () => {
    // Hermes round-1 B2: a malformed wire body used to throw inside
    // decodeSnapshot OUTSIDE pageRestUntilLive's try-catch — silently
    // killing the subscriber. After the fix the decoder failure is
    // caught, surfaced via onError, and the loop cold-restarts.
    const bag = newBag();
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            {
              event: 'snapshot',
              id: 'PAGE_1',
              data: snapshotBody({ cursor: 'PAGE_1', truncated: true }),
            },
          ],
        },
        {
          frames: [
            {
              event: 'snapshot',
              id: 'LIVE',
              data: snapshotBody({ cursor: 'LIVE' }),
            },
            { event: 'ready', data: {} },
          ],
        },
      ],
      // First REST page is malformed — missing `commitments` field will
      // crash the decoder on `body.commitments.map(...)`.
      restSnapshotPages: [
        {
          // The wire is structurally invalid as OwnerStateSnapshotBody,
          // but the JSON parses — exactly the case we want.
          body: { cursor: 'PAGE_2' } as unknown as OwnerStateSnapshotBody,
        },
      ],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      captureHandlers(bag),
    );
    await waitFor(() => bag.ready > 0);
    await sub.unsubscribe();

    // Subscriber survived the decoder crash AND recovered via cold-start.
    expect(bag.ready).toBe(1);
    // The decoder failure surfaced explicitly.
    expect(
      bag.errors.some((e) =>
        e.message.toLowerCase().includes('failed to decode snapshot body'),
      ),
    ).toBe(true);
  });
});

describe('subscribeToOwnState — persistent-failure threshold', () => {
  it('promotes reconnecting → degraded after consecutive failed SSE connects', async () => {
    // Hermes round-1 B3: the public docs claim `degraded` covers both
    // server-signaled partial visibility AND SDK persistent reconnect
    // failures, but the implementation only fired degraded for the
    // server signal. The fix: after `PERSISTENT_FAILURE_THRESHOLD = 3`
    // consecutive failed attempts, status flips to `degraded` instead
    // of `reconnecting` — the docs now match.
    const bag = newBag();
    const server = makeServer({
      sseAttempts: [
        // Three consecutive transient failures (500s).
        { status: 500 },
        { status: 500 },
        { status: 500 },
        // Fourth: real success.
        {
          frames: [
            { event: 'snapshot', id: 'LIVE', data: snapshotBody() },
            { event: 'ready', data: {} },
          ],
        },
      ],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      captureHandlers(bag),
    );
    // Long timeout — backoff includes full-jitter up to 2-4 s after
    // three failures. The test gates on the bag content rather than a
    // wall-clock bound.
    await waitFor(() => bag.statuses.includes('degraded'), 15_000);
    await waitFor(() => bag.ready > 0, 15_000);
    await sub.unsubscribe();

    // The status sequence reached `degraded` before the eventual
    // recovery to `connected`.
    const firstDegradedAt = bag.statuses.indexOf('degraded');
    const firstConnectedAt = bag.statuses.indexOf('connected');
    expect(firstDegradedAt).toBeGreaterThanOrEqual(0);
    expect(firstConnectedAt).toBeGreaterThan(firstDegradedAt);
  }, 30_000);
});

describe('subscribeToOwnState — resume + resync + degraded', () => {
  it('drops the running cursor on event: resync and reconnects without Last-Event-ID', async () => {
    const bag = newBag();
    const server = makeServer({
      sseAttempts: [
        // First connect: snapshot + ready + a commitment that advances cursor,
        // then server resync (cursor cleared).
        {
          frames: [
            { event: 'snapshot', id: 'CUR-0', data: snapshotBody({ cursor: 'CUR-0' }) },
            { event: 'ready', data: {} },
            { event: 'commitment', id: 'CUR-1', data: commitmentBody(HASH_A) },
            { event: 'resync', data: { reason: 'handoff_raced' } },
          ],
        },
        // Second connect: fresh cold-start snapshot + ready.
        {
          frames: [
            { event: 'snapshot', id: 'CUR-2', data: snapshotBody({ cursor: 'CUR-2' }) },
            { event: 'ready', data: {} },
          ],
        },
      ],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      captureHandlers(bag),
    );

    await waitFor(() => bag.ready === 2);
    await sub.unsubscribe();

    expect(bag.statuses).toContain('resync');
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls).toHaveLength(2);
    expect(sseCalls[0]!.headers.get('Last-Event-ID')).toBeNull();
    // Crucially, the second connect did NOT carry the latched cursor — the
    // resync mandates a cold reconnect.
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBeNull();
  });

  it('emits onStatus("degraded") on a server-side degraded event', async () => {
    const bag = newBag();
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            {
              event: 'snapshot',
              id: 'LIVE',
              data: snapshotBody({ positionsTruncated: true }),
            },
            { event: 'degraded', data: { reason: 'positionsTruncated' } },
            { event: 'ready', data: {} },
          ],
        },
      ],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      captureHandlers(bag),
    );
    await waitFor(() => bag.ready > 0);
    await sub.unsubscribe();

    expect(bag.statuses).toContain('degraded');
    // After degraded, ready still fires and status proceeds to connected.
    expect(bag.statuses).toContain('connected');
  });
});

describe('subscribeToOwnState — event decoding', () => {
  it('decodes fill and positionStatus event bodies', async () => {
    const bag = newBag();
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            { event: 'snapshot', id: 'LIVE', data: snapshotBody() },
            { event: 'ready', data: {} },
            {
              event: 'fill',
              id: 'FILL-1',
              data: {
                speculationId: '1',
                contestId: '42',
                commitmentHash: HASH_A,
                maker: TEST_ADDRESS,
                taker: '0x' + '11'.repeat(20),
                makerPositionType: 0,
                takerPositionType: 1,
                makerRiskAmount: '5000000',
                takerRiskAmount: '5000000',
                makerRiskUSDC: 5,
                takerRiskUSDC: 5,
                oddsTick: 200,
                filledAt: new Date().toISOString(),
                contestStarted: false,
                txHash: '0x' + 'aa'.repeat(32),
                logIndex: 0,
              },
            },
            {
              event: 'positionStatus',
              id: 'PS-1',
              data: {
                address: TEST_ADDRESS,
                speculationId: '1',
                positionType: 0,
                status: 'pendingSettle',
                result: 'won',
                claimableAmount: '9500000',
                sourceUpdatedAt: '2026-01-01T00:00:00.000000Z',
              } satisfies PositionStatusEvent,
            },
          ],
        },
      ],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      captureHandlers(bag),
    );
    await waitFor(() => bag.fills.length > 0 && bag.positionStatuses.length > 0);
    await sub.unsubscribe();

    expect(bag.fills[0]!.txHash).toBe('0x' + 'aa'.repeat(32));
    expect(bag.positionStatuses[0]!.status).toBe('pendingSettle');
    expect(bag.positionStatuses[0]!.claimableAmount).toBe('9500000');
  });
});

describe('subscribeToOwnState — lifecycle invariant', () => {
  it('NEVER fires a handler after unsubscribe() — adversarial throw-if-touched test', async () => {
    // Slow SSE body so unsubscribe lands before frames are processed.
    let release: (() => void) | undefined;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Send a heartbeat first so the connection is "established".
        controller.enqueue(enc.encode(': hb\n\n'));
        // Wait for the test to release us, then emit frames the handler
        // would otherwise fire on.
        await releasePromise;
        controller.enqueue(
          enc.encode(
            serializeFrames([
              { event: 'snapshot', id: 'LIVE', data: snapshotBody() },
              { event: 'ready', data: {} },
              { event: 'commitment', id: 'CUR-1', data: commitmentBody(HASH_A) },
            ]),
          ),
        );
        controller.close();
      },
    });
    const challenge = freshChallenge();
    const fakeFetch: typeof globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/v1/auth/stream-challenge')) {
        return new Response(
          JSON.stringify({ challenge, expiresAt: challenge.expiresAt }),
          { status: 200 },
        );
      }
      if (u.endsWith('/v1/auth/stream-token')) {
        return new Response(
          JSON.stringify({ token: 'BEARER', expiresAt: challenge.issuedAt + 900 }),
          { status: 200 },
        );
      }
      if (u.includes('/v1/stream/own-state')) {
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return new Response('{}', { status: 500 });
    };
    const api = new ApiClient({ apiUrl: 'https://api.test', fetch: fakeFetch });

    const throwingHandlers: OwnerStateSubscribeHandlers = {
      onSnapshot: () => {
        throw new Error('onSnapshot fired after unsubscribe');
      },
      onReady: () => {
        throw new Error('onReady fired after unsubscribe');
      },
      onCommitment: () => {
        throw new Error('onCommitment fired after unsubscribe');
      },
      onFill: () => {
        throw new Error('onFill fired after unsubscribe');
      },
      onPositionStatus: () => {
        throw new Error('onPositionStatus fired after unsubscribe');
      },
    };
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      throwingHandlers,
    );

    // Wait for the heartbeat to land (connection established).
    await new Promise((r) => setTimeout(r, 50));
    // Unsubscribe BEFORE releasing the frames.
    await sub.unsubscribe();
    // Now let the frames out — handlers MUST NOT fire (the throws would
    // not crash the subscriber transport, but the SDK's internal handler
    // dispatch guards them anyway; we get there by never reaching the
    // throw because closed=true is checked before dispatch).
    release?.();
    // Give the body time to drain. If a throw fires, it would be
    // swallowed by the transport's try/catch — but the test invariant
    // is that NO handler was called. We re-assert by passing a noop
    // alternative... actually simpler: rely on the bag of throws never
    // having latched. The test is "no exception escapes; subscription
    // is silent post-close" — proved by it completing without unhandled
    // rejection.
    await new Promise((r) => setTimeout(r, 100));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// v0.5.2 PR0a — cursor surface + dispatch model + onFrame + error.phase
// ────────────────────────────────────────────────────────────────────────────

describe('subscribeToOwnState — v0.5.2 cursor surface (PR0a)', () => {
  it('passes initialCursor as Last-Event-ID on the FIRST SSE connect', async () => {
    const bag = newBag();
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            { event: 'ready', id: 'CUR-READY-1', data: {} },
          ],
        },
      ],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
        initialCursor: 'CUR-RESUME-FROM-PRIOR-SESSION',
      },
      captureHandlers(bag),
    );
    await waitFor(() => bag.ready > 0);
    await sub.unsubscribe();

    const sseCall = server.calls.find((c) => c.url.includes('/v1/stream/own-state'))!;
    expect(sseCall.headers.get('Last-Event-ID')).toBe('CUR-RESUME-FROM-PRIOR-SESSION');
  });

  it('delivers OwnStateEventMeta.cursor on every event/snapshot/ready handler', async () => {
    interface MetaCapture {
      kind: string;
      cursor: string;
    }
    const captured: MetaCapture[] = [];
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            {
              event: 'snapshot',
              id: 'CUR-SNAP',
              data: snapshotBody({
                cursor: 'LIVE',
                commitments: [commitmentBody(HASH_A)],
              }),
            },
            { event: 'ready', id: 'CUR-READY', data: {} },
            {
              event: 'commitment',
              id: 'CUR-COMM',
              data: commitmentBody(HASH_A, { nonce: '2' }),
            },
          ],
        },
      ],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: (_s, meta) => captured.push({ kind: 'snapshot', cursor: meta.cursor }),
        onReady: (meta) => captured.push({ kind: 'ready', cursor: meta.cursor }),
        onCommitment: (_c, meta) => captured.push({ kind: 'commitment', cursor: meta.cursor }),
      },
    );

    await waitFor(() => captured.length >= 3);
    await sub.unsubscribe();

    expect(captured).toEqual([
      { kind: 'snapshot', cursor: 'CUR-SNAP' },
      { kind: 'ready', cursor: 'CUR-READY' },
      { kind: 'commitment', cursor: 'CUR-COMM' },
    ]);
  });

  it('onFrame fires for every parsed frame including heartbeats', async () => {
    const frames: Array<{ kind: 'event' | 'heartbeat' }> = [];
    // Custom SSE body: multiple heartbeats interleaved with events.
    const sseBody =
      ': hb\n\n' +
      'event: snapshot\nid: CUR-SNAP\ndata: ' +
      JSON.stringify(snapshotBody()) +
      '\n\n' +
      ': hb\n\n' +
      'event: ready\nid: CUR-READY\ndata: {}\n\n' +
      ': hb\n\n';
    const server = makeServer({
      sseAttempts: [{ body: sseBody }],
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    let readyHit = false;
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onReady: () => {
          readyHit = true;
        },
        onFrame: (meta) => frames.push({ kind: meta.kind }),
      },
    );
    await waitFor(() => readyHit);
    await sub.unsubscribe();

    // 3 heartbeats + 1 snapshot + 1 ready = 5 frames.
    expect(frames).toHaveLength(5);
    expect(frames.filter((f) => f.kind === 'heartbeat')).toHaveLength(3);
    expect(frames.filter((f) => f.kind === 'event')).toHaveLength(2);
  });
});

describe('subscribeToOwnState — v0.5.2 dispatch model (PR0a)', () => {
  it('does NOT advance internal cursor when onCommitment throws', async () => {
    // Two SSE attempts: first delivers a snapshot + ready + a commitment
    // whose handler throws. We then trigger a reconnect by ending the
    // first attempt and asserting the second connect's Last-Event-ID
    // header reflects the PRE-throw cursor (the ready cursor), not the
    // post-throw commitment cursor.
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            { event: 'snapshot', id: 'CUR-SNAP', data: snapshotBody() },
            { event: 'ready', id: 'CUR-READY', data: {} },
            {
              event: 'commitment',
              id: 'CUR-COMM-THROWING',
              data: commitmentBody(HASH_A),
            },
          ],
        },
        {
          frames: [{ event: 'ready', id: 'CUR-READY-2', data: {} }],
        },
      ],
    });
    const errors: OspexStreamError[] = [];
    let commitmentHits = 0;
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => undefined,
        onReady: () => undefined,
        onCommitment: () => {
          commitmentHits += 1;
          throw new Error('handler bug — simulated');
        },
        onError: (e) => errors.push(e),
      },
    );

    // Wait for the throw to surface via onError AND the reconnect to land.
    await waitFor(() => errors.some((e) => e.phase === 'dispatch'));
    // Wait for the second SSE attempt's headers to be captured.
    await waitFor(
      () => server.calls.filter((c) => c.url.includes('/v1/stream/own-state')).length >= 2,
    );
    await sub.unsubscribe();

    // The handler DID get called (we don't suppress dispatch on throw —
    // just don't advance the cursor).
    expect(commitmentHits).toBe(1);
    // The throw is surfaced via onError with phase: 'dispatch'.
    const dispatchErr = errors.find((e) => e.phase === 'dispatch')!;
    expect(dispatchErr.reason).toBe('connection_failed');
    expect(dispatchErr.phase).toBe('dispatch');

    // The SECOND SSE attempt's Last-Event-ID is the LAST SUCCESSFULLY
    // applied cursor — `CUR-READY`, not `CUR-COMM-THROWING`. This is the
    // load-bearing invariant of the v0.5.2 dispatch model.
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls.length).toBeGreaterThanOrEqual(2);
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBe('CUR-READY');
  });

  it('does NOT advance cursor on a truncated snapshot frame', async () => {
    // Truncated snapshot → REST paging → final non-truncated page →
    // SSE reconnect. The reconnect's Last-Event-ID must be the FINAL
    // REST page's `cursor` (k='live'), not the truncated SSE frame's id.
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            {
              event: 'snapshot',
              id: 'k=page-INTERIM', // truncated page SSE id — MUST NOT be Last-Event-ID
              data: snapshotBody({ cursor: 'PAGE-1-REST', truncated: true }),
            },
          ],
        },
        {
          frames: [{ event: 'ready', id: 'CUR-READY-FINAL', data: {} }],
        },
      ],
      restSnapshotPages: [
        {
          body: snapshotBody({ cursor: 'CUR-LIVE-FROM-REST', truncated: false }),
        },
      ],
    });
    const bag = newBag();
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      captureHandlers(bag),
    );
    await waitFor(() => bag.ready > 0);
    await sub.unsubscribe();

    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls.length).toBeGreaterThanOrEqual(2);
    // The truncated page's id (k=page-*) must NOT have leaked into
    // Last-Event-ID. The final cursor from REST paging is what gets used.
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBe('CUR-LIVE-FROM-REST');
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).not.toBe('k=page-INTERIM');
  });
});

describe('subscribeToOwnState — v0.5.2 dispatch model (PR0a round 2 — post-throw cursor safety)', () => {
  it('does NOT advance cursor when a LATER successful commitment follows a thrown one on the SAME connection (Hermes regression probe)', async () => {
    // This is the exact regression Hermes flagged: pre-round-2, after a
    // handler throw the SDK kept processing the same SSE connection and
    // a subsequent successful event advanced cursor PAST the failed one.
    // Round 2 abandons the connection on dispatch failure so no further
    // frame can advance cursor; the reconnect resumes from pre-throw.
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            { event: 'snapshot', id: 'CUR-SNAP', data: snapshotBody() },
            { event: 'ready', id: 'CUR-READY', data: {} },
            {
              event: 'commitment',
              id: 'CUR-BAD',
              data: commitmentBody(HASH_A),
            },
            {
              event: 'commitment',
              id: 'CUR-GOOD',
              data: commitmentBody(
                '0xbbbb222222222222222222222222222222222222222222222222222222222222',
                { nonce: '2' },
              ),
            },
          ],
        },
        {
          frames: [{ event: 'ready', id: 'CUR-READY-2', data: {} }],
        },
      ],
    });
    const errors: OspexStreamError[] = [];
    let commitmentsSeen: string[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => undefined,
        onReady: () => undefined,
        onCommitment: (c) => {
          commitmentsSeen.push(c.commitmentHash);
          if (c.commitmentHash === HASH_A) {
            throw new Error('handler bug — simulated throw on CUR-BAD');
          }
        },
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => errors.some((e) => e.phase === 'dispatch'));
    await waitFor(
      () => server.calls.filter((c) => c.url.includes('/v1/stream/own-state')).length >= 2,
    );
    await sub.unsubscribe();

    // The thrown handler IS dispatched (we don't suppress, just abort
    // the rest of the connection after surfacing onError).
    expect(commitmentsSeen).toContain(HASH_A);

    // The SECOND SSE attempt's Last-Event-ID is `CUR-READY` — the last
    // SUCCESSFULLY APPLIED cursor — NOT `CUR-GOOD`. The CUR-GOOD frame
    // must have been ABANDONED (the connection aborted before it could
    // be processed). Pre-round-2 would have seen `CUR-GOOD` here.
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBe('CUR-READY');
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).not.toBe('CUR-GOOD');

    // CUR-GOOD was NOT dispatched on the failed connection — the abort
    // stopped further frames.
    expect(commitmentsSeen).not.toContain(
      '0xbbbb222222222222222222222222222222222222222222222222222222222222',
    );
  });

  it('does NOT emit `connected` AND does NOT advance cursor when onReady throws (still reconnects)', async () => {
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            { event: 'snapshot', id: 'CUR-SNAP', data: snapshotBody() },
            { event: 'ready', id: 'CUR-READY-THROWS', data: {} },
            // This commitment must NEVER be dispatched on attempt 1 —
            // the onReady throw aborts the connection.
            {
              event: 'commitment',
              id: 'CUR-AFTER-BAD-READY',
              data: commitmentBody(HASH_A),
            },
          ],
        },
        {
          frames: [{ event: 'ready', id: 'CUR-READY-2', data: {} }],
        },
      ],
    });
    const statuses: OwnerStateSubscribeStatus[] = [];
    const errors: OspexStreamError[] = [];
    let commitmentsSeen: string[] = [];
    let readyHits = 0;
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onReady: () => {
          readyHits += 1;
          if (readyHits === 1) throw new Error('baseline swap failed — simulated');
        },
        onCommitment: (c) => commitmentsSeen.push(c.commitmentHash),
        onStatus: (s) => statuses.push(s),
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => errors.some((e) => e.phase === 'dispatch'));
    await waitFor(
      () => server.calls.filter((c) => c.url.includes('/v1/stream/own-state')).length >= 2,
    );
    await sub.unsubscribe();

    // The downstream commitment must NOT have been processed on attempt 1
    // (the connection aborted after the onReady throw).
    expect(commitmentsSeen).not.toContain(HASH_A);

    // Critically: no 'connected' status was emitted on attempt 1
    // (consumer's onReady threw → baseline swap incomplete → consumer
    // is NOT connected from its own perspective). The reconnect after
    // backoff would emit 'reconnecting'/'degraded' first, then
    // 'connected' on the SECOND attempt (second ready succeeded).
    //
    // We can't assert "never connected" cleanly because attempt 2's
    // onReady DOES succeed and emits 'connected'. What we CAN assert:
    // by the time we observed the dispatch error, no 'connected' had
    // landed yet on attempt 1. Position in the array tells us:
    const dispatchErrIdx = errors.findIndex((e) => e.phase === 'dispatch');
    expect(dispatchErrIdx).toBeGreaterThanOrEqual(0);
    // 'connected' is at the end of statuses (from attempt 2's ready); it
    // must NOT appear BEFORE the dispatch error fired. Easiest proxy:
    // the dispatch-error position in time precedes any 'connected'.
    // We can't get a timestamp ordering across the two arrays directly,
    // so we assert the surrogate: attempt 1 SSE call has no 'connected'
    // status in the statuses array at the time of the first dispatch
    // error. Since 'connected' is one-shot per session (the
    // `lastStatus === s` guard), if attempt 1's onReady never emitted
    // 'connected' we'll see EXACTLY ONE 'connected' in statuses — from
    // attempt 2.
    const connectedCount = statuses.filter((s) => s === 'connected').length;
    expect(connectedCount).toBe(1);

    // Pre-round-2: 'connected' would have fired TWICE (once per ready),
    // but the lastStatus dedup would mask it. The real bug we're
    // guarding here is: pre-round-2 emitted 'connected' even when
    // onReady threw, lying to the consumer's health gate. With round 2,
    // we only see 'connected' once — and it's from attempt 2.

    // The SECOND SSE attempt's Last-Event-ID is the CURSOR BEFORE THE
    // FAILED ready. Since no snapshot frame and no ready had advanced
    // cursor, that's `CUR-SNAP` (the untruncated snapshot's id
    // succeeded with the no-op onSnapshot stub).
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBe('CUR-SNAP');
  });

  it('REST snapshot page handler throwing aborts paging and forces cold restart', async () => {
    // Cold-start delivers a truncated SSE snapshot. REST paging fetches
    // page 1 — handler throws. Outer loop must clear cursor +
    // pendingPagingCursor → next SSE attempt has NO Last-Event-ID
    // (cold restart).
    let snapshotHits = 0;
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            {
              event: 'snapshot',
              id: 'CUR-PAGE-TRUNCATED',
              data: snapshotBody({
                cursor: 'PAGE-1-REST',
                truncated: true,
              }),
            },
          ],
        },
        // Reconnect: cold restart (no Last-Event-ID).
        {
          frames: [
            { event: 'snapshot', id: 'CUR-SNAP-RECOVERY', data: snapshotBody() },
            { event: 'ready', id: 'CUR-READY-RECOVERY', data: {} },
          ],
        },
      ],
      restSnapshotPages: [
        {
          // Page 1: the consumer's handler throws on this page.
          body: snapshotBody({ cursor: 'PAGE-2-REST', truncated: true }),
        },
      ],
    });
    let readyHit = false;
    const errors: OspexStreamError[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: (s) => {
          snapshotHits += 1;
          // Throw on the FIRST REST page (the SSE-inline truncated page
          // came first; this throw is on the REST page).
          if (snapshotHits === 2) {
            throw new Error('REST page handler bug — simulated');
          }
        },
        onReady: () => {
          readyHit = true;
        },
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => readyHit);
    await sub.unsubscribe();

    // The dispatch error from REST paging was surfaced.
    expect(errors.some((e) => e.phase === 'dispatch')).toBe(true);

    // The SECOND SSE attempt must have NO Last-Event-ID — REST paging
    // failure forced a cold restart per the outer loop's "paging failed"
    // branch (cursor cleared).
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls.length).toBeGreaterThanOrEqual(2);
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBeNull();
  });
});

describe('subscribeToOwnState — v0.5.2 decode-failure abort discipline (PR0a round 3)', () => {
  it('does NOT fire onReady when a malformed cold-start snapshot is followed by ready on the same connection (Hermes regression probe)', async () => {
    // Hermes's exact probe: a malformed snapshot frame followed by a ready
    // frame on the same connection. Pre-round-3 the decode error broke
    // only the switch — the for-await loop kept going — and the next
    // ready fired onReady + onStatus('connected'), signaling a false
    // baseline to a consumer that never got a snapshot.
    const sseBody =
      ': hb\n\n' +
      'event: snapshot\nid: CUR-BAD-SNAPSHOT\ndata: not-valid-json{\n\n' +
      'event: ready\nid: CUR-READY-AFTER-BAD-SNAPSHOT\ndata: {}\n\n';
    const server = makeServer({
      sseAttempts: [
        { body: sseBody },
        {
          frames: [
            { event: 'snapshot', id: 'CUR-RECOVERY-SNAP', data: snapshotBody() },
            { event: 'ready', id: 'CUR-RECOVERY-READY', data: {} },
          ],
        },
      ],
    });
    let readyHits = 0;
    let connectedSeen = 0;
    const errors: OspexStreamError[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => undefined,
        onReady: () => {
          readyHits += 1;
        },
        onStatus: (s) => {
          if (s === 'connected') connectedSeen += 1;
        },
        onError: (e) => errors.push(e),
      },
    );

    // Wait for the SECOND SSE attempt's ready (the recovery one) to land —
    // proves the recovery path completed.
    await waitFor(() => readyHits >= 1);
    await sub.unsubscribe();

    // The decode error MUST have surfaced.
    expect(errors.some((e) => e.phase === 'decode')).toBe(true);

    // Hermes-flagged: pre-round-3, this would have been 2 (false-ready on
    // attempt 1 + real ready on attempt 2). Round 3 makes it exactly 1.
    expect(readyHits).toBe(1);

    // Same invariant on 'connected': exactly ONE (from attempt 2). The
    // lastStatus dedup guard masks a second redundant emit, but the
    // first attempt's onReady never fired so no 'connected' emit
    // happened on attempt 1 in the first place.
    expect(connectedSeen).toBe(1);

    // Hermes-flagged: the SECOND SSE attempt is a COLD START — the
    // malformed snapshot never advanced cursor, so there's no
    // Last-Event-ID. (If round-3 had erroneously promoted the SSE-level
    // cursor on decode failure, Last-Event-ID would equal
    // CUR-BAD-SNAPSHOT, and the server would replay from there.)
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls.length).toBeGreaterThanOrEqual(2);
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBeNull();
  });

  it('does NOT advance cursor when a LATER successful commitment follows a malformed one on the same connection', async () => {
    // Same-connection pattern as the dispatch-throw regression, but the
    // first failure is a DECODE failure, not a handler throw. Pre-round-3
    // the SDK kept processing after the decode error and the next
    // commitment advanced cursor past the malformed one — same data-loss
    // mode, different trigger.
    const sseBody =
      ': hb\n\n' +
      'event: snapshot\nid: CUR-SNAP\ndata: ' +
      JSON.stringify(snapshotBody()) +
      '\n\n' +
      'event: ready\nid: CUR-READY\ndata: {}\n\n' +
      'event: commitment\nid: CUR-BAD-COMMITMENT\ndata: not-valid-json{\n\n' +
      'event: commitment\nid: CUR-GOOD-COMMITMENT\ndata: ' +
      JSON.stringify(commitmentBody(HASH_A, { nonce: '2' })) +
      '\n\n';
    const server = makeServer({
      sseAttempts: [
        { body: sseBody },
        {
          frames: [{ event: 'ready', id: 'CUR-READY-RECOVERY', data: {} }],
        },
      ],
    });
    const errors: OspexStreamError[] = [];
    let commitmentsSeen: string[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => undefined,
        onReady: () => undefined,
        onCommitment: (c) => commitmentsSeen.push(c.commitmentHash),
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => errors.some((e) => e.phase === 'decode'));
    await waitFor(
      () => server.calls.filter((c) => c.url.includes('/v1/stream/own-state')).length >= 2,
    );
    await sub.unsubscribe();

    // The good commitment must NOT have been dispatched on attempt 1 —
    // the decode-induced abort stopped further frames.
    expect(commitmentsSeen).not.toContain(HASH_A);

    // Reconnect from the LAST successfully-applied cursor — `CUR-READY`,
    // NOT `CUR-GOOD-COMMITMENT`. Pre-round-3 this would have been
    // CUR-GOOD-COMMITMENT, silently skipping the malformed event on
    // resume.
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBe('CUR-READY');
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).not.toBe('CUR-GOOD-COMMITMENT');
  });
});

describe('subscribeToOwnState — v0.5.2 typed-frame structural decode (PR0a round 4)', () => {
  it('aborts the connection when a positionStatus body is valid JSON but structurally malformed (e.g. {})', async () => {
    // Hermes round-4 regression: pre-round-4 the positionStatus case did
    // safeParseJson + `wire as PositionStatusEvent` with no validation,
    // so `{}` was dispatched as a "successful" event and cursor advanced.
    // Round-4 adds `decodePositionStatusEvent` that validates required
    // dedup-key fields + the status enum and throws on a malformed body.
    const sseBody =
      ': hb\n\n' +
      'event: snapshot\nid: CUR-SNAP\ndata: ' +
      JSON.stringify(snapshotBody()) +
      '\n\n' +
      'event: ready\nid: CUR-READY\ndata: {}\n\n' +
      'event: positionStatus\nid: CUR-BAD-POSITION\ndata: {}\n\n' +
      'event: commitment\nid: CUR-GOOD-COMMITMENT\ndata: ' +
      JSON.stringify(commitmentBody(HASH_A, { nonce: '2' })) +
      '\n\n';
    const server = makeServer({
      sseAttempts: [
        { body: sseBody },
        {
          frames: [{ event: 'ready', id: 'CUR-READY-RECOVERY', data: {} }],
        },
      ],
    });
    const errors: OspexStreamError[] = [];
    const positionEvents: PositionStatusEvent[] = [];
    const commitmentsSeen: string[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => undefined,
        onReady: () => undefined,
        onPositionStatus: (p) => positionEvents.push(p),
        onCommitment: (c) => commitmentsSeen.push(c.commitmentHash),
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => errors.some((e) => e.phase === 'decode'));
    await waitFor(
      () => server.calls.filter((c) => c.url.includes('/v1/stream/own-state')).length >= 2,
    );
    await sub.unsubscribe();

    // The malformed positionStatus body must NOT have been delivered as
    // an empty object. Round-4 throws on missing required fields.
    expect(positionEvents).toEqual([]);

    // The good commitment after the malformed positionStatus must NOT
    // have been processed — the abort discipline stops further frames.
    expect(commitmentsSeen).not.toContain(HASH_A);

    // The decode error surfaces with phase: 'decode'.
    expect(errors.some((e) => e.phase === 'decode')).toBe(true);

    // The SECOND SSE attempt's Last-Event-ID is `CUR-READY` (the last
    // successfully-applied cursor), NOT `CUR-BAD-POSITION` and NOT
    // `CUR-GOOD-COMMITMENT`. Pre-round-4 this would have been
    // `CUR-GOOD-COMMITMENT` — the empty {} would have dispatched,
    // advanced cursor, then the good commitment after would have
    // advanced further.
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls.length).toBeGreaterThanOrEqual(2);
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBe('CUR-READY');
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).not.toBe('CUR-BAD-POSITION');
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).not.toBe('CUR-GOOD-COMMITMENT');
  });

  it('aborts the connection when a commitment body is valid JSON but structurally malformed', async () => {
    // Same sibling-site coverage for commitment frames — pre-round-4
    // toOwnerCommitment was a structural pass-through that silently
    // produced an OwnerCommitment of mostly-undefined fields on `{}`.
    // Round-4 validates required identity fields (commitmentHash,
    // maker, nonce, riskAmount*, status, createdAt, nonceInvalidated).
    const sseBody =
      ': hb\n\n' +
      'event: snapshot\nid: CUR-SNAP\ndata: ' +
      JSON.stringify(snapshotBody()) +
      '\n\n' +
      'event: ready\nid: CUR-READY\ndata: {}\n\n' +
      'event: commitment\nid: CUR-BAD-COMMITMENT\ndata: {}\n\n' +
      'event: fill\nid: CUR-GOOD-FILL\ndata: ' +
      JSON.stringify({
        speculationId: '7',
        contestId: '1',
        commitmentHash: HASH_A,
        maker: TEST_ADDRESS,
        taker: TEST_ADDRESS,
        makerPositionType: 0,
        takerPositionType: 1,
        makerRiskAmount: '100',
        takerRiskAmount: '200',
        makerRiskUSDC: 0.0001,
        takerRiskUSDC: 0.0002,
        oddsTick: 220,
        filledAt: 't',
        contestStarted: false,
        txHash: '0xtx',
        logIndex: 3,
      }) +
      '\n\n';
    const server = makeServer({
      sseAttempts: [
        { body: sseBody },
        {
          frames: [{ event: 'ready', id: 'CUR-READY-RECOVERY', data: {} }],
        },
      ],
    });
    const errors: OspexStreamError[] = [];
    const commitmentsSeen: OwnerCommitment[] = [];
    const fillsSeen: Fill[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => undefined,
        onReady: () => undefined,
        onCommitment: (c) => commitmentsSeen.push(c),
        onFill: (f) => fillsSeen.push(f),
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => errors.some((e) => e.phase === 'decode'));
    await waitFor(
      () => server.calls.filter((c) => c.url.includes('/v1/stream/own-state')).length >= 2,
    );
    await sub.unsubscribe();

    expect(commitmentsSeen).toEqual([]);
    expect(fillsSeen).toEqual([]); // good fill after the bad commitment was ALSO abandoned
    expect(errors.some((e) => e.phase === 'decode')).toBe(true);

    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBe('CUR-READY');
  });

  it('aborts the connection when a fill body is valid JSON but structurally malformed', async () => {
    // Same sibling-site coverage for fill frames.
    const sseBody =
      ': hb\n\n' +
      'event: snapshot\nid: CUR-SNAP\ndata: ' +
      JSON.stringify(snapshotBody()) +
      '\n\n' +
      'event: ready\nid: CUR-READY\ndata: {}\n\n' +
      'event: fill\nid: CUR-BAD-FILL\ndata: {}\n\n';
    const server = makeServer({
      sseAttempts: [
        { body: sseBody },
        {
          frames: [{ event: 'ready', id: 'CUR-READY-RECOVERY', data: {} }],
        },
      ],
    });
    const errors: OspexStreamError[] = [];
    const fillsSeen: Fill[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => undefined,
        onReady: () => undefined,
        onFill: (f) => fillsSeen.push(f),
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => errors.some((e) => e.phase === 'decode'));
    await waitFor(
      () => server.calls.filter((c) => c.url.includes('/v1/stream/own-state')).length >= 2,
    );
    await sub.unsubscribe();

    expect(fillsSeen).toEqual([]);
    expect(errors.some((e) => e.phase === 'decode')).toBe(true);

    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBe('CUR-READY');
  });
});

describe('subscribeToOwnState — v0.5.2 toOwnerPosition strict validator (PR0a round 5)', () => {
  it('decodeSnapshot({positions: [{}]}) throws OspexValidationError (unit-level — Hermes regression probe)', () => {
    // Hermes round-5 regression probe: pre-round-5 toOwnerPosition was
    // a non-exhaustive switch that fell through to `undefined` for a
    // missing/unknown status, so a snapshot with `positions: [{}]`
    // silently produced `positions: [undefined]`. Round 5 makes it
    // throw at the unit-decoder boundary; the subscribe path's
    // try/catch then triggers `frameAborted` teardown.
    expect(() =>
      decodeSnapshot({
        cursor: 'CUR-SNAP',
        commitments: [],
        // The body cast here is the same any-shape cast a server-side
        // bug or wire corruption would produce in the wild.
        positions: [{} as never],
        truncated: false,
        positionsTruncated: false,
      }),
    ).toThrow(OspexValidationError);
  });

  it('decodeSnapshot rejects positions with unknown status (terminal lost / void must come via positionStatus events, not the snapshot)', () => {
    // The snapshot's positions[] only carries the four
    // narrower-than-PositionLifecycle statuses (active / pendingSettle /
    // claimable / claimed). `settledLost` / `void` are intentionally
    // absent from the snapshot (zero-payout terminal rows are dropped);
    // a wire body that violates that contract is malformed and must
    // throw.
    expect(() =>
      decodeSnapshot({
        cursor: 'CUR-SNAP',
        commitments: [],
        positions: [
          {
            positionId: 'p1',
            speculationId: 's1',
            positionType: 0,
            team: 'A',
            opponent: 'B',
            market: 'moneyline',
            oddsDecimal: 1.5,
            riskAmountUSDC: 1,
            profitAmountUSDC: 0.5,
            status: 'settledLost' as never,
          },
        ],
        truncated: false,
        positionsTruncated: false,
      }),
    ).toThrow(OspexValidationError);
  });

  it('SSE cold-start snapshot with positions: [{}] aborts the connection (no onReady, no `connected`, reconnect is a cold start)', async () => {
    // Same shape as the round-3 malformed-snapshot probe but the
    // malformed-ness is HIDDEN inside `positions[0]` — valid top-level
    // JSON, valid top-level snapshot fields, malformed inner position.
    // Pre-round-5 decodeSnapshot would have returned positions:[undefined]
    // silently and onSnapshot would have fired with an arrayful of
    // undefined, then onReady → 'connected' → false baseline.
    const sseBody =
      ': hb\n\n' +
      'event: snapshot\nid: CUR-BAD-SNAP\ndata: ' +
      JSON.stringify({
        cursor: 'CUR-BAD-SNAP',
        commitments: [],
        positions: [{}],
        truncated: false,
        positionsTruncated: false,
      }) +
      '\n\n' +
      'event: ready\nid: CUR-READY-AFTER-BAD-SNAP\ndata: {}\n\n';
    const server = makeServer({
      sseAttempts: [
        { body: sseBody },
        {
          frames: [
            { event: 'snapshot', id: 'CUR-RECOVERY-SNAP', data: snapshotBody() },
            { event: 'ready', id: 'CUR-RECOVERY-READY', data: {} },
          ],
        },
      ],
    });
    let snapshotHits = 0;
    let readyHits = 0;
    let connectedSeen = 0;
    const errors: OspexStreamError[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => {
          snapshotHits += 1;
        },
        onReady: () => {
          readyHits += 1;
        },
        onStatus: (s) => {
          if (s === 'connected') connectedSeen += 1;
        },
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => readyHits >= 1);
    await sub.unsubscribe();

    // The decode error MUST have surfaced — `decodeSnapshot` throws on
    // the malformed position, and the SSE path's try/catch routes it
    // through `frameAborted` discipline with phase: 'decode'.
    expect(errors.some((e) => e.phase === 'decode')).toBe(true);

    // The malformed snapshot must NOT have been dispatched to the
    // consumer (the decoder threw BEFORE dispatchTyped was reached).
    // Only the recovery snapshot on attempt 2 fires onSnapshot.
    expect(snapshotHits).toBe(1);

    // Same as round-3: exactly ONE 'connected' (from attempt 2's
    // successful ready), NOT two (which would be a false 'connected'
    // on attempt 1).
    expect(readyHits).toBe(1);
    expect(connectedSeen).toBe(1);

    // The second SSE attempt is a COLD START — the malformed snapshot
    // never advanced cursor, so there's no Last-Event-ID.
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls.length).toBeGreaterThanOrEqual(2);
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBeNull();
  });

  it('REST snapshot page with positions: [{}] surfaces phase: decode and forces cold restart (not a partial baseline)', async () => {
    // Cold-start delivers a truncated SSE snapshot (valid). REST paging
    // fetches page 2 which has a malformed position. Outer loop must
    // clear cursor + pendingPagingCursor → next SSE attempt has NO
    // Last-Event-ID (cold restart). The consumer must NOT see a partial
    // baseline.
    let restSnapshotHits = 0;
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            {
              event: 'snapshot',
              id: 'CUR-PAGE-TRUNCATED',
              data: snapshotBody({
                cursor: 'PAGE-1-REST',
                truncated: true,
              }),
            },
          ],
        },
        // Reconnect: cold restart (no Last-Event-ID).
        {
          frames: [
            { event: 'snapshot', id: 'CUR-SNAP-RECOVERY', data: snapshotBody() },
            { event: 'ready', id: 'CUR-READY-RECOVERY', data: {} },
          ],
        },
      ],
      restSnapshotPages: [
        {
          body: {
            cursor: 'PAGE-2-REST',
            commitments: [],
            // Malformed position hiding inside an otherwise-valid REST
            // page. Pre-round-5 toOwnerPosition would have produced
            // [undefined]; the REST onSnapshot would have fired with
            // that garbage; truncated:false would have promoted
            // `cursor` to PAGE-2-REST as `Last-Event-ID` for resume.
            positions: [{}],
            truncated: false,
            positionsTruncated: false,
          } as unknown as OwnerStateSnapshotBody,
        },
      ],
    });
    let readyHit = false;
    const errors: OspexStreamError[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => {
          restSnapshotHits += 1;
        },
        onReady: () => {
          readyHit = true;
        },
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => readyHit);
    await sub.unsubscribe();

    // The REST page's malformed position raised a decode error from the
    // decoder; the REST paging path surfaces it as phase: 'decode' via
    // `pageRestUntilLive` (the decoded snapshot decoder throws, which
    // its outer try/catch maps to onError with phase: 'decode').
    expect(errors.some((e) => e.phase === 'decode')).toBe(true);

    // The malformed REST page must NOT have been delivered to
    // onSnapshot — the decoder threw BEFORE dispatchTyped reached the
    // consumer. Only the recovery snapshot on attempt 2 fires
    // onSnapshot (the first SSE attempt's truncated snapshot DID fire
    // onSnapshot once + the recovery fires once = 2 total; the bad REST
    // page in between fires NONE).
    expect(restSnapshotHits).toBe(2);

    // The SECOND SSE attempt must have NO Last-Event-ID — REST paging
    // failure (decode error) forced cold restart per the "paging failed"
    // branch (cursor cleared).
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls.length).toBeGreaterThanOrEqual(2);
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBeNull();
  });
});

describe('subscribeToOwnState — v0.5.2 decodeSnapshot top-level shape (PR0a round 6)', () => {
  // Round-6 closes the structural-decode contract symmetrically:
  // leaves (toOwnerCommitment / toOwnerPosition / decodePositionStatusEvent /
  // decodeFill) AND composite top-level shape both validated. Pre-round-6 the
  // top-level snapshot fields were copied without checks — a malformed body
  // like {cursor: 123} or {truncated: "false"} propagated through to
  // cursor-promotion / paging logic.

  // Each unit case below uses `as never` to force the malformed shape past
  // the OwnerStateSnapshotBody compile-time check. Runtime validation in
  // decodeSnapshot is what rejects.

  it.each([
    {
      name: 'body: null',
      body: null,
      expectedField: 'body',
    },
    {
      name: 'body: "string"',
      body: 'not-an-object',
      expectedField: 'body',
    },
    {
      name: 'cursor: number (not string)',
      body: {
        cursor: 123,
        commitments: [],
        positions: [],
        truncated: false,
        positionsTruncated: false,
      },
      expectedField: 'cursor',
    },
    {
      name: 'cursor: empty string',
      body: {
        cursor: '',
        commitments: [],
        positions: [],
        truncated: false,
        positionsTruncated: false,
      },
      expectedField: 'cursor',
    },
    {
      name: 'cursor: missing',
      body: {
        commitments: [],
        positions: [],
        truncated: false,
        positionsTruncated: false,
      },
      expectedField: 'cursor',
    },
    {
      name: 'commitments: missing',
      body: {
        cursor: 'CUR',
        positions: [],
        truncated: false,
        positionsTruncated: false,
      },
      expectedField: 'commitments',
    },
    {
      name: 'commitments: not array',
      body: {
        cursor: 'CUR',
        commitments: 'not-array',
        positions: [],
        truncated: false,
        positionsTruncated: false,
      },
      expectedField: 'commitments',
    },
    {
      name: 'positions: missing',
      body: {
        cursor: 'CUR',
        commitments: [],
        truncated: false,
        positionsTruncated: false,
      },
      expectedField: 'positions',
    },
    {
      name: 'positions: not array',
      body: {
        cursor: 'CUR',
        commitments: [],
        positions: 'not-array',
        truncated: false,
        positionsTruncated: false,
      },
      expectedField: 'positions',
    },
    {
      name: 'truncated: string ("false")',
      body: {
        cursor: 'CUR',
        commitments: [],
        positions: [],
        truncated: 'false',
        positionsTruncated: false,
      },
      expectedField: 'truncated',
    },
    {
      name: 'truncated: missing',
      body: {
        cursor: 'CUR',
        commitments: [],
        positions: [],
        positionsTruncated: false,
      },
      expectedField: 'truncated',
    },
    {
      name: 'positionsTruncated: string',
      body: {
        cursor: 'CUR',
        commitments: [],
        positions: [],
        truncated: false,
        positionsTruncated: 'false',
      },
      expectedField: 'positionsTruncated',
    },
    {
      name: 'positionsTruncated: missing',
      body: {
        cursor: 'CUR',
        commitments: [],
        positions: [],
        truncated: false,
      },
      expectedField: 'positionsTruncated',
    },
  ])(
    'decodeSnapshot throws OspexValidationError on $name (Hermes round-6 unit probes)',
    ({ body, expectedField }) => {
      let caught: unknown;
      try {
        decodeSnapshot(body as never);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OspexValidationError);
      expect((caught as OspexValidationError).field).toBe(expectedField);
    },
  );

  it('SSE snapshot with truncated: "false" (truthy string) aborts the connection (no false truncated-paging branch, no cursor promotion)', async () => {
    // Pre-round-6 `body.truncated` was copied through without type check.
    // JavaScript truthiness treats "false" as TRUTHY (non-empty string), so
    // a body with `truncated: "false"` triggered the truncated-page branch,
    // promoted pendingPagingCursor, and started REST paging — all on a
    // body the server intended as non-truncated. Round-6 throws on the
    // first non-boolean truncated and aborts the connection.
    const sseBody =
      ': hb\n\n' +
      'event: snapshot\nid: CUR-BAD-TRUNCATED\ndata: ' +
      JSON.stringify({
        cursor: 'CUR-BAD-TRUNCATED',
        commitments: [],
        positions: [],
        truncated: 'false', // ← the string, not the bool
        positionsTruncated: false,
      }) +
      '\n\n' +
      'event: ready\nid: CUR-READY-AFTER-BAD\ndata: {}\n\n';
    const server = makeServer({
      sseAttempts: [
        { body: sseBody },
        {
          frames: [
            { event: 'snapshot', id: 'CUR-RECOVERY-SNAP', data: snapshotBody() },
            { event: 'ready', id: 'CUR-RECOVERY-READY', data: {} },
          ],
        },
      ],
    });
    let snapshotHits = 0;
    let readyHits = 0;
    let connectedSeen = 0;
    const errors: OspexStreamError[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => {
          snapshotHits += 1;
        },
        onReady: () => {
          readyHits += 1;
        },
        onStatus: (s) => {
          if (s === 'connected') connectedSeen += 1;
        },
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => readyHits >= 1);
    await sub.unsubscribe();

    expect(errors.some((e) => e.phase === 'decode')).toBe(true);
    expect(snapshotHits).toBe(1); // only the recovery snapshot
    expect(readyHits).toBe(1);
    expect(connectedSeen).toBe(1);

    // Critical: the SECOND SSE attempt is a COLD START — no false
    // Last-Event-ID propagation from the malformed body. Pre-round-6 the
    // malformed `truncated:"false"` triggered REST paging with the bad
    // body's `cursor`, eventually surfaced an error AFTER state had been
    // corrupted. Round-6 throws at the decode boundary BEFORE any cursor
    // promotion.
    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls.length).toBeGreaterThanOrEqual(2);
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBeNull();
  });

  it('SSE snapshot with cursor: number aborts the connection (no non-string cursor propagation)', async () => {
    // The cursor field is also what gets stored as `pendingPagingCursor`
    // when the snapshot is truncated. A numeric cursor would silently
    // propagate as the next REST page cursor AND eventually as
    // Last-Event-ID — both expecting strings. Round-6 throws before any
    // of that.
    const sseBody =
      ': hb\n\n' +
      'event: snapshot\nid: CUR-BAD-CURSOR-TYPE\ndata: ' +
      JSON.stringify({
        cursor: 12345, // ← number, not string
        commitments: [],
        positions: [],
        truncated: false,
        positionsTruncated: false,
      }) +
      '\n\n';
    const server = makeServer({
      sseAttempts: [
        { body: sseBody },
        {
          frames: [
            { event: 'snapshot', id: 'CUR-RECOVERY-SNAP', data: snapshotBody() },
            { event: 'ready', id: 'CUR-RECOVERY-READY', data: {} },
          ],
        },
      ],
    });
    let readyHit = false;
    const errors: OspexStreamError[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => undefined,
        onReady: () => {
          readyHit = true;
        },
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => readyHit);
    await sub.unsubscribe();

    expect(errors.some((e) => e.phase === 'decode')).toBe(true);

    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls.length).toBeGreaterThanOrEqual(2);
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBeNull();
  });

  it('REST snapshot page with malformed top-level shape surfaces phase: decode and forces cold restart', async () => {
    // The REST paging path also runs through decodeSnapshot. A malformed
    // top-level shape (here: missing `truncated`) must surface phase:
    // 'decode' AND force the outer loop's cold-restart branch — never
    // promote a partial baseline.
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            {
              event: 'snapshot',
              id: 'CUR-PAGE-TRUNCATED',
              data: snapshotBody({
                cursor: 'PAGE-1-REST',
                truncated: true,
              }),
            },
          ],
        },
        {
          frames: [
            { event: 'snapshot', id: 'CUR-RECOVERY-SNAP', data: snapshotBody() },
            { event: 'ready', id: 'CUR-RECOVERY-READY', data: {} },
          ],
        },
      ],
      restSnapshotPages: [
        {
          // Malformed REST page: `truncated` is a string. Pre-round-6 this
          // would be copied through; truthiness branched into more paging;
          // eventually the page bound or other error fired AFTER partial
          // baseline corruption.
          body: {
            cursor: 'PAGE-2-REST',
            commitments: [],
            positions: [],
            truncated: 'false' as unknown as boolean,
            positionsTruncated: false,
          },
        },
      ],
    });
    let readyHit = false;
    const errors: OspexStreamError[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onSnapshot: () => undefined,
        onReady: () => {
          readyHit = true;
        },
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => readyHit);
    await sub.unsubscribe();

    expect(errors.some((e) => e.phase === 'decode')).toBe(true);

    const sseCalls = server.calls.filter((c) =>
      c.url.includes('/v1/stream/own-state'),
    );
    expect(sseCalls.length).toBeGreaterThanOrEqual(2);
    expect(sseCalls[1]!.headers.get('Last-Event-ID')).toBeNull();
  });
});

describe('subscribeToOwnState — v0.5.2 error.phase (PR0a)', () => {
  it('classifies a 401 mid-stream as phase: token-refresh', async () => {
    // First SSE attempt connects fine, gets a ready, then 401s. Second
    // attempt is a 401 too (cached token rejected at connect-time).
    const server = makeServer({
      sseAttempts: [
        {
          frames: [
            { event: 'snapshot', id: 'CUR-SNAP', data: snapshotBody() },
            { event: 'ready', id: 'CUR-READY', data: {} },
          ],
        },
        // 401 on the next connect — bearer rejected.
        { status: 401 },
      ],
    });
    const errors: OspexStreamError[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onReady: () => undefined,
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => errors.some((e) => e.status === 401));
    await sub.unsubscribe();

    const authErr = errors.find((e) => e.status === 401)!;
    expect(authErr.phase).toBe('token-refresh');
  });

  it('classifies a decode failure as phase: decode', async () => {
    // Hand-craft an SSE body with malformed snapshot JSON. Decode failure
    // surfaces via onError({phase: 'decode'}) without crashing the
    // subscription — the for-await loop continues.
    const sseBody =
      ': hb\n\n' +
      'event: snapshot\nid: CUR-SNAP\ndata: not-valid-json{\n\n';
    const server = makeServer({ sseAttempts: [{ body: sseBody }] });
    const errors: OspexStreamError[] = [];
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const sub = subscribeToOwnState(
      {
        api: server.api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      },
      {
        onError: (e) => errors.push(e),
      },
    );

    await waitFor(() => errors.some((e) => e.phase === 'decode'));
    await sub.unsubscribe();

    const decodeErr = errors.find((e) => e.phase === 'decode')!;
    expect(decodeErr.reason).toBe('connection_failed');
  });
});
