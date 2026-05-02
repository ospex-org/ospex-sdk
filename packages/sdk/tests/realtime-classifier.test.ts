import { describe, expect, it } from 'vitest';
import { classifyOddsUpdate } from '../src/realtime/classifier.js';
import type { CurrentOddsRow } from '../src/db/types.js';

const baseRow: CurrentOddsRow = {
  network: 'polygon',
  jsonodds_id: 'abc',
  market: 'spread',
  line: -3.5,
  away_odds_american: -110,
  home_odds_american: -110,
  upstream_last_updated: '2026-05-02T10:00:00Z',
  poll_captured_at: '2026-05-02T10:00:30Z',
  changed_at: '2026-05-02T10:00:00Z',
};

function bump(iso: string, deltaSec: number): string {
  return new Date(Date.parse(iso) + deltaSec * 1000).toISOString();
}

describe('classifyOddsUpdate', () => {
  it('returns "change" when oldRow is null/undefined (initial state)', () => {
    expect(classifyOddsUpdate(null, baseRow)).toBe('change');
    expect(classifyOddsUpdate(undefined, baseRow)).toBe('change');
  });

  it('returns "change" when line moves', () => {
    const next: CurrentOddsRow = { ...baseRow, line: -4 };
    expect(classifyOddsUpdate(baseRow, next)).toBe('change');
  });

  it('returns "change" when away odds move', () => {
    const next: CurrentOddsRow = { ...baseRow, away_odds_american: -105 };
    expect(classifyOddsUpdate(baseRow, next)).toBe('change');
  });

  it('returns "change" when home odds move', () => {
    const next: CurrentOddsRow = { ...baseRow, home_odds_american: -115 };
    expect(classifyOddsUpdate(baseRow, next)).toBe('change');
  });

  it('returns "change" when changed_at advances even if prices match', () => {
    const next: CurrentOddsRow = {
      ...baseRow,
      changed_at: bump(baseRow.changed_at, 60),
    };
    expect(classifyOddsUpdate(baseRow, next)).toBe('change');
  });

  it('returns "refresh" when only upstream_last_updated advances', () => {
    const next: CurrentOddsRow = {
      ...baseRow,
      upstream_last_updated: bump(baseRow.upstream_last_updated, 60),
    };
    expect(classifyOddsUpdate(baseRow, next)).toBe('refresh');
  });

  it('returns "refresh" when only poll_captured_at advances', () => {
    const next: CurrentOddsRow = {
      ...baseRow,
      poll_captured_at: bump(baseRow.poll_captured_at, 60),
    };
    expect(classifyOddsUpdate(baseRow, next)).toBe('refresh');
  });

  it('returns "none" when the row is unchanged', () => {
    expect(classifyOddsUpdate(baseRow, { ...baseRow })).toBe('none');
  });

  it('null prices count as values for diff (null → number is a change)', () => {
    const oldRow: CurrentOddsRow = { ...baseRow, line: null };
    const newRow: CurrentOddsRow = { ...baseRow, line: -3.5 };
    expect(classifyOddsUpdate(oldRow, newRow)).toBe('change');
  });

  it('malformed timestamps do not throw — they suppress the signal', () => {
    const oldRow: CurrentOddsRow = { ...baseRow, upstream_last_updated: 'not-a-date' };
    const newRow: CurrentOddsRow = { ...baseRow };
    expect(classifyOddsUpdate(oldRow, newRow)).toBe('none');
  });
});
