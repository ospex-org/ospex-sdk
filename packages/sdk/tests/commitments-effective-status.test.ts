/**
 * Effective status + storedStatus mapping. The core API now returns an
 * effective `status` (folding in time-expiry / nonce invalidation) plus a raw
 * `storedStatus`. The SDK passes `status` through verbatim and surfaces
 * `storedStatus`, defaulting it to `status` for back-compat with older API
 * builds that omit the field.
 */
import { describe, expect, it } from 'vitest';
import { OspexClient } from '../src/index.js';
import type { CommitmentBody, CommitmentsListBody } from '../src/api/types.js';

const apiUrl = 'https://api.example.test';

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
    storedStatus: 'open',
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

describe('effective status passthrough + storedStatus', () => {
  it('surfaces effective status "expired" with raw storedStatus "open"', async () => {
    const client = new OspexClient({
      apiUrl,
      fetch: makeFetch([makeBody({ status: 'expired', storedStatus: 'open' })]),
    });
    const [c] = await client.commitments.list();
    expect(c?.status).toBe('expired');
    expect(c?.storedStatus).toBe('open');
    expect(c?.isLive).toBe(false);
  });

  it('surfaces effective status "cancelled" with raw storedStatus "partially_filled"', async () => {
    const client = new OspexClient({
      apiUrl,
      fetch: makeFetch([makeBody({ status: 'cancelled', storedStatus: 'partially_filled' })]),
    });
    const [c] = await client.commitments.list();
    expect(c?.status).toBe('cancelled');
    expect(c?.storedStatus).toBe('partially_filled');
  });

  it('back-compat: defaults storedStatus to status when the API omits it', async () => {
    // Simulate an older core-api response with no storedStatus field.
    const legacy = makeBody({ status: 'open' });
    delete (legacy as { storedStatus?: unknown }).storedStatus;
    const client = new OspexClient({ apiUrl, fetch: makeFetch([legacy]) });
    const [c] = await client.commitments.list();
    expect(c?.storedStatus).toBe('open');
    expect(c?.status).toBe('open');
  });
});
