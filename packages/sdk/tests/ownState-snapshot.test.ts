/**
 * `ownState/snapshot.ts` + `api/ownState.ts` integration tests.
 *
 * Covers:
 *   - end-to-end happy path: mint token → GET /v1/own-state/snapshot → decode
 *     into the public OwnerStateSnapshot;
 *   - wire-shape invariants on the GET (Bearer header is correctly formatted;
 *     cursor flows through to the query string);
 *   - decoder fidelity for the OwnerCommitment mapping (visible vs hidden
 *     branches; isLive predicate; storedStatus fallback for pre-effective-status
 *     core-api builds);
 *   - decoder fidelity for the OwnerPosition discriminated union;
 *   - API rejection passthrough (AUTH_TOKEN_EXPIRED on snapshot returns
 *     OspexAPIError with apiCode preserved);
 *   - pre-network validation refuses bad cursor.
 */

import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import { OspexAPIError, OspexValidationError } from '../src/errors.js';
import { OwnStateApi } from '../src/api/ownState.js';
import { loadOwnStateSnapshot, decodeSnapshot } from '../src/ownState/snapshot.js';
import { KeystoreSigner } from '../src/signers/keystore.js';
import type {
  OwnerCommitmentBody,
  OwnerPositionBody,
  OwnerStateSnapshotBody,
  StreamChallenge,
} from '../src/api/types.js';
import type { Hex } from '../src/types/signer.js';

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const TEST_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Hex;
const MATCHING_MODULE = '0x36bc5693ee30cd65f8dce51bd48bc03815091a26' as Hex;
const CHAIN_ID = 80002 as const;

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

