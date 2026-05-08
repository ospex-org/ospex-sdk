/**
 * Tests for the TeamsApi pagination + Teams cache wrapper.
 *
 * Pagination: must walk pages until hasMore=false, otherwise the
 * 1000-row PostgREST default would silently truncate the ~1300+ rows.
 *
 * Cache: 5-minute TTL keyed on the optional sport filter so each
 * sport-scope is cached independently. `bypassCache: true` forces a
 * fresh fetch and updates the cache.
 */

import { describe, expect, it, vi } from 'vitest';
import { OspexClient } from '../src/index.js';

interface CapturedRequest {
  url: string;
}

function makeFetch(
  responder: (req: CapturedRequest, callIndex: number) => { status: number; body: unknown },
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const idx = calls.length;
    calls.push({ url });
    const { status, body } = responder({ url }, idx);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch: fetchImpl, calls };
}

const apiUrl = 'https://api.example.test';

const PAGE_BODY = (
  rows: Array<{ teamId: string; alias: string; aliasType: string }>,
  hasMore: boolean,
  total: number,
  offset: number,
): unknown => ({
  aliases: rows.map((r) => ({
    teamId: r.teamId,
    sport: 'nba',
    sportId: 1,
    teamName: 'Team',
    abbrev: 'TEAM',
    alias: r.alias,
    aliasType: r.aliasType,
    source: 'manual',
  })),
  pagination: { limit: 2000, offset, total, hasMore },
});

describe('client.teams.aliases — pagination', () => {
  it('walks all pages until hasMore=false', async () => {
    const { fetch, calls } = makeFetch((_, idx) => {
      if (idx === 0) {
        return {
          status: 200,
          body: PAGE_BODY(
            [
              { teamId: 't1', alias: 'A1', aliasType: 'short' },
              { teamId: 't2', alias: 'A2', aliasType: 'abbreviation' },
            ],
            true,
            3,
            0,
          ),
        };
      }
      return {
        status: 200,
        body: PAGE_BODY([{ teamId: 't3', alias: 'A3', aliasType: 'full' }], false, 3, 2),
      };
    });

    const client = new OspexClient({ apiUrl, fetch });
    const aliases = await client.teams.aliases();
    expect(aliases).toHaveLength(3);
    expect(aliases.map((a) => a.alias)).toEqual(['A1', 'A2', 'A3']);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('offset=0');
    expect(calls[1]?.url).toContain('offset=2');
  });

  it('passes sport filter as a query param', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: PAGE_BODY([], false, 0, 0),
    }));
    const client = new OspexClient({ apiUrl, fetch });
    await client.teams.aliases({ sport: 'mlb' });
    expect(calls[0]?.url).toContain('sport=mlb');
  });

  it('breaks safely if server returns hasMore=true with empty page', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: PAGE_BODY([], true, 100, 0),
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const aliases = await client.teams.aliases();
    expect(aliases).toHaveLength(0);
    // Defensive break — exactly one page fetched, no infinite loop.
    expect(calls).toHaveLength(1);
  });
});

describe('client.teams.aliases — caching', () => {
  it('caches by sport key; second call within TTL does not refetch', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: PAGE_BODY([{ teamId: 't1', alias: 'A1', aliasType: 'short' }], false, 1, 0),
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const a = await client.teams.aliases({ sport: 'nba' });
    const b = await client.teams.aliases({ sport: 'nba' });
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it('different sport keys are cached independently', async () => {
    const { fetch, calls } = makeFetch(({ url }) => {
      const sport = new URL(url).searchParams.get('sport') ?? '(none)';
      return {
        status: 200,
        body: PAGE_BODY(
          [{ teamId: `${sport}-team`, alias: sport, aliasType: 'short' }],
          false,
          1,
          0,
        ),
      };
    });
    const client = new OspexClient({ apiUrl, fetch });
    const nba = await client.teams.aliases({ sport: 'nba' });
    const mlb = await client.teams.aliases({ sport: 'mlb' });
    expect(nba[0]?.teamId).toBe('nba-team');
    expect(mlb[0]?.teamId).toBe('mlb-team');
    expect(calls).toHaveLength(2);
  });

  it('bypassCache=true forces a fresh fetch and updates the cache', async () => {
    let counter = 0;
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: PAGE_BODY(
        [{ teamId: `t${counter++}`, alias: 'A', aliasType: 'short' }],
        false,
        1,
        0,
      ),
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const first = await client.teams.aliases({ sport: 'nba' });
    const second = await client.teams.aliases({ sport: 'nba', bypassCache: true });
    expect(first[0]?.teamId).toBe('t0');
    expect(second[0]?.teamId).toBe('t1');
    // Subsequent non-bypass call uses the freshly-cached entry.
    const third = await client.teams.aliases({ sport: 'nba' });
    expect(third[0]?.teamId).toBe('t1');
    expect(calls).toHaveLength(2);
  });

  it('TTL expiry refetches after 5 minutes', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: PAGE_BODY([{ teamId: 't1', alias: 'A', aliasType: 'short' }], false, 1, 0),
    }));
    const client = new OspexClient({ apiUrl, fetch });
    await client.teams.aliases({ sport: 'nba' });
    expect(calls).toHaveLength(1);
    // Within TTL — cache hit.
    vi.advanceTimersByTime(4 * 60 * 1000);
    await client.teams.aliases({ sport: 'nba' });
    expect(calls).toHaveLength(1);
    // Beyond TTL — refetch.
    vi.advanceTimersByTime(2 * 60 * 1000);
    await client.teams.aliases({ sport: 'nba' });
    expect(calls).toHaveLength(2);
    vi.useRealTimers();
  });
});
