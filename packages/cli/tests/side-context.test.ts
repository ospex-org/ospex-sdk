/**
 * Unit tests for `buildSideContext` — the pure team-identity enrichment
 * helper shared by settle / claim / claim-all. Covers the review acceptance
 * matrix: moneyline full team+role, spread role-from-line (+ odds
 * fallback), role unavailable → unknown, totals (no team), push/void/tbd
 * wording, and the team-unavailable degrade. The helper is pure, so every
 * branch is exercised here regardless of which command can supply which
 * inputs (claim-all supplies little; settle/claim supply the rich path).
 */

import { describe, expect, it } from 'vitest';
import { buildSideContext } from '../src/lib/sideContext.js';

describe('buildSideContext — moneyline', () => {
  it('away favorite (more-negative American odds): complete, team + role, source moneyline-odds', () => {
    const ctx = buildSideContext({
      side: 'away',
      marketType: 'moneyline',
      teams: { away: 'New York Yankees', home: 'Toronto Blue Jays' },
      americanOdds: { away: -150, home: 130 },
    });
    expect(ctx.side).toBe('away');
    expect(ctx.marketType).toBe('moneyline');
    expect(ctx.team).toEqual({ name: 'New York Yankees', alignment: 'away' });
    expect(ctx.role).toBe('favorite');
    expect(ctx.display).toBe('away (New York Yankees, favorite)');
    expect(ctx.status).toBe('complete');
    expect(ctx.source).toEqual({ team: 'speculation-detail', role: 'moneyline-odds' });
  });

  it('home underdog (less-negative side)', () => {
    const ctx = buildSideContext({
      side: 'home',
      marketType: 'moneyline',
      teams: { away: 'New York Yankees', home: 'Toronto Blue Jays' },
      americanOdds: { away: -150, home: 130 },
    });
    expect(ctx.team).toEqual({ name: 'Toronto Blue Jays', alignment: 'home' });
    expect(ctx.role).toBe('underdog');
    expect(ctx.display).toBe('home (Toronto Blue Jays, underdog)');
    expect(ctx.status).toBe('complete');
  });

  it('even when both American odds are equal', () => {
    const ctx = buildSideContext({
      side: 'away',
      marketType: 'moneyline',
      teams: { away: 'A', home: 'B' },
      americanOdds: { away: -110, home: -110 },
    });
    expect(ctx.role).toBe('even');
    expect(ctx.display).toBe('away (A, even)');
    expect(ctx.status).toBe('complete');
  });

  it('both-negative odds: the more-negative side is the favorite', () => {
    // away -150, home -200 → home (more negative) is the favorite.
    const opts = {
      marketType: 'moneyline' as const,
      teams: { away: 'A', home: 'B' },
      americanOdds: { away: -150, home: -200 },
    };
    expect(buildSideContext({ side: 'home', ...opts }).role).toBe('favorite');
    expect(buildSideContext({ side: 'away', ...opts }).role).toBe('underdog');
  });

  it('both-positive odds: the less-positive side is the favorite', () => {
    // away +120, home +140 → away (lower number) is the favorite.
    const opts = {
      marketType: 'moneyline' as const,
      teams: { away: 'A', home: 'B' },
      americanOdds: { away: 120, home: 140 },
    };
    expect(buildSideContext({ side: 'away', ...opts }).role).toBe('favorite');
    expect(buildSideContext({ side: 'home', ...opts }).role).toBe('underdog');
  });

  it('role unavailable (odds missing) → role unknown, status partial, source unavailable', () => {
    const ctx = buildSideContext({
      side: 'away',
      marketType: 'moneyline',
      teams: { away: 'New York Yankees', home: 'Toronto Blue Jays' },
      // no americanOdds
    });
    expect(ctx.team).toEqual({ name: 'New York Yankees', alignment: 'away' });
    expect(ctx.role).toBe('unknown');
    expect(ctx.display).toBe('away (New York Yankees, role unknown)');
    expect(ctx.status).toBe('partial');
    expect(ctx.source).toEqual({ team: 'speculation-detail', role: 'unavailable' });
  });
});