function makeApi(
  responder: (call: RecordedCall) => { status: number; body: unknown },
): { api: ApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fakeFetch: typeof globalThis.fetch = async (url, init) => {
    const body =
      init?.body !== undefined && init.body !== null
        ? JSON.parse(String(init.body))
        : undefined;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const call: RecordedCall = {
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body,
    };
    calls.push(call);
    const result = responder(call);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const api = new ApiClient({ apiUrl: 'https://api.test', fetch: fakeFetch });
  return { api, calls };
}

function freshChallenge(overrides: Partial<StreamChallenge> = {}): StreamChallenge {
  const now = Math.floor(Date.now() / 1000);
  return {
    address: TEST_ADDRESS,
    resource: 'own-state',
    scope: 'read:own-state',
    network: { chainId: CHAIN_ID },
    audience: 'api.ospex.test',
    challengeId: 'GcM1Lkpb7CL6wFCgC5_eIA',
    issuedAt: now,
    expiresAt: now + 180,
    ...overrides,
  };
}

function visibleCommitmentBody(
  overrides: Partial<OwnerCommitmentBody> = {},
): OwnerCommitmentBody {
  return {
    commitmentHash:
      '0x1111111111111111111111111111111111111111111111111111111111111111',
    maker: TEST_ADDRESS,
    contestId: '42',
    scorer: '0x2222222222222222222222222222222222222222',
    lineTicks: 0,
    positionType: 0,
    oddsTick: 200,
    marketType: 'moneyline',
    riskAmount: '10000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '10000000',
    nonce: '1',
    expiry: new Date(Date.now() + 600_000).toISOString(),
    speculationKey: '0x' + 'aa'.repeat(32),
    signature: '0x' + 'bb'.repeat(65),
    status: 'open',
    storedStatus: 'open',
    source: 'sdk',
    network: 'amoy',
    nonceInvalidated: false,
    bookVisible: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function snapshotResponse(
  overrides: Partial<OwnerStateSnapshotBody> = {},
): OwnerStateSnapshotBody {
  return {
    cursor: 'CURSOR_PAGE_1',
    commitments: [],
    positions: [],
    truncated: false,
    positionsTruncated: false,
    ...overrides,
  };
}

describe('OwnStateApi.snapshot — wire shape', () => {
  it('sends Authorization: Bearer header and forwards cursor as query', async () => {
    const { api, calls } = makeApi((call) => {
      if (call.url.includes('/v1/own-state/snapshot')) {
        return { status: 200, body: snapshotResponse() };
      }
      return { status: 500, body: { error: 'unexpected', code: 'INTERNAL_ERROR' } };
    });
    const ownStateApi = new OwnStateApi(api);
    await ownStateApi.snapshot('TOKEN_PAYLOAD.TOKEN_SIG', { cursor: 'PAGE_CURSOR' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.headers.get('Authorization')).toBe('Bearer TOKEN_PAYLOAD.TOKEN_SIG');
    expect(call.url).toMatch(/\/v1\/own-state\/snapshot\?cursor=PAGE_CURSOR$/);
  });

  it('omits the cursor query param entirely when not supplied', async () => {
    const { api, calls } = makeApi(() => ({ status: 200, body: snapshotResponse() }));
    const ownStateApi = new OwnStateApi(api);
    await ownStateApi.snapshot('TOKEN');
    const call = calls[0]!;
    expect(call.url).toBe('https://api.test/v1/own-state/snapshot');
    expect(call.url).not.toMatch(/cursor=/);
  });

  it('refuses an empty token before any network call', async () => {
    const { api, calls } = makeApi(() => ({ status: 500, body: {} }));
    const ownStateApi = new OwnStateApi(api);
    await expect(ownStateApi.snapshot('')).rejects.toBeInstanceOf(OspexValidationError);
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty cursor before any network call', async () => {
    const { api, calls } = makeApi(() => ({ status: 500, body: {} }));
    const ownStateApi = new OwnStateApi(api);
    await expect(
      ownStateApi.snapshot('TOKEN', { cursor: '' }),
    ).rejects.toBeInstanceOf(OspexValidationError);
    expect(calls).toHaveLength(0);
  });

  it('surfaces 401 AUTH_TOKEN_EXPIRED with apiCode preserved', async () => {
    const { api } = makeApi(() => ({
      status: 401,
      body: { error: 'Stream token rejected: expired.', code: 'AUTH_TOKEN_EXPIRED' },
    }));
    const ownStateApi = new OwnStateApi(api);
    let thrown: unknown;
    try {
      await ownStateApi.snapshot('TOKEN');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OspexAPIError);
    expect((thrown as OspexAPIError).status).toBe(401);
    expect((thrown as OspexAPIError).apiCode).toBe('AUTH_TOKEN_EXPIRED');
  });
});

describe('decodeSnapshot — wire → public', () => {
  it('decodes a visible commitment with isLive=true and visibility=visible', () => {
    const body = snapshotResponse({
      commitments: [visibleCommitmentBody({ bookVisible: true })],
    });
    const out = decodeSnapshot(body);
    expect(out.commitments).toHaveLength(1);
    const c = out.commitments[0]!;
    expect(c.ownerAuthorized).toBe(true);
    expect(c.visibility).toBe('visible');
    expect(c.redacted).toBe(false);
    expect(c.signature).toBe('0x' + 'bb'.repeat(65));
    expect(c.isLive).toBe(true);
  });

  it('decodes a hidden commitment with full payload + visibility=hidden', () => {
    const body = snapshotResponse({
      commitments: [visibleCommitmentBody({ bookVisible: false })],
    });
    const out = decodeSnapshot(body);
    const c = out.commitments[0]!;
    expect(c.visibility).toBe('hidden');
    expect(c.redacted).toBe(false);
    expect(c.ownerAuthorized).toBe(true);
    // CRITICAL: owner-auth always carries the matchable payload regardless
    // of book_visible — this is the whole point of the surface.
    expect(c.signature).toBe('0x' + 'bb'.repeat(65));
    expect(c.nonce).toBe('1');
    expect(c.oddsTick).toBe(200);
    expect(c.riskAmount).toBe('10000000');
  });

  it('isLive=false on a past-expiry commitment even though storedStatus=open', () => {
    const body = snapshotResponse({
      commitments: [
        visibleCommitmentBody({
          expiry: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
    });
    const out = decodeSnapshot(body);
    expect(out.commitments[0]!.isLive).toBe(false);
  });

  it('isLive=false on a nonce-invalidated commitment', () => {
    const body = snapshotResponse({
      commitments: [visibleCommitmentBody({ nonceInvalidated: true })],
    });
    const out = decodeSnapshot(body);
    expect(out.commitments[0]!.isLive).toBe(false);
  });

  it('isLive=false when remainingRiskAmount is 0', () => {
    const body = snapshotResponse({
      commitments: [
        visibleCommitmentBody({
          remainingRiskAmount: '0',
          filledRiskAmount: '10000000',
          storedStatus: 'partially_filled',
        }),
      ],
    });
    const out = decodeSnapshot(body);
    expect(out.commitments[0]!.isLive).toBe(false);
  });

  it('falls back storedStatus to status on pre-effective-status core-api builds', () => {
    const body = snapshotResponse({
      commitments: [
        visibleCommitmentBody({ storedStatus: undefined, status: 'open' }),
      ],
    });
    const out = decodeSnapshot(body);
    expect(out.commitments[0]!.storedStatus).toBe('open');
  });

  it('decodes each OwnerPosition status branch with full discriminant fields', () => {
    const positions: OwnerPositionBody[] = [
      {
        status: 'active',
        positionId: '1_0xabc_0',
        speculationId: '1',
        positionType: 0,
        team: 'A',
        opponent: 'B',
        market: 'moneyline',
        oddsDecimal: 2,
        riskAmountUSDC: 10,
        profitAmountUSDC: 10,
      },
      {
        status: 'pendingSettle',
        positionId: '2_0xabc_1',
        speculationId: '2',
        positionType: 1,
        team: 'B',
        opponent: 'A',
        market: 'spread',
        oddsDecimal: 1.91,
        riskAmountUSDC: 5,
        profitAmountUSDC: 4.55,
        result: 'won',
        predictedWinSide: 'home',
        estimatedPayoutUSDC: 9.55,
        estimatedPayoutWei6: '9550000',
      },
      {
        status: 'claimable',
        positionId: '3_0xabc_0',
        speculationId: '3',
        positionType: 0,
        team: 'A',
        opponent: 'B',
        market: 'total',
        oddsDecimal: 2,
        riskAmountUSDC: 1,
        profitAmountUSDC: 1,
        result: 'push',
        estimatedPayoutUSDC: 1,
        estimatedPayoutWei6: '1000000',
      },
      {
        status: 'claimed',
        positionId: '4_0xabc_0',
        speculationId: '4',
        positionType: 0,
        team: 'A',
        opponent: 'B',
        market: 'moneyline',
        oddsDecimal: 2,
        riskAmountUSDC: 1,
        profitAmountUSDC: 1,
        claimedAt: '2025-01-01T00:00:00Z',
      },
    ];
    const body = snapshotResponse({ positions });
    const out = decodeSnapshot(body);
    expect(out.positions.map((p) => p.status)).toEqual([
      'active',
      'pendingSettle',
      'claimable',
      'claimed',
    ]);
    expect(
      out.positions.find((p) => p.status === 'pendingSettle')?.predictedWinSide,
    ).toBe('home');
    expect(out.positions.find((p) => p.status === 'claimed')?.claimedAt).toBe(
      '2025-01-01T00:00:00Z',
    );
  });
});

describe('loadOwnStateSnapshot — full composer', () => {
  it('mints token then GETs snapshot with the Bearer header populated', async () => {
    const challenge = freshChallenge();
    const { api, calls } = makeApi((call) => {
      if (call.url.endsWith('/v1/auth/stream-challenge')) {
        return { status: 200, body: { challenge, expiresAt: challenge.expiresAt } };
      }
      if (call.url.endsWith('/v1/auth/stream-token')) {
        return {
          status: 200,
          body: { token: 'PAYLOAD.SIG', expiresAt: challenge.issuedAt + 900 },
        };
      }
      if (call.url.includes('/v1/own-state/snapshot')) {
        // Bearer present + matches what we minted.
        expect(call.headers.get('Authorization')).toBe('Bearer PAYLOAD.SIG');
        return {
          status: 200,
          body: snapshotResponse({
            commitments: [visibleCommitmentBody()],
          }),
        };
      }
      return { status: 500, body: { error: 'unexpected', code: 'INTERNAL_ERROR' } };
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const result = await loadOwnStateSnapshot({
      api,
      signer,
      address: TEST_ADDRESS,
      chainId: CHAIN_ID,
      matchingModule: MATCHING_MODULE,
    });
    expect(result.commitments).toHaveLength(1);
    expect(result.commitments[0]!.visibility).toBe('visible');
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.test/v1/auth/stream-challenge',
      'https://api.test/v1/auth/stream-token',
      'https://api.test/v1/own-state/snapshot',
    ]);
  });

  it('forwards cursor on subsequent pages', async () => {
    const challenge = freshChallenge();
    const { api, calls } = makeApi((call) => {
      if (call.url.endsWith('/v1/auth/stream-challenge')) {
        return { status: 200, body: { challenge, expiresAt: challenge.expiresAt } };
      }
      if (call.url.endsWith('/v1/auth/stream-token')) {
        return {
          status: 200,
          body: { token: 'PAYLOAD.SIG', expiresAt: challenge.issuedAt + 900 },
        };
      }
      if (call.url.includes('/v1/own-state/snapshot')) {
        return {
          status: 200,
          body: snapshotResponse({ cursor: 'NEXT_PAGE', truncated: false }),
        };
      }
      return { status: 500, body: { error: 'unexpected', code: 'INTERNAL_ERROR' } };
    });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    await loadOwnStateSnapshot({
      api,
      signer,
      address: TEST_ADDRESS,
      chainId: CHAIN_ID,
      matchingModule: MATCHING_MODULE,
      cursor: 'PAGE_2_CURSOR',
    });
    const snapshotCall = calls.find((c) => c.url.includes('/v1/own-state/snapshot'))!;
    expect(snapshotCall.url).toMatch(/cursor=PAGE_2_CURSOR$/);
  });
});
