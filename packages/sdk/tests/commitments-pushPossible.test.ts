import { describe, expect, it } from 'vitest';
import { pushPossible } from '../src/commitments/pushPossible.js';

describe('pushPossible', () => {
  it('moneyline never pushes', () => {
    expect(pushPossible('moneyline', 0)).toBe(false);
    expect(pushPossible('moneyline', 35)).toBe(false);
    expect(pushPossible('moneyline', -30)).toBe(false);
  });

  it('spread pushes only on integer lines (line_ticks % 10 === 0)', () => {
    expect(pushPossible('spread', -30)).toBe(true);
    expect(pushPossible('spread', 30)).toBe(true);
    expect(pushPossible('spread', 0)).toBe(true);
    expect(pushPossible('spread', -35)).toBe(false);
    expect(pushPossible('spread', 35)).toBe(false);
    expect(pushPossible('spread', 75)).toBe(false);
  });

  it('total pushes only on integer lines', () => {
    expect(pushPossible('total', 80)).toBe(true);
    expect(pushPossible('total', 220)).toBe(true);
    expect(pushPossible('total', 85)).toBe(false);
    expect(pushPossible('total', 2205)).toBe(false);
  });
});
