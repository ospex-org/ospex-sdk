/**
 * Unit tests for the single shared owner-commitment liveness predicate
 * (`isOwnerCommitmentLiveAt`). This is the function the snapshot decoder uses
 * to stamp `OwnerCommitment.isLive` AND the `ospex own-state watch` CLI uses to
 * recompute its live count — so its contract is load-bearing for both.
 *
 * The load-bearing edges (these are exactly what diverged in the first cut of
 * the CLI watcher and were caught in review): `expiry === null`, an
 * unparseable expiry, and an expiry at/before `nowMs` are ALL **not live** —
 * on chain a null/invalid expiry behaves as `expiry == 0` ⇒ expired.
 */
import { describe, expect, it } from 'vitest';
import {
  isOwnerCommitmentLiveAt,
  type OwnerLivenessInput,
} from '../src/ownState/liveness.js';

const NOW = Date.parse('2026-06-09T12:00:00.000Z');
const FUTURE = '2026-06-09T13:00:00.000Z';
const PAST = '2026-06-09T11:00:00.000Z';
const EXACTLY_NOW = '2026-06-09T12:00:00.000Z';

const base = (over: Partial<OwnerLivenessInput> = {}): OwnerLivenessInput => ({
  storedStatus: 'open',
  remainingRiskAmount: '1000000',
  expiry: FUTURE,
  nonceInvalidated: false,
  ...over,
});

describe('isOwnerCommitmentLiveAt', () => {
  it('live: open + future expiry + remaining > 0 + not nonce-invalidated', () => {
    expect(isOwnerCommitmentLiveAt(base(), NOW)).toBe(true);
  });

  it('live: partially_filled with remaining > 0 and future expiry', () => {
    expect(isOwnerCommitmentLiveAt(base({ storedStatus: 'partially_filled' }), NOW)).toBe(true);
  });

  it('NOT live: null expiry (behaves as expiry==0 ⇒ expired)', () => {
    expect(isOwnerCommitmentLiveAt(base({ expiry: null }), NOW)).toBe(false);
  });

  it('NOT live: unparseable expiry', () => {
    expect(isOwnerCommitmentLiveAt(base({ expiry: 'not-a-date' }), NOW)).toBe(false);
  });

  it('NOT live: expiry strictly in the past', () => {
    expect(isOwnerCommitmentLiveAt(base({ expiry: PAST }), NOW)).toBe(false);
  });

  it('NOT live: expiry exactly at now (strict future required)', () => {
    expect(isOwnerCommitmentLiveAt(base({ expiry: EXACTLY_NOW }), NOW)).toBe(false);
  });

  it('NOT live: nonce-invalidated', () => {
    expect(isOwnerCommitmentLiveAt(base({ nonceInvalidated: true }), NOW)).toBe(false);
  });

  it('NOT live: remainingRiskAmount is 0', () => {
    expect(isOwnerCommitmentLiveAt(base({ remainingRiskAmount: '0' }), NOW)).toBe(false);
  });

  it('NOT live: unparseable remainingRiskAmount (defensive — never throws)', () => {
    expect(isOwnerCommitmentLiveAt(base({ remainingRiskAmount: 'xyz' }), NOW)).toBe(false);
  });

  it('NOT live: terminal stored statuses (filled / cancelled)', () => {
    expect(isOwnerCommitmentLiveAt(base({ storedStatus: 'filled' }), NOW)).toBe(false);
    expect(isOwnerCommitmentLiveAt(base({ storedStatus: 'cancelled' }), NOW)).toBe(false);
  });

  it('clock-driven: the same row flips live → not-live as nowMs crosses expiry, with no input change', () => {
    const c = base({ expiry: FUTURE });
    const beforeMs = Date.parse('2026-06-09T12:59:59.000Z');
    const afterMs = Date.parse('2026-06-09T13:00:01.000Z');
    expect(isOwnerCommitmentLiveAt(c, beforeMs)).toBe(true);
    expect(isOwnerCommitmentLiveAt(c, afterMs)).toBe(false);
  });
});
