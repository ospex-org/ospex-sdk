/**
 * Tests for `client.odds.snapshot(contestId)` — the one-shot snapshot
 * read backed by `GET /v1/contests/:contestId/odds`. Uses a mocked
 * fetch (same pattern as api.test.ts) so the test never opens a real
 * socket or talks to Supabase.
 *
 * The endpoint exposes per-market shapes (moneyline / spread / total)
 * rather than a generic `line + away/home` envelope; tests below assert
 * that the SDK preserves those market-specific field names through the
 * client mapping.
 */

import { describe, expect, it } from 'vitest';
import { OspexClient } from '../src/index.js';

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function makeFetch(
  responder: (req: CapturedRequest) => { status: number; body: unknown },
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ url, init });
    const { status, body } = responder({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch: fetchImpl, calls };
}

const apiUrl = 'https://api.example.test';

const TIMESTAMPS = {
  upstreamLastUpdated: '2026-05-08T22:00:00Z',
  pollCapturedAt: '2026-05-08T22:00:30Z',
  changedAt: '2026-05-08T22:00:30Z',
};

describe('client.odds.snapshot', () => {
  it('hits the contest-centric endpoint and decodes per-market shapes', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        contestId: '42',
        jsonoddsId: 'jo-abc-123',
        odds: {
          moneyline: {
            market: 'moneyline',
            awayOddsAmerican: 145,
            homeOddsAmerican: -180,
            ...TIMESTAMPS,
          },
          spread: {
            market: 'spread',
            awayLine: 3.5,
            homeLine: -3.5,
            awayOddsAmerican: -110,
            homeOddsAmerican: -110,
            ...TIMESTAMPS,
          },
          total: {
            market: 'total',
            line: 8.5,
            overOddsAmerican: -105,
            underOddsAmerican: -115,
            ...TIMESTAMPS,
          },
        },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const result = await client.odds.snapshot('42');
    expect(result.contestId).toBe('42');
    expect(result.jsonoddsId).toBe('jo-abc-123');

    // moneyline: per-side odds, no line field.
    expect(result.odds.moneyline?.market).toBe('moneyline');
    expect(result.odds.moneyline?.awayOddsAmerican).toBe(145);
    expect(result.odds.moneyline?.homeOddsAmerican).toBe(-180);
    expect(result.odds.moneyline).not.toHaveProperty('line');

    // spread: both sides labelled, no generic line.
    expect(result.odds.spread?.market).toBe('spread');
    expect(result.odds.spread?.awayLine).toBe(3.5);
    expect(result.odds.spread?.homeLine).toBe(-3.5);
    expect(result.odds.spread?.awayOddsAmerican).toBe(-110);
    expect(result.odds.spread).not.toHaveProperty('line');

    // total: line + over/under (NOT away/home).
    expect(result.odds.total?.market).toBe('total');
    expect(result.odds.total?.line).toBe(8.5);
    expect(result.odds.total?.overOddsAmerican).toBe(-105);
    expect(result.odds.total?.underOddsAmerican).toBe(-115);
    expect(result.odds.total).not.toHaveProperty('awayOddsAmerican');
    expect(result.odds.total).not.toHaveProperty('homeOddsAmerican');

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/contests/42/odds');
  });

  it('preserves null markets when the writer has only populated some', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        contestId: '7',
        jsonoddsId: 'jo-x',
        odds: {
          moneyline: {
            market: 'moneyline',
            awayOddsAmerican: 200,
            homeOddsAmerican: -250,
            ...TIMESTAMPS,
          },
          spread: null,
          total: null,
        },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const result = await client.odds.snapshot('7');
    expect(result.odds.moneyline).not.toBeNull();
    expect(result.odds.spread).toBeNull();
    expect(result.odds.total).toBeNull();
  });

  it('handles all-null markets when contest has no jsonoddsId linkage', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        contestId: '99',
        jsonoddsId: null,
        odds: { moneyline: null, spread: null, total: null },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const result = await client.odds.snapshot('99');
    expect(result.jsonoddsId).toBeNull();
    expect(result.odds.moneyline).toBeNull();
    expect(result.odds.spread).toBeNull();
    expect(result.odds.total).toBeNull();
  });

  it('spread with null homeLine carries null awayLine too (server-side derivation)', async () => {
    // Server fills awayLine = -homeLine; if homeLine is null, awayLine
    // is null too. The SDK passes both through unchanged.
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        contestId: '7',
        jsonoddsId: 'jo-x',
        odds: {
          moneyline: null,
          spread: {
            market: 'spread',
            awayLine: null,
            homeLine: null,
            awayOddsAmerican: -110,
            homeOddsAmerican: -110,
            ...TIMESTAMPS,
          },
          total: null,
        },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const result = await client.odds.snapshot('7');
    expect(result.odds.spread).toMatchObject({
      market: 'spread',
      awayLine: null,
      homeLine: null,
    });
  });

  it('URL-encodes special characters in contestId', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        contestId: '42',
        jsonoddsId: null,
        odds: { moneyline: null, spread: null, total: null },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    // Contest IDs are numeric-strings on chain so this is hypothetical,
    // but verify the encoding step is applied (mirrors `contests.get`).
    await client.odds.snapshot('42 with space');
    expect(calls[0]!.url).toContain('/v1/contests/42%20with%20space/odds');
  });
});
