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
  it('surfaces effective status "expired" with raw storedStatus "open"; isLive=false via the past expiry (not the effective status)', async () => {
    const client = new OspexClient({
      apiUrl,
      // A real effective-expired row has a PAST expiry — that (with storedStatus) is what drives
      // isLive=false now; isLive keys off storedStatus + the actual expiry, not the `status` token.
      fetch: makeFetch([makeBody({ status: 'expired', storedStatus: 'open', expiry: '2000-01-01T00:00:00.000Z' })]),
    });
    const [c] = await client.commitments.list();
    expect(c?.status).toBe('expired');
    expect(c?.storedStatus).toBe('open');
    expect(visible(c).isLive).toBe(false);
  });

  it('book-hidden: effective status "cancelled" + raw storedStatus "partially_filled" → still isLive (book-hiding is not an on-chain cancel; the signed payload stays matchable)', async () => {
    const client = new OspexClient({
      apiUrl,
      fetch: makeFetch([makeBody({ status: 'cancelled', storedStatus: 'partially_filled', filledRiskAmount: '300000', remainingRiskAmount: '700000' })]),
    });
    const [c] = await client.commitments.list();
    expect(c?.status).toBe('cancelled'); // effective — pulled from the public book
    expect(c?.storedStatus).toBe('partially_filled'); // raw on-chain lifecycle
    expect(visible(c).isLive).toBe(true); // matchCommitment ignores book-visibility → still live
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
