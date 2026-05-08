/**
 * Unit tests for the side resolver. The resolver is contest-scoped so
 * cross-league ambiguity ("Hawks" → ATL Hawks vs Seahawks vs
 * Blackhawks) is not in scope here — only ambiguity *within* a single
 * contest's two teams. Substring matching is intentionally absent.
 */

import { describe, expect, it } from 'vitest';
import { resolveSide, type TeamAlias } from '../src/commitments/resolveSide.js';
import { OspexValidationError } from '../src/errors.js';

const NUGGETS_LAKERS = {
  awayTeam: 'Los Angeles Lakers',
  homeTeam: 'Denver Nuggets',
  awayTeamId: 'lakers-uuid',
  homeTeamId: 'nuggets-uuid',
};

const ALIASES: TeamAlias[] = [
  { teamId: 'lakers-uuid', alias: 'LAL', aliasType: 'abbreviation' },
  { teamId: 'lakers-uuid', alias: 'LA Lakers', aliasType: 'short' },
  { teamId: 'nuggets-uuid', alias: 'DEN', aliasType: 'abbreviation' },
];

describe('resolveSide — totals', () => {
  it("maps 'over' to Upper / 'under' to Lower", () => {
    const over = resolveSide('over', 'total', NUGGETS_LAKERS, ALIASES);
    expect(over).toEqual({
      positionType: 0,
      resolvedLabel: 'over',
      role: 'over',
      resolutionSource: 'over',
    });
    const under = resolveSide('under', 'total', NUGGETS_LAKERS, ALIASES);
    expect(under).toEqual({
      positionType: 1,
      resolvedLabel: 'under',
      role: 'under',
      resolutionSource: 'under',
    });
  });

  it("accepts 'o' / 'u' shorthands", () => {
    expect(resolveSide('O', 'total', NUGGETS_LAKERS, ALIASES).positionType).toBe(0);
    expect(resolveSide('u', 'total', NUGGETS_LAKERS, ALIASES).positionType).toBe(1);
  });

  it('rejects team names on totals', () => {
    expect(() => resolveSide('lakers', 'total', NUGGETS_LAKERS, ALIASES)).toThrow(
      OspexValidationError,
    );
  });
});

describe('resolveSide — moneyline / spread team matching', () => {
  it('exact full-name match returns role away/home with source=exact', () => {
    const r1 = resolveSide('Los Angeles Lakers', 'moneyline', NUGGETS_LAKERS, ALIASES);
    expect(r1.positionType).toBe(0);
    expect(r1.role).toBe('away');
    expect(r1.resolutionSource).toBe('exact');
    expect(r1.resolvedLabel).toBe('Los Angeles Lakers');

    const r2 = resolveSide('denver nuggets', 'moneyline', NUGGETS_LAKERS, ALIASES);
    expect(r2.positionType).toBe(1);
    expect(r2.role).toBe('home');
    expect(r2.resolutionSource).toBe('exact');
  });

  it('last-token nickname match returns source=nickname', () => {
    const r = resolveSide('lakers', 'moneyline', NUGGETS_LAKERS, ALIASES);
    expect(r.role).toBe('away');
    expect(r.resolutionSource).toBe('nickname');
    expect(r.resolvedLabel).toBe('Los Angeles Lakers');
  });

  it('alias-table match returns source=alias when team_ids are present', () => {
    const r = resolveSide('LAL', 'spread', NUGGETS_LAKERS, ALIASES);
    expect(r.role).toBe('away');
    expect(r.resolutionSource).toBe('alias');
    expect(r.resolvedLabel).toBe('Los Angeles Lakers');

    const r2 = resolveSide('DEN', 'moneyline', NUGGETS_LAKERS, ALIASES);
    expect(r2.role).toBe('home');
    expect(r2.resolutionSource).toBe('alias');
  });

  it('alias-table is bypassed when either team_id is null', () => {
    // exact / nickname still works; alias matching disabled.
    const noIds = { ...NUGGETS_LAKERS, awayTeamId: null, homeTeamId: null };
    expect(() => resolveSide('LAL', 'moneyline', noIds, ALIASES)).toThrow(
      /Could not resolve/,
    );
    // But exact + nickname still pass.
    const r = resolveSide('Lakers', 'moneyline', noIds, ALIASES);
    expect(r.role).toBe('away');
    expect(r.resolutionSource).toBe('nickname');
  });

  it('case-insensitive matching across all strategies', () => {
    expect(resolveSide('LAKERS', 'moneyline', NUGGETS_LAKERS, ALIASES).role).toBe('away');
    expect(resolveSide('lal', 'moneyline', NUGGETS_LAKERS, ALIASES).role).toBe('away');
  });

  it('throws unknown_team when no strategy matches', () => {
    expect(() => resolveSide('warriors', 'moneyline', NUGGETS_LAKERS, ALIASES)).toThrow(
      /Could not resolve side/,
    );
  });

  it('does NOT do substring matching as a fallback', () => {
    // "Angeles" is a substring of "Los Angeles Lakers" but is not the
    // last token, full name, or any alias. Must reject.
    expect(() => resolveSide('Angeles', 'moneyline', NUGGETS_LAKERS, ALIASES)).toThrow(
      /Could not resolve/,
    );
  });

  it('fails closed when both teams ambiguously match (data-quality)', () => {
    // Pathological alias table: one alias points at the away team and
    // another at the home team for the same input string.
    const badAliases: TeamAlias[] = [
      { teamId: 'lakers-uuid', alias: 'GHOST', aliasType: 'manual' },
      { teamId: 'nuggets-uuid', alias: 'GHOST', aliasType: 'manual' },
    ];
    expect(() => resolveSide('GHOST', 'moneyline', NUGGETS_LAKERS, badAliases)).toThrow(
      /ambiguously matched/,
    );
  });

  it('rejects empty input', () => {
    expect(() => resolveSide('', 'moneyline', NUGGETS_LAKERS, ALIASES)).toThrow(
      OspexValidationError,
    );
    expect(() => resolveSide('   ', 'moneyline', NUGGETS_LAKERS, ALIASES)).toThrow(
      OspexValidationError,
    );
  });
});
