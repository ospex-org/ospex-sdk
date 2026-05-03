/**
 * API client tests with a mocked fetch. We don't open real sockets —
 * each test installs a fetch stub that returns a canned Response, then
 * asserts the URL/method/body the SDK constructed and that the response
 * is decoded into the public types.
 */

import { describe, expect, it } from 'vitest';
import { OspexAPIError, OspexClient } from '../src/index.js';

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function makeFetch(
  responder: (req: CapturedRequest) => { status: number; body: unknown },
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ url, init });
    const { status, body } = responder({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch: fetchImpl, calls };
}

const apiUrl = 'https://api.example.test';

describe('OspexClient API surface', () => {
  it('markets.list builds the right URL and decodes the response', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        markets: [
          {
            contestId: '42',
            awayTeam: 'Lakers',
            homeTeam: 'Celtics',
            sport: 'nba',
            sportId: 1,
            matchTime: '2026-05-03T00:00:00Z',
            status: 'verified',
            speculations: [
              {
                speculationId: '101',
                type: 'spread',
                lineTicks: -35,
                line: -3.5,
                awayLine: 3.5,
                homeLine: -3.5,
                speculationStatus: 0,
              },
            ],
          },
        ],
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const markets = await client.markets.list({ sport: 'nba', hours: 12 });
    expect(markets).toHaveLength(1);
    const first = markets[0]!;
    expect(first.contestId).toBe('42');
    expect(first.speculations[0]!.awayLine).toBe(3.5);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/markets');
    expect(url.searchParams.get('sport')).toBe('nba');
    expect(url.searchParams.get('window')).toBe('12');
  });

  it('markets.get hits the path-parameter endpoint and surfaces jsonoddsId', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        contestId: '42',
        jsonoddsId: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
        awayTeam: 'A',
        homeTeam: 'B',
        sport: 'nba',
        sportId: 1,
        matchTime: '2026-05-03T00:00:00Z',
        status: 'verified',
        speculations: [],
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const market = await client.markets.get('42');
    expect(calls[0]!.url).toBe(`${apiUrl}/v1/markets/42`);
    expect(market.jsonoddsId).toBe('a783e37e-4ce1-4f42-9dd6-615568f73044');
  });

  it('markets.list rows do not surface jsonoddsId (detail-only field)', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        markets: [
          {
            contestId: '1',
            awayTeam: 'A',
            homeTeam: 'B',
            sport: 'nba',
            sportId: 1,
            matchTime: '2026-05-03T00:00:00Z',
            status: 'verified',
            speculations: [],
          },
        ],
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const [first] = await client.markets.list();
    expect(first?.jsonoddsId).toBeUndefined();
  });

  it('positions.byAddress validates the address and lowercases it', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        address: '0xabc',
        positions: [],
        totals: { totalCount: 0, totalRiskUSDC: 0, totalProfitUSDC: 0, activeCount: 0 },
        pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    await client.positions.byAddress('0xABCDEFabcdef0123456789ABCDEF0123456789AB');
    expect(calls[0]!.url).toBe(
      `${apiUrl}/v1/positions/0xabcdefabcdef0123456789abcdef0123456789ab`,
    );
  });

  it('positions.byAddress rejects an invalid address', async () => {
    const client = new OspexClient({ apiUrl });
    await expect(client.positions.byAddress('not-an-address')).rejects.toThrow();
  });

  it('positions.status decodes the three-bucket response (active | pendingSettle | claimable)', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        address: '0xabcdefabcdef0123456789abcdef0123456789ab',
        active: [
          {
            positionId: 'a',
            speculationId: '10',
            positionType: 0,
            team: 'A',
            opponent: 'B',
            market: 'moneyline',
            oddsDecimal: 2,
            riskAmountUSDC: 100,
            profitAmountUSDC: 100,
          },
        ],
        pendingSettle: [
          {
            positionId: 'p',
            speculationId: '20',
            positionType: 0,
            team: 'A',
            opponent: 'B',
            market: 'moneyline',
            oddsDecimal: 2,
            riskAmountUSDC: 50,
            profitAmountUSDC: 50,
            result: 'won',
            predictedWinSide: 'away',
            estimatedPayoutUSDC: 100,
            estimatedPayoutWei6: '100000000',
          },
        ],
        claimable: [
          {
            positionId: 'c',
            speculationId: '30',
            positionType: 1,
            team: 'B',
            opponent: 'A',
            market: 'spread',
            oddsDecimal: 1.91,
            riskAmountUSDC: 100,
            profitAmountUSDC: 91,
            result: 'won',
            estimatedPayoutUSDC: 191,
            estimatedPayoutWei6: '191000000',
          },
        ],
        totals: {
          activeCount: 1,
          pendingSettleCount: 1,
          claimableCount: 1,
          estimatedPayoutUSDC: 191,
          estimatedPayoutWei6: '191000000',
          pendingSettlePayoutUSDC: 100,
          pendingSettlePayoutWei6: '100000000',
        },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const status = await client.positions.status('0xABCDEFabcdef0123456789ABCDEF0123456789AB');
    expect(status.active).toHaveLength(1);
    expect(status.pendingSettle).toHaveLength(1);
    expect(status.pendingSettle[0]!.predictedWinSide).toBe('away');
    expect(status.claimable).toHaveLength(1);
    expect(status.totals.pendingSettlePayoutWei6).toBe('100000000');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/positions/0xabcdefabcdef0123456789abcdef0123456789ab/status');
  });

  it('positions.claimParams returns claimable entries with a single-step txParams array', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        address: '0xabcdefabcdef0123456789abcdef0123456789ab',
        positions: [
          {
            positionId: 'pid',
            speculationId: '42',
            description: 'A moneyline — Won (≈ $191.00)',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 191,
            estimatedPayoutWei6: '191000000',
            txParams: [
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '42', positionType: 0 },
              },
            ],
          },
        ],
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const params = await client.positions.claimParams('0xABCDEFabcdef0123456789ABCDEF0123456789AB');
    expect(params.positions).toHaveLength(1);
    expect(params.positions[0]!.bucket).toBe('claimable');
    expect(params.positions[0]!.txParams).toHaveLength(1);
    expect(params.positions[0]!.txParams[0]!.method).toBe('claimPosition');
  });

  it('positions.claimParams returns pendingSettle entries with a settle+claim txParams array', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        address: '0xabcdefabcdef0123456789abcdef0123456789ab',
        positions: [
          {
            positionId: 'pid',
            speculationId: '99',
            description: 'A moneyline — Won (≈ $50.00, needs settle)',
            bucket: 'pendingSettle',
            result: 'won',
            estimatedPayoutUSDC: 50,
            estimatedPayoutWei6: '50000000',
            txParams: [
              {
                method: 'settleSpeculation',
                target: 'SpeculationModule',
                args: { speculationId: '99' },
              },
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '99', positionType: 0 },
              },
            ],
          },
        ],
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const params = await client.positions.claimParams('0xABCDEFabcdef0123456789ABCDEF0123456789AB');
    expect(params.positions).toHaveLength(1);
    expect(params.positions[0]!.bucket).toBe('pendingSettle');
    expect(params.positions[0]!.txParams).toHaveLength(2);
    expect(params.positions[0]!.txParams[0]!.method).toBe('settleSpeculation');
    expect(params.positions[0]!.txParams[0]!.target).toBe('SpeculationModule');
    expect(params.positions[0]!.txParams[1]!.method).toBe('claimPosition');
    expect(params.positions[0]!.txParams[1]!.target).toBe('PositionModule');
  });

  it('commitments.list joins array statuses with commas', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        commitments: [],
        pagination: { limit: 100, offset: 0, total: 0, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    await client.commitments.list({ status: ['open', 'partially_filled'], maker: '0x1' });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('status')).toBe('open,partially_filled');
    expect(url.searchParams.get('maker')).toBe('0x1');
  });

  it('non-2xx with an API error envelope throws OspexAPIError with status + apiCode', async () => {
    const { fetch } = makeFetch(() => ({
      status: 404,
      body: { error: 'Contest not found', code: 'NOT_FOUND' },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    await expect(client.markets.get('999')).rejects.toMatchObject({
      name: 'OspexAPIError',
      status: 404,
      apiCode: 'NOT_FOUND',
    });
    await expect(client.markets.get('999')).rejects.toBeInstanceOf(OspexAPIError);
  });

  it('authDomain returns just the domain (M1 surface)', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        domain: {
          name: 'Ospex',
          version: '1',
          chainId: 137,
          verifyingContract: '0xabc',
        },
        network: 'polygon',
        actions: {},
        requestFormat: { description: '', endpoints: {}, example: { action: {}, signature: '' } },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const domain = await client.protocol.authDomain();
    expect(domain).toEqual({
      name: 'Ospex',
      version: '1',
      chainId: 137,
      verifyingContract: '0xabc',
    });
  });

  it('config.public is reachable through the internal api client', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        supabaseUrl: 'https://x.supabase.co',
        supabaseAnonKey: 'sb_publishable_test',
        network: 'polygon',
        chainId: 137,
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const body = await client.api.request<{ supabaseUrl: string }>('/v1/config/public');
    expect(body.supabaseUrl).toBe('https://x.supabase.co');
  });
});
