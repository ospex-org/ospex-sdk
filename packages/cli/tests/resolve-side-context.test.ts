/**
 * Unit tests for the async Team Identity resolvers (lib/resolveSideContext.ts)
 * used by `settle` (`resolveWinSideContext`) and `claim`
 * (`resolvePositionSideContext`). A mock client supplies / fails the
 * `speculations.get` + `odds.snapshot` reads and tracks call counts, so the
 * tests pin: the fetch logic (odds only when a role needs it), independent
 * team-vs-role degradation, the positionType→side mapping, and — critically —
 * that the resolvers NEVER THROW and never block on a fetch failure.
 */

import { describe, expect, it, vi } from 'vitest';
import type { OspexClient } from '@ospex/sdk';
import {
  resolvePositionSideContext,
  resolveWinSideContext,
} from '../src/lib/resolveSideContext.js';

interface SpecLike {
  type: 'moneyline' | 'spread' | 'total';
  contestId: string;
  contest: { awayTeam: string; homeTeam: string };
  awayLine?: number;
  homeLine?: number;
  line: number | null;
}

interface OddsLike {
  moneyline?: { awayOddsAmerican: number | null; homeOddsAmerican: number | null } | null;
  spread?: { awayOddsAmerican: number | null; homeOddsAmerican: number | null } | null;
  total?: { line: number | null } | null;
}

function makeClient(cfg: {
  spec?: SpecLike;
  specThrows?: boolean;
  odds?: OddsLike;
  oddsThrows?: boolean;
}): { client: OspexClient; specCalls: () => number; oddsCalls: () => number } {
  let specCalls = 0;
  let oddsCalls = 0;
  const client = {
    speculations: {
      get: vi.fn(async () => {
        specCalls += 1;
        if (cfg.specThrows) throw new Error('speculations.get failed');
        return cfg.spec;
      }),
    },
    odds: {
      snapshot: vi.fn(async () => {
        oddsCalls += 1;
        if (cfg.oddsThrows) throw new Error('odds.snapshot failed');
        return { contestId: cfg.spec?.contestId ?? '0', odds: cfg.odds ?? {} };
      }),
    },
  } as unknown as OspexClient;
  return { client, specCalls: () => specCalls, oddsCalls: () => oddsCalls };
}

const SPEC_ML: SpecLike = {
  type: 'moneyline',
  contestId: '42',
  contest: { awayTeam: 'New York Yankees', homeTeam: 'Toronto Blue Jays' },
  line: null,
};

