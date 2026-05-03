/**
 * NonceCounter — per-instance, per-(maker, speculationKey) monotonic
 * cache. Verifies the SDK's "max(floor, lastInProcess + 1, unixSec)"
 * strategy and that calls for different keys are independent.
 */

import { describe, expect, it } from 'vitest';
import { NonceCounter } from '../src/commitments/context.js';

const makerA = '0x1111111111111111111111111111111111111111';
const makerB = '0x2222222222222222222222222222222222222222';
const specKey1 = '0xaa' + '00'.repeat(31);
const specKey2 = '0xbb' + '00'.repeat(31);

describe('NonceCounter', () => {
  it('first call returns max(floor, unixSec)', () => {
    const c = new NonceCounter();
    const out = c.next(makerA, specKey1, 1000n, 5_000n);
    expect(out).toBe(5_000n);
  });

  it('first call respects floor when floor > unixSec', () => {
    const c = new NonceCounter();
    const out = c.next(makerA, specKey1, 9_999n, 5_000n);
    expect(out).toBe(9_999n);
  });

  it('subsequent same-second calls advance via the counter', () => {
    const c = new NonceCounter();
    const a = c.next(makerA, specKey1, 0n, 1_000n);
    const b = c.next(makerA, specKey1, 0n, 1_000n);
    const cVal = c.next(makerA, specKey1, 0n, 1_000n);
    expect(a).toBe(1_000n);
    expect(b).toBe(1_001n);
    expect(cVal).toBe(1_002n);
  });

  it('different (maker, key) pairs are independent', () => {
    const c = new NonceCounter();
    const a1 = c.next(makerA, specKey1, 0n, 1_000n);
    const b1 = c.next(makerB, specKey1, 0n, 1_000n);
    const a2 = c.next(makerA, specKey2, 0n, 1_000n);
    expect(a1).toBe(1_000n);
    expect(b1).toBe(1_000n);
    expect(a2).toBe(1_000n);
  });

  it('floor advance pulls future calls forward', () => {
    const c = new NonceCounter();
    c.next(makerA, specKey1, 0n, 1_000n); // returns 1_000
    const out = c.next(makerA, specKey1, 5_000n, 1_000n); // floor jumps
    expect(out).toBe(5_000n);
  });

  it('observe() raises the watermark when a higher nonce was used', () => {
    const c = new NonceCounter();
    c.observe(makerA, specKey1, 100n);
    const next = c.next(makerA, specKey1, 0n, 50n);
    expect(next).toBe(101n);
  });

  it('observe() does not lower the watermark', () => {
    const c = new NonceCounter();
    c.observe(makerA, specKey1, 100n);
    c.observe(makerA, specKey1, 50n);
    const next = c.next(makerA, specKey1, 0n, 50n);
    expect(next).toBe(101n);
  });

  it('keys are case-insensitive — checksummed and lowercase collide', () => {
    const c = new NonceCounter();
    const lower = '0xabcdef0000000000000000000000000000000000';
    const checksum = '0xAbCdEf0000000000000000000000000000000000';
    c.next(lower, specKey1, 0n, 100n);
    const out = c.next(checksum, specKey1, 0n, 100n);
    expect(out).toBe(101n);
  });
});