describe('buildSideContext — spread', () => {
  it('away favorite from a negative line: source spread-line', () => {
    const ctx = buildSideContext({
      side: 'away',
      marketType: 'spread',
      teams: { away: 'A', home: 'B' },
      spreadLine: { away: -3.5, home: 3.5 },
    });
    expect(ctx.role).toBe('favorite');
    expect(ctx.status).toBe('complete');
    expect(ctx.source.role).toBe('spread-line');
    expect(ctx.display).toBe('away (A, favorite)');
  });

  it('home underdog from a positive line', () => {
    const ctx = buildSideContext({
      side: 'home',
      marketType: 'spread',
      teams: { away: 'A', home: 'B' },
      spreadLine: { away: -3.5, home: 3.5 },
    });
    expect(ctx.role).toBe('underdog');
    expect(ctx.source.role).toBe('spread-line');
  });

  it('even when the line is zero (pick em)', () => {
    const ctx = buildSideContext({
      side: 'away',
      marketType: 'spread',
      teams: { away: 'A', home: 'B' },
      spreadLine: { away: 0, home: 0 },
    });
    expect(ctx.role).toBe('even');
    expect(ctx.source.role).toBe('spread-line');
  });

  it('falls back to American odds when the line is absent: source spread-odds', () => {
    const ctx = buildSideContext({
      side: 'home',
      marketType: 'spread',
      teams: { away: 'A', home: 'B' },
      spreadLine: { away: null, home: null },
      americanOdds: { away: 120, home: -140 },
    });
    expect(ctx.role).toBe('favorite'); // home -140 is more negative
    expect(ctx.source.role).toBe('spread-odds');
    expect(ctx.status).toBe('complete');
  });

  it('role unknown when neither line nor odds available → status partial', () => {
    const ctx = buildSideContext({
      side: 'away',
      marketType: 'spread',
      teams: { away: 'A', home: 'B' },
    });
    expect(ctx.role).toBe('unknown');
    expect(ctx.status).toBe('partial');
    expect(ctx.source.role).toBe('unavailable');
  });
});

describe('buildSideContext — totals (no team)', () => {
  it('over without a line: not applicable, no team', () => {
    const ctx = buildSideContext({ side: 'over', marketType: 'total' });
    expect(ctx.team).toBeNull();
    expect(ctx.role).toBe('not_applicable');
    expect(ctx.marketType).toBe('total');
    expect(ctx.display).toBe('over (total; no team)');
    expect(ctx.status).toBe('not_applicable');
    expect(ctx.source).toEqual({ team: 'not_applicable', role: 'not_applicable' });
  });

  it('under with a line: includes the line in the display', () => {
    const ctx = buildSideContext({ side: 'under', marketType: 'total', totalLine: 8.5 });
    expect(ctx.display).toBe('under 8.5 (total; no team)');
    expect(ctx.role).toBe('not_applicable');
  });

  it('infers total even when marketType is null (over/under implies total)', () => {
    const ctx = buildSideContext({ side: 'over' });
    expect(ctx.marketType).toBe('total');
    expect(ctx.role).toBe('not_applicable');
    expect(ctx.display).toBe('over (total; no team)');
  });
});

describe('buildSideContext — no winning side', () => {
  it('push', () => {
    const ctx = buildSideContext({ side: 'push' });
    expect(ctx.team).toBeNull();
    expect(ctx.role).toBe('not_applicable');
    expect(ctx.display).toBe('push (no winning side)');
    expect(ctx.status).toBe('not_applicable');
  });

  it('void', () => {
    expect(buildSideContext({ side: 'void' }).display).toBe('void (contest/speculation voided)');
    expect(buildSideContext({ side: 'void' }).role).toBe('not_applicable');
  });

  it('tbd', () => {
    const ctx = buildSideContext({ side: 'tbd' });
    expect(ctx.display).toBe('tbd (unsettled)');
    expect(ctx.status).toBe('not_applicable');
    expect(ctx.role).toBe('not_applicable');
  });
});

describe('buildSideContext — team unavailable / degraded (claim-all without a fetch)', () => {
  it('away with no teams resolved: team null, status unavailable, never fabricated', () => {
    const ctx = buildSideContext({ side: 'away' }); // no marketType, no teams (claim-all entry)
    expect(ctx.team).toBeNull();
    expect(ctx.role).toBe('unknown');
    expect(ctx.display).toBe('away (team unavailable)');
    expect(ctx.status).toBe('unavailable');
    expect(ctx.source).toEqual({ team: 'unavailable', role: 'unavailable' });
  });

  it('team-bearing side with marketType null but teams present → partial (team known, role underivable)', () => {
    const ctx = buildSideContext({
      side: 'home',
      // marketType unknown → can't pick moneyline-vs-spread derivation
      teams: { away: 'A', home: 'B' },
    });
    expect(ctx.team).toEqual({ name: 'B', alignment: 'home' });
    expect(ctx.role).toBe('unknown');
    expect(ctx.status).toBe('partial');
    expect(ctx.display).toBe('home (B, role unknown)');
  });

  it('honors an explicit teamSource (e.g. claim-params-description) when teams are supplied', () => {
    const ctx = buildSideContext({
      side: 'away',
      marketType: 'moneyline',
      teams: { away: 'A', home: 'B' },
      teamSource: 'claim-params-description',
      americanOdds: { away: -200, home: 170 },
    });
    expect(ctx.source.team).toBe('claim-params-description');
    expect(ctx.role).toBe('favorite');
  });
});
