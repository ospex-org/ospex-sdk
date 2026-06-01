/**
 * `ownState/getCommitment.ts` — snapshot-scope recovery helper tests.
 *
 * Covers:
 *   - found on first page → OwnerCommitment;
 *   - found on later page (pagination drives forward) → OwnerCommitment;
 *   - drained without finding → null (per Hermes-locked framing: null means
 *     "outside snapshot scope", NOT "doesn't exist");
 *   - exactly ONE token mint regardless of page count;
 *   - cursor flows forward between pages;
 *   - malformed hash → OspexValidationError, never touches the network
 *     (signer NEVER touched per [[feedback_doc_claims_need_adversarial_tests]]);
 *   - case-insensitive hash match (server returns lowercase; caller may pass mixed).
 */

import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import { OspexOwnStateError, OspexValidationError } from '../src/errors.js';
import { getOwnerCommitment } from '../src/ownState/getCommitment.js';
import { KeystoreSigner } from '../src/signers/keystore.js';
import type {
  OwnerCommitmentBody,
  OwnerStateSnapshotBody,
  StreamChallenge,
} from '../src/api/types.js';
import type { Hex, Signer } from '../src/types/signer.js';

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const TEST_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' as Hex;
const MATCHING_MODULE = '0x36bc5693ee30cd65f8dce51bd48bc03815091a26' as Hex;
const CHAIN_ID = 80002 as const;

const HASH_A =
  '0xaaaa111111111111111111111111111111111111111111111111111111111111' as Hex;
const HASH_B =
  '0xbbbb222222222222222222222222222222222222222222222222222222222222' as Hex;
const HASH_C =
  '0xcccc333333333333333333333333333333333333333333333333333333333333' as Hex;
const HASH_MISSING =
  '0xdead444444444444444444444444444444444444444444444444444444444444' as Hex;

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
}

