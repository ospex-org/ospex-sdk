/**
 * `Commitment.isLive` — derived predicate covering all status ×
 * nonceInvalidated combinations. The mapper lives in
 * `src/api/commitments.ts` (`toCommitment`) so the test exercises that
 * directly with a stubbed fetch.
 */

import { describe, expect, it } from 'vitest';
import { OspexClient } from '../src/index.js';
import type {
  CommitmentBody,
  CommitmentsListBody,
} from '../src/api/types.js';
import type {
  Commitment,
  PublicVisibleCommitment,
} from '../src/types/commitment.js';

const apiUrl = 'https://api.example.test';

/**
 * Narrow a listed row to the visible variant. Every fixture in this file is
 * book-visible, so a hidden row means the decoder mis-classified it — fail
 * loudly instead of letting the field assertions read `undefined`.
 */
function visible(row: Commitment | undefined): PublicVisibleCommitment {
  if (row === undefined) throw new Error('expected a commitment row, got none');
  if (row.visibility !== 'visible') {
    throw new Error(`expected a visible commitment, got ${row.visibility}`);
  }
  return row;
}

function makeBody(overrides: Partial<CommitmentBody> = {}): CommitmentBody {
  return {
    commitmentHash: '0x' + 'aa'.repeat(32),
    maker: '0x' + 'bb'.repeat(20),
    contestId: '1',
    scorer: '0x' + 'cc'.repeat(20),
    lineTicks: 0,
    positionType: 0,
    oddsTick: 200,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '1',
    expiry: '2099-01-01T00:00:00.000Z',
    speculationKey: '0x' + 'dd'.repeat(32),
    signature: '0x' + 'cc'.repeat(65),
    status: 'open',
    source: 'agent',
    network: 'polygon',
    nonceInvalidated: false,
    createdAt: '2026-05-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeFetch(rows: CommitmentBody[]): typeof globalThis.fetch {
  const fetchImpl: typeof globalThis.fetch = async () => {
    const body: CommitmentsListBody = {
      commitments: rows,
      pagination: { limit: 100, offset: 0, total: rows.length, hasMore: false },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return fetchImpl;
}

describe('Commitment.isLive predicate', () => {
  // Mirrors the contract's matchCommitment preconditions; partially_filled
  // is takeable liquidity, so it MUST be live when remaining > 0 and the
  // expiry is in the future (the core API treats open|partially_filled
  // identically for the open book).
  const cases: Array<{
    name: string;
    overrides: Partial<CommitmentBody>;
    expectIsLive: boolean;
  }> = [
    { name: 'open + not invalidated + remaining + future expiry', overrides: { status: 'open', nonceInvalidated: false }, expectIsLive: true },
    { name: 'open + invalidated', overrides: { status: 'open', nonceInvalidated: true }, expectIsLive: false },
    { name: 'partially_filled + not invalidated + remaining + future expiry', overrides: { status: 'partially_filled', nonceInvalidated: false, filledRiskAmount: '300000', remainingRiskAmount: '700000' }, expectIsLive: true },
    { name: 'partially_filled + invalidated', overrides: { status: 'partially_filled', nonceInvalidated: true, filledRiskAmount: '300000', remainingRiskAmount: '700000' }, expectIsLive: false },
    { name: 'partially_filled + zero remaining (defensive)', overrides: { status: 'partially_filled', filledRiskAmount: '1000000', remainingRiskAmount: '0' }, expectIsLive: false },
    { name: 'open + remainingRiskAmount = 0 (shouldn\'t exist, defensive)', overrides: { status: 'open', remainingRiskAmount: '0' }, expectIsLive: false },
    { name: 'open + expiry in the past', overrides: { status: 'open', expiry: '2000-01-01T00:00:00.000Z' }, expectIsLive: false },
    { name: 'open + null expiry (legacy/indexer-only row)', overrides: { status: 'open', expiry: null }, expectIsLive: false },
    { name: 'filled', overrides: { status: 'filled', remainingRiskAmount: '0', filledRiskAmount: '1000000' }, expectIsLive: false },
    { name: 'cancelled', overrides: { status: 'cancelled' }, expectIsLive: false },
    { name: 'expired', overrides: { status: 'expired' }, expectIsLive: false },
    // ── book-visibility split: isLive keys off the RAW on-chain lifecycle (`storedStatus`),
    //    NOT the effective `status`. A book-hidden row (pulled from the orderbook off-chain →
    //    effective `status: 'cancelled'`) whose storedStatus is still open / partially_filled is
    //    STILL matchable on chain (matchCommitment ignores book-visibility) → isLive=true.
    //    The cases above set no storedStatus, exercising the storedStatus→status back-compat
    //    fallback (older core-api); these set it explicitly (current core-api).
    { name: 'book-hidden: effective cancelled + storedStatus open → live (on-chain matchable)', overrides: { status: 'cancelled', storedStatus: 'open', nonceInvalidated: false }, expectIsLive: true },
    { name: 'book-hidden: effective cancelled + storedStatus partially_filled + remaining → live', overrides: { status: 'cancelled', storedStatus: 'partially_filled', filledRiskAmount: '300000', remainingRiskAmount: '700000' }, expectIsLive: true },
    { name: 'truly on-chain cancelled: storedStatus cancelled → not live', overrides: { status: 'cancelled', storedStatus: 'cancelled' }, expectIsLive: false },
    { name: 'book-hidden but nonce-invalidated → not live (nonceInvalidated wins over a live storedStatus)', overrides: { status: 'cancelled', storedStatus: 'open', nonceInvalidated: true }, expectIsLive: false },
    { name: 'book-hidden but past expiry → not live (expiry wins)', overrides: { status: 'cancelled', storedStatus: 'open', expiry: '2000-01-01T00:00:00.000Z' }, expectIsLive: false },
    { name: 'book-hidden but zero remaining → not live (remaining wins)', overrides: { status: 'cancelled', storedStatus: 'open', remainingRiskAmount: '0' }, expectIsLive: false },
  ];

  for (const c of cases) {
    it(`${c.name} → isLive=${c.expectIsLive}`, async () => {
      const client = new OspexClient({ apiUrl, fetch: makeFetch([makeBody(c.overrides)]) });
      const [first] = await client.commitments.list();
      expect(visible(first).isLive).toBe(c.expectIsLive);
    });
  }
});

describe('CommitmentsApi.list options pass-through', () => {
  it('passes includeInvalidated=true on the wire when set', async () => {
    let capturedUrl = '';
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      const body: CommitmentsListBody = {
        commitments: [],
        pagination: { limit: 100, offset: 0, total: 0, hasMore: false },
      };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const client = new OspexClient({ apiUrl, fetch: fetchImpl });
    await client.commitments.list({ includeInvalidated: true });
    const url = new URL(capturedUrl);
    expect(url.searchParams.get('includeInvalidated')).toBe('true');
  });

  it('omits includeInvalidated when not specified (server default applies)', async () => {
    let capturedUrl = '';
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      const body: CommitmentsListBody = {
        commitments: [],
        pagination: { limit: 100, offset: 0, total: 0, hasMore: false },
      };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const client = new OspexClient({ apiUrl, fetch: fetchImpl });
    await client.commitments.list({ maker: '0x' + '11'.repeat(20) });
    const url = new URL(capturedUrl);
    expect(url.searchParams.has('includeInvalidated')).toBe(false);
  });
});
