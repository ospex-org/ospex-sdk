/**
 * `client.ownState.health()` / `loadOwnStateHealth` tests (PR0b §3.3 / A4).
 *
 * Covers:
 *   - decode of the indexer-lag probe body into the public OwnStateHealth;
 *   - the call is a PUBLIC GET (no Authorization header — lag is global);
 *   - malformed body → OspexValidationError (zod-wrapped);
 *   - server 503 NOT_READY → OspexAPIError.
 */
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import { loadOwnStateHealth } from '../src/ownState/health.js';
import { OspexAPIError, OspexValidationError } from '../src/errors.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
}

function makeApi(
  responder: () => { status: number; body: unknown },
): { api: ApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fakeFetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
    });
    const r = responder();
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const api = new ApiClient({ apiUrl: 'https://api.test', fetch: fakeFetch });
  return { api, calls };
}

describe('loadOwnStateHealth', () => {
  it('decodes the indexer-lag probe body and hits the public endpoint with no auth header', async () => {
    const { api, calls } = makeApi(() => ({
      status: 200,
      body: {
        indexerLagSeconds: 5,
        lastIndexedAt: '2026-06-01T16:00:00.000Z',
        lagSource: 'indexer_cursor',
      },
    }));

    const health = await loadOwnStateHealth(api);
    expect(health).toEqual({
      indexerLagSeconds: 5,
      lastIndexedAt: '2026-06-01T16:00:00.000Z',
      lagSource: 'indexer_cursor',
    });

    const call = calls.find((c) => c.url.includes('/v1/health/own-state'))!;
    expect(call.method).toBe('GET');
    expect(call.headers.get('Authorization')).toBeNull();
  });

  it('accepts indexerLagSeconds: 0 (perfectly fresh)', async () => {
    const { api } = makeApi(() => ({
      status: 200,
      body: { indexerLagSeconds: 0, lastIndexedAt: '2026-06-01T16:00:00.000Z', lagSource: 'indexer_cursor' },
    }));
    const health = await loadOwnStateHealth(api);
    expect(health.indexerLagSeconds).toBe(0);
  });

  it('throws OspexValidationError on a malformed body (missing indexerLagSeconds)', async () => {
    const { api } = makeApi(() => ({
      status: 200,
      body: { lastIndexedAt: '2026-06-01T16:00:00.000Z', lagSource: 'indexer_cursor' },
    }));
    await expect(loadOwnStateHealth(api)).rejects.toBeInstanceOf(OspexValidationError);
  });

  it('surfaces a 503 NOT_READY as OspexAPIError', async () => {
    const { api } = makeApi(() => ({
      status: 503,
      body: { error: 'Indexer sync state unavailable for this network.', code: 'INDEXER_SYNC_UNAVAILABLE' },
    }));
    await expect(loadOwnStateHealth(api)).rejects.toBeInstanceOf(OspexAPIError);
  });
});