function makeApi(
  responder: (call: RecordedCall) => { status: number; body: unknown },
): { api: ApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fakeFetch: typeof globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const call: RecordedCall = {
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
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

function freshChallenge(): StreamChallenge {
  const now = Math.floor(Date.now() / 1000);
  return {
    address: TEST_ADDRESS,
    resource: 'own-state',
    scope: 'read:own-state',
    network: { chainId: CHAIN_ID },
    audience: 'api.ospex.test',
    challengeId: 'CHALLENGE_ID',
    issuedAt: now,
    expiresAt: now + 180,
  };
}

function commitment(hash: Hex, overrides: Partial<OwnerCommitmentBody> = {}): OwnerCommitmentBody {
  return {
    commitmentHash: hash,
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
    // PR0b enrichment
    speculationId: '1',
    sport: 'americanfootball_nfl',
    awayTeam: 'Away',
    homeTeam: 'Home',
    updatedAtUnixSec: 1735700000,
    signedPayload: null,
    ...overrides,
  };
}

function page(
  commitments: OwnerCommitmentBody[],
  truncated: boolean,
  cursor: string,
): OwnerStateSnapshotBody {
  return {
    cursor,
    commitments,
    positions: [],
    truncated,
    positionsTruncated: false,
  };
}

/**
 * Build a fake server that walks through a fixed sequence of snapshot pages.
 * Each `/v1/own-state/snapshot` call returns the next page; auth endpoints
 * are stubbed to mint exactly ONE token regardless of page count.
 */
function makeServerWithPages(pages: OwnerStateSnapshotBody[]): {
  api: ApiClient;
  calls: RecordedCall[];
  snapshotCallCount: () => number;
  tokenMintCount: () => number;
} {
  let pageIdx = 0;
  let tokenMints = 0;
  const challenge = freshChallenge();
  const { api, calls } = makeApi((call) => {
    if (call.url.endsWith('/v1/auth/stream-challenge')) {
      return { status: 200, body: { challenge, expiresAt: challenge.expiresAt } };
    }
    if (call.url.endsWith('/v1/auth/stream-token')) {
      tokenMints += 1;
      return {
        status: 200,
        body: { token: 'BEARER', expiresAt: challenge.issuedAt + 900 },
      };
    }
    if (call.url.includes('/v1/own-state/snapshot')) {
      const p = pages[pageIdx] ?? pages[pages.length - 1]!;
      pageIdx += 1;
      return { status: 200, body: p };
    }
    return { status: 500, body: { error: 'unexpected', code: 'INTERNAL_ERROR' } };
  });
  return {
    api,
    calls,
    snapshotCallCount: () =>
      calls.filter((c) => c.url.includes('/v1/own-state/snapshot')).length,
    tokenMintCount: () => tokenMints,
  };
}

describe('getOwnerCommitment — found and not-found', () => {
  it('returns OwnerCommitment when the hash is on the first page', async () => {
    const server = makeServerWithPages([
      page([commitment(HASH_A), commitment(HASH_B)], false, 'LIVE'),
    ]);
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const result = await getOwnerCommitment({
      api: server.api,
      signer,
      address: TEST_ADDRESS,
      chainId: CHAIN_ID,
      matchingModule: MATCHING_MODULE,
      hash: HASH_B,
    });
    expect(result).not.toBeNull();
    expect(result!.commitmentHash.toLowerCase()).toBe(HASH_B);
    expect(result!.ownerAuthorized).toBe(true);
    expect(server.snapshotCallCount()).toBe(1);
    expect(server.tokenMintCount()).toBe(1);
  });

  it('pages forward and returns OwnerCommitment when the hash is on a later page', async () => {
    const server = makeServerWithPages([
      page([commitment(HASH_A)], true, 'PAGE_1_CURSOR'),
      page([commitment(HASH_B)], true, 'PAGE_2_CURSOR'),
      page([commitment(HASH_C)], false, 'LIVE'),
    ]);
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const result = await getOwnerCommitment({
      api: server.api,
      signer,
      address: TEST_ADDRESS,
      chainId: CHAIN_ID,
      matchingModule: MATCHING_MODULE,
      hash: HASH_C,
    });
    expect(result).not.toBeNull();
    expect(result!.commitmentHash.toLowerCase()).toBe(HASH_C);
    // Three pages consumed; exactly one token mint shared across them.
    expect(server.snapshotCallCount()).toBe(3);
    expect(server.tokenMintCount()).toBe(1);
    // Cursor flows: page 2 + page 3 carry the prior page's cursor.
    const snapshotCalls = server.calls.filter((c) =>
      c.url.includes('/v1/own-state/snapshot'),
    );
    expect(snapshotCalls[0]!.url).not.toMatch(/cursor=/);
    expect(snapshotCalls[1]!.url).toMatch(/cursor=PAGE_1_CURSOR$/);
    expect(snapshotCalls[2]!.url).toMatch(/cursor=PAGE_2_CURSOR$/);
  });

  it('returns null when the snapshot drains without finding the hash', async () => {
    // Two pages, neither contains HASH_MISSING. Drains naturally.
    const server = makeServerWithPages([
      page([commitment(HASH_A)], true, 'PAGE_1'),
      page([commitment(HASH_B), commitment(HASH_C)], false, 'LIVE'),
    ]);
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const result = await getOwnerCommitment({
      api: server.api,
      signer,
      address: TEST_ADDRESS,
      chainId: CHAIN_ID,
      matchingModule: MATCHING_MODULE,
      hash: HASH_MISSING,
    });
    expect(result).toBeNull();
    expect(server.snapshotCallCount()).toBe(2);
  });

  it('matches case-insensitively when the caller supplies a mixed-case hash', async () => {
    const server = makeServerWithPages([
      page([commitment(HASH_A)], false, 'LIVE'),
    ]);
    // Body uppercased, '0x' prefix kept lowercase — exercises the
    // case-insensitive search in the loop body while still satisfying
    // HASH_PATTERN (which requires the literal '0x' prefix).
    const upper = ('0x' + HASH_A.slice(2).toUpperCase()) as Hex;
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const result = await getOwnerCommitment({
      api: server.api,
      signer,
      address: TEST_ADDRESS,
      chainId: CHAIN_ID,
      matchingModule: MATCHING_MODULE,
      hash: upper,
    });
    expect(result).not.toBeNull();
    expect(result!.commitmentHash.toLowerCase()).toBe(HASH_A);
  });
});

describe('getOwnerCommitment — page-cap exhaustion is UNKNOWN, not null', () => {
  it('throws OspexOwnStateError({reason: "scan_limit_exceeded"}) after 50 truncated pages without finding the hash', async () => {
    // Simulate a pathological server that keeps returning truncated:true
    // forever. The helper's defensive page bound (MAX_SNAPSHOT_PAGES=50)
    // must fire — but instead of returning `null` (which would mis-classify
    // the unknown verdict as "outside snapshot scope" and let an MM
    // cancel path act on the wrong assumption), it MUST throw a typed
    // OspexOwnStateError so the caller has to make a deliberate choice.
    const TRUNCATED_FOREVER: OwnerStateSnapshotBody = {
      cursor: 'NEVER_DRAINS',
      // No matching hash anywhere — but each page reports truncated:true.
      commitments: [commitment(HASH_A)],
      positions: [],
      truncated: true,
      positionsTruncated: false,
    };
    let tokenMints = 0;
    let snapshotCalls = 0;
    const challenge = freshChallenge();
    const fakeFetch: typeof globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith('/v1/auth/stream-challenge')) {
        return new Response(
          JSON.stringify({ challenge, expiresAt: challenge.expiresAt }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.endsWith('/v1/auth/stream-token')) {
        tokenMints += 1;
        return new Response(
          JSON.stringify({ token: 'BEARER', expiresAt: challenge.issuedAt + 900 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.includes('/v1/own-state/snapshot')) {
        snapshotCalls += 1;
        return new Response(JSON.stringify(TRUNCATED_FOREVER), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Mark the init parameter as intentionally unused.
      void init;
      return new Response(JSON.stringify({ error: 'unexpected', code: 'INTERNAL_ERROR' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const api = new ApiClient({ apiUrl: 'https://api.test', fetch: fakeFetch });
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);

    let thrown: unknown;
    try {
      await getOwnerCommitment({
        api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
        hash: HASH_MISSING,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OspexOwnStateError);
    expect((thrown as OspexOwnStateError).reason).toBe('scan_limit_exceeded');
    expect((thrown as OspexOwnStateError).pagesScanned).toBe(50);
    // EXACTLY one token mint across the 50-page scan.
    expect(tokenMints).toBe(1);
    // The scan walked the full 50-page bound before throwing.
    expect(snapshotCalls).toBe(50);
  });
});

describe('getOwnerCommitment — refusals never touch the signer', () => {
  // Adversarial: a signer that throws if invoked would surface as the test's
  // failure mode (per [[feedback_doc_claims_need_adversarial_tests]]). The
  // pre-network refusals must NOT reach signing.
  const throwIfTouched: Signer = {
    async getAddress() {
      throw new Error('getAddress called — refusal failed');
    },
    async signTypedData() {
      throw new Error('signTypedData called — refusal failed');
    },
    async signTransaction() {
      throw new Error('signTransaction called — refusal failed');
    },
  };

  it.each<{ name: string; hash: string }>([
    { name: 'too short', hash: '0x1234' },
    { name: 'missing 0x prefix', hash: 'a'.repeat(64) },
    { name: 'non-hex chars', hash: '0x' + 'g'.repeat(64) },
    { name: 'empty string', hash: '' },
  ])('refuses on $name and never makes a network call', async ({ hash }) => {
    const server = makeServerWithPages([page([], false, 'LIVE')]);
    await expect(
      getOwnerCommitment({
        api: server.api,
        signer: throwIfTouched,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
        hash: hash as Hex,
      }),
    ).rejects.toBeInstanceOf(OspexValidationError);
    expect(server.calls).toHaveLength(0);
  });
});
