/**
 * D3: `includeFillability` is forwarded on the wire, and the advisory
 * `fillability` object maps through `CommitmentsApi.list` → public `Commitment`
 * (the mapper's `...body` spread carries it; these lock that it actually does).
 */
import { describe, expect, it } from 'vitest';
import { OspexClient } from '../src/index.js';
import type { CommitmentFillability } from '../src/index.js';
import type { CommitmentBody, CommitmentsListBody } from '../src/api/types.js';

const apiUrl = 'https://api.example.test';

const FILLABILITY: CommitmentFillability = {
  advisory: true,
  makerFundingStatus: 'overcommitted',
  orderIndividuallyBackedNow: true,
  makerBookBackedNow: false,
  makerBackingWei6: '15000000',
  makerVisibleCommittedWei6: '100000000',
  makerCoverageRatioBps: 1500,
  checkedAtBlock: '73491234',
  stale: false,
};

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

function makeCapturingFetch(rows: CommitmentBody[], captured: { url: string }): typeof globalThis.fetch {
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    captured.url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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

describe('commitments list — includeFillability wire + mapping', () => {
  it('forwards includeFillability=true on the query when requested', async () => {
    const captured = { url: '' };
    const client = new OspexClient({ apiUrl, fetch: makeCapturingFetch([makeBody()], captured) });
    await client.commitments.list({ includeFillability: true });
    expect(captured.url).toContain('includeFillability=true');
  });

  it('omits includeFillability from the query by default', async () => {
    const captured = { url: '' };
    const client = new OspexClient({ apiUrl, fetch: makeCapturingFetch([makeBody()], captured) });
    await client.commitments.list();
    expect(captured.url).not.toContain('includeFillability');
  });

  it('maps the advisory fillability object through to the public Commitment', async () => {
    const client = new OspexClient({
      apiUrl,
      fetch: makeCapturingFetch([makeBody({ fillability: FILLABILITY })], { url: '' }),
    });
    const [c] = await client.commitments.list({ includeFillability: true });
    expect(c?.fillability).toEqual(FILLABILITY);
    // The load-bearing individually-backed-but-overcommitted split survives the boundary.
    expect(c?.fillability?.makerFundingStatus).toBe('overcommitted');
    expect(c?.fillability?.orderIndividuallyBackedNow).toBe(true);
    expect(c?.fillability?.makerBookBackedNow).toBe(false);
  });

  it('leaves fillability undefined when the API row has none', async () => {
    const client = new OspexClient({ apiUrl, fetch: makeCapturingFetch([makeBody()], { url: '' }) });
    const [c] = await client.commitments.list();
    expect(c?.fillability).toBeUndefined();
  });
});