describe('resolveWinSideContext (settle)', () => {
  it('moneyline away: speculation + odds → complete favorite, no warning', async () => {
    const { client, specCalls, oddsCalls } = makeClient({
      spec: SPEC_ML,
      odds: { moneyline: { awayOddsAmerican: -150, homeOddsAmerican: 130 } },
    });
    const { context, warning } = await resolveWinSideContext(client, 101n, 'away');
    expect(context.status).toBe('complete');
    expect(context.team).toEqual({ name: 'New York Yankees', alignment: 'away' });
    expect(context.role).toBe('favorite');
    expect(context.display).toBe('away (New York Yankees, favorite)');
    expect(context.source).toEqual({ team: 'speculation-detail', role: 'moneyline-odds' });
    expect(warning).toBeUndefined();
    expect(specCalls()).toBe(1);
    expect(oddsCalls()).toBe(1); // moneyline role needs odds
  });

  it('spread home: role from the line, WITHOUT an odds fetch', async () => {
    const spec: SpecLike = {
      type: 'spread',
      contestId: '7',
      contest: { awayTeam: 'A', homeTeam: 'B' },
      awayLine: 3.5,
      homeLine: -3.5,
      line: null,
    };
    const { client, oddsCalls } = makeClient({ spec });
    const { context, warning } = await resolveWinSideContext(client, 1n, 'home');
    expect(context.status).toBe('complete');
    expect(context.role).toBe('favorite'); // homeLine -3.5
    expect(context.source.role).toBe('spread-line');
    expect(warning).toBeUndefined();
    expect(oddsCalls()).toBe(0); // line present → no odds fetch
  });

  it('spread with no line: falls back to an odds fetch (source spread-odds)', async () => {
    const spec: SpecLike = {
      type: 'spread',
      contestId: '7',
      contest: { awayTeam: 'A', homeTeam: 'B' },
      line: null, // no awayLine/homeLine
    };
    const { client, oddsCalls } = makeClient({
      spec,
      odds: { spread: { awayOddsAmerican: 120, homeOddsAmerican: -140 } },
    });
    const { context } = await resolveWinSideContext(client, 1n, 'home');
    expect(context.role).toBe('favorite'); // home -140
    expect(context.source.role).toBe('spread-odds');
    expect(oddsCalls()).toBe(1);
  });

  it('odds fetch fails but speculation succeeds → partial (team kept, role unknown) + warning', async () => {
    const { client } = makeClient({ spec: SPEC_ML, oddsThrows: true });
    const { context, warning } = await resolveWinSideContext(client, 101n, 'away');
    expect(context.team).toEqual({ name: 'New York Yankees', alignment: 'away' });
    expect(context.role).toBe('unknown');
    expect(context.status).toBe('partial');
    expect(warning?.code).toBe('side-role-unavailable');
    expect(warning?.severity).toBe('warning');
  });

  it('speculations.get fails (team-bearing) → unavailable + warning, NEVER throws', async () => {
    const { client } = makeClient({ specThrows: true });
    const { context, warning } = await resolveWinSideContext(client, 101n, 'away');
    expect(context.team).toBeNull();
    expect(context.status).toBe('unavailable');
    expect(context.display).toBe('away (team unavailable)');
    expect(warning?.code).toBe('side-context-unavailable');
    expect(warning?.severity).toBe('warning');
  });

  it('push: no fetch at all, not_applicable, no warning', async () => {
    const { client, specCalls } = makeClient({ specThrows: true }); // would throw if called
    const { context, warning } = await resolveWinSideContext(client, 101n, 'push');
    expect(context.status).toBe('not_applicable');
    expect(context.display).toBe('push (no winning side)');
    expect(warning).toBeUndefined();
    expect(specCalls()).toBe(0); // short-circuited before any fetch
  });

  it('over (total): line in display, no role, no odds fetch, no warning', async () => {
    const spec: SpecLike = {
      type: 'total',
      contestId: '7',
      contest: { awayTeam: 'A', homeTeam: 'B' },
      line: 8.5,
    };
    const { client, oddsCalls } = makeClient({ spec });
    const { context, warning } = await resolveWinSideContext(client, 1n, 'over');
    expect(context.display).toBe('over 8.5 (total; no team)');
    expect(context.role).toBe('not_applicable');
    expect(context.status).toBe('not_applicable');
    expect(warning).toBeUndefined();
    expect(oddsCalls()).toBe(0);
  });

  it('over (total) when speculations.get fails → degrades without a line, NO warning (no team to miss)', async () => {
    const { client } = makeClient({ specThrows: true });
    const { context, warning } = await resolveWinSideContext(client, 1n, 'over');
    expect(context.display).toBe('over (total; no team)');
    expect(context.status).toBe('not_applicable');
    expect(warning).toBeUndefined();
  });
});

describe('resolvePositionSideContext (claim)', () => {
  it('positionType 0 + moneyline: side away, complete favorite', async () => {
    const { client } = makeClient({
      spec: SPEC_ML,
      odds: { moneyline: { awayOddsAmerican: -150, homeOddsAmerican: 130 } },
    });
    const { context, warning } = await resolvePositionSideContext(client, 101n, 0);
    expect(context).not.toBeNull();
    expect(context?.side).toBe('away');
    expect(context?.team).toEqual({ name: 'New York Yankees', alignment: 'away' });
    expect(context?.role).toBe('favorite');
    expect(warning).toBeUndefined();
  });

  it('positionType 1 + total: side under, not applicable', async () => {
    const spec: SpecLike = {
      type: 'total',
      contestId: '7',
      contest: { awayTeam: 'A', homeTeam: 'B' },
      line: 220.5,
    };
    const { client, oddsCalls } = makeClient({ spec });
    const { context } = await resolvePositionSideContext(client, 1n, 1);
    expect(context?.side).toBe('under');
    expect(context?.role).toBe('not_applicable');
    expect(context?.display).toBe('under 220.5 (total; no team)');
    expect(oddsCalls()).toBe(0);
  });

  it('speculations.get fails → context null + warning, NEVER throws (side underivable without the market)', async () => {
    const { client } = makeClient({ specThrows: true });
    const { context, warning } = await resolvePositionSideContext(client, 101n, 0);
    expect(context).toBeNull();
    expect(warning?.code).toBe('side-context-unavailable');
    expect(warning?.severity).toBe('warning');
    expect(warning?.details).toMatchObject({ positionType: 0 });
  });
});
