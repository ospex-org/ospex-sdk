import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { formatMatchTime, formatOutput, toHuman } from '../src/lib/format.js';

class StringSink extends Writable {
  buf = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.buf += chunk.toString();
    cb();
  }
}

describe('formatOutput / toHuman', () => {
  it('JSON mode produces parseable JSON', () => {
    const sink = new StringSink();
    formatOutput({ a: 1, b: 'two' }, { json: true, out: sink });
    expect(JSON.parse(sink.buf.trim())).toEqual({ a: 1, b: 'two' });
  });

  it('JSON mode serializes BigInt safely', () => {
    const sink = new StringSink();
    formatOutput({ amount: 10n ** 18n }, { json: true, out: sink });
    expect(JSON.parse(sink.buf.trim())).toEqual({ amount: '1000000000000000000' });
  });

  it('human mode renders an array of objects as a table', () => {
    const out = toHuman([
      { contestId: '1', sport: 'nba' },
      { contestId: '2', sport: 'nfl' },
    ]);
    expect(out).toContain('contestId');
    expect(out).toContain('sport');
    expect(out).toContain('nba');
    expect(out).toContain('nfl');
  });

  it('human mode renders a single object as key-value lines', () => {
    const out = toHuman({ ok: true, status: 'verified' });
    expect(out).toMatch(/ok\s+true/);
    expect(out).toMatch(/status\s+verified/);
  });

  it('human mode handles empty arrays and null gracefully', () => {
    expect(toHuman([])).toBe('(no results)');
    expect(toHuman(null)).toBe('(empty)');
  });

  it('human mode renders nested values via JSON.stringify in cells', () => {
    const out = toHuman([{ id: 1, meta: { x: 1 } }]);
    expect(out).toContain('"x":1');
  });
});

describe('formatMatchTime', () => {
  it('renders a friendly local-time string for a UTC ISO input', () => {
    const out = formatMatchTime('2026-05-06T19:45:00+00:00');

    // The whole point — the raw ISO must not pass through.
    expect(out).not.toContain('2026-05-06T');
    expect(out).not.toBe('2026-05-06T19:45:00+00:00');

    // Some clock-style time component is rendered.
    expect(out).toMatch(/\d{1,2}:\d{2}/);

    // At least some locale-formatted text (month name in any language).
    // Locale + timezone vary across machines (en-US "May 6, 2:45 PM CDT",
    // en-GB "6 May, 2:45 pm GMT-5", de-DE "6. Mai, 14:45 GMT-5", etc.) so
    // we pin only the shape rather than asserting on en-US specifics.
    expect(out).toMatch(/[A-Za-z]/);
  });

  it('returns the input unchanged if it cannot be parsed', () => {
    expect(formatMatchTime('not-a-date')).toBe('not-a-date');
  });
});
