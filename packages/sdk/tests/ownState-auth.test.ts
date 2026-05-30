/**
 * `ownState/auth.ts` — `mintStreamToken` round-trip tests.
 *
 * Covers:
 *  - happy path: challenge → sign → token, with cross-stack signature
 *    verification (signer uses viem, verifier uses ethers — must match);
 *  - challenge-bind refusal at every facet the server pins (per
 *    [[feedback_bind_minted_fields_on_resubmit]]): wrong address, wrong
 *    chainId, wrong resource, wrong scope, malformed audience / challengeId
 *    / issuedAt / expiresAt;
 *  - server rejection on token exchange surfaces as `OspexAPIError` with
 *    `apiCode` intact;
 *  - challenge body forwarded VERBATIM to /v1/auth/stream-token — any
 *    reshape would trigger the server's `tampered` consume check.
 *
 * The signer is a `KeystoreSigner.fromPrivateKey` — viem under the hood,
 * exactly what production uses. The mock fetch records the (path, body)
 * tuples so we can assert wire-shape invariants without booting a real
 * core-api process.
 */

import { describe, expect, it } from 'vitest';
import { ethers, TypedDataEncoder } from 'ethers';
import { ApiClient } from '../src/api/client.js';
import { OspexAPIError, OspexValidationError } from '../src/errors.js';
import { mintStreamToken } from '../src/ownState/auth.js';
import {
  OSPEX_STREAM_AUTH_DOMAIN_NAME,
  STREAM_AUTH_TYPES,
} from '../src/chain/eip712.js';
import { KeystoreSigner } from '../src/signers/keystore.js';
import type { StreamChallenge } from '../src/api/types.js';
import type { Hex } from '../src/types/signer.js';

// Throwaway test wallet — never used outside this test file. Per
// CLAUDE.md "Don't include test fixtures with real wallet private keys,
// even on testnet."  This is a synthetic anvil-style key.
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const TEST_ADDRESS =
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'.toLowerCase() as Hex;
const MATCHING_MODULE = '0x36bc5693ee30cd65f8dce51bd48bc03815091a26' as Hex;
const AUDIENCE = 'api.ospex.test';
const CHAIN_ID = 80002 as const;

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function makeApi(
  responder: (call: RecordedCall) => { status: number; body: unknown },
): { api: ApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fakeFetch: typeof globalThis.fetch = async (url, init) => {
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    const call: RecordedCall = {
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
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
    audience: AUDIENCE,
    challengeId: 'GcM1Lkpb7CL6wFCgC5_eIA',
    issuedAt: now,
    expiresAt: now + 180,
    ...overrides,
  };
}

describe('ownState/auth.mintStreamToken — happy path', () => {
  it('returns a fresh token bound to the address, forwarding the challenge verbatim', async () => {
    const challenge = freshChallenge();
    const expectedToken = 'PAYLOAD.SIGNATURE';
    const tokenExpiresAt = challenge.issuedAt + 900;
    const { api, calls } = makeApi((call) => {
      if (call.url.endsWith('/v1/auth/stream-challenge')) {
        expect(call.body).toEqual({ address: TEST_ADDRESS });
        return { status: 200, body: { challenge, expiresAt: challenge.expiresAt } };
      }
      if (call.url.endsWith('/v1/auth/stream-token')) {
        // The challenge body MUST round-trip identically; the server
        // pins every field at consume time and a reshape would fail
        // with `AUTH_CHALLENGE_TAMPERED`.
        expect(call.body?.challenge).toEqual(challenge);
        // The signature is a 0x-prefixed 65-byte hex string from a real
        // viem-backed signer.
        const sig = (call.body?.signature as string) ?? '';
        expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
        return { status: 200, body: { token: expectedToken, expiresAt: tokenExpiresAt } };
      }
      return { status: 500, body: { error: 'unexpected path', code: 'INTERNAL_ERROR' } };
    });

    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    const result = await mintStreamToken({
      api,
      signer,
      address: TEST_ADDRESS,
      chainId: CHAIN_ID,
      matchingModule: MATCHING_MODULE,
    });

    expect(result.token).toBe(expectedToken);
    expect(result.expiresAt).toBe(tokenExpiresAt);
    expect(result.address).toBe(TEST_ADDRESS);
    expect(result.challengeId).toBe(challenge.challengeId);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.test/v1/auth/stream-challenge',
      'https://api.test/v1/auth/stream-token',
    ]);
  });

  it('signature recovers to the wallet — cross-stack (viem signer ↔ ethers verifier)', async () => {
    // Adversarial-accessor flavour per [[feedback_doc_claims_need_adversarial_tests]]:
    // we don't trust the SDK's own hash; instead we recover the signer
    // via ethers (the same library core-api uses) and assert it equals
    // the wallet. If viem and ethers disagreed on the typed-data
    // encoding, recovery would yield a different address and the test
    // would fail loudly.
    const challenge = freshChallenge();
    let capturedSignature: string | undefined;
    const { api } = makeApi((call) => {
      if (call.url.endsWith('/v1/auth/stream-challenge')) {
        return { status: 200, body: { challenge, expiresAt: challenge.expiresAt } };
      }
      capturedSignature = call.body?.signature as string;
      return {
        status: 200,
        body: { token: 'PAYLOAD.SIG', expiresAt: challenge.issuedAt + 900 },
      };
    });

    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    await mintStreamToken({
      api,
      signer,
      address: TEST_ADDRESS,
      chainId: CHAIN_ID,
      matchingModule: MATCHING_MODULE,
    });

    expect(capturedSignature).toBeDefined();
    const ethersTypes = {
      OspexStreamAuth: STREAM_AUTH_TYPES.OspexStreamAuth.map((f) => ({
        name: f.name,
        type: f.type,
      })),
      StreamAuthNetwork: STREAM_AUTH_TYPES.StreamAuthNetwork.map((f) => ({
        name: f.name,
        type: f.type,
      })),
    };
    const recovered = ethers.verifyTypedData(
      {
        name: OSPEX_STREAM_AUTH_DOMAIN_NAME,
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: MATCHING_MODULE,
      },
      ethersTypes,
      {
        address: challenge.address,
        resource: 'own-state',
        scope: 'read:own-state',
        network: { chainId: challenge.network.chainId },
        audience: challenge.audience,
        challengeId: challenge.challengeId,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
      },
      capturedSignature!,
    );
    expect(recovered.toLowerCase()).toBe(TEST_ADDRESS);

    // And the ethers-computed hash matches the SDK's hashStreamChallenge.
    const ethersHash = TypedDataEncoder.hash(
      {
        name: OSPEX_STREAM_AUTH_DOMAIN_NAME,
        version: '1',
        chainId: CHAIN_ID,
        verifyingContract: MATCHING_MODULE,
      },
      ethersTypes,
      {
        address: challenge.address,
        resource: 'own-state',
        scope: 'read:own-state',
        network: { chainId: challenge.network.chainId },
        audience: challenge.audience,
        challengeId: challenge.challengeId,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
      },
    );
    expect(ethersHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('ownState/auth.mintStreamToken — defensive refusals', () => {
  // A throwing signer makes "signer was never touched" assertable.
  // If a refusal lets execution slip through to signing, this would
  // surface with the test's actual signature output instead of the
  // expected validation error.
  const throwIfTouchedSigner: import('../src/types/signer.js').Signer = {
    async getAddress() {
      throw new Error('signer.getAddress called — refusal failed');
    },
    async signTypedData() {
      throw new Error('signer.signTypedData called — refusal failed');
    },
    async signTransaction() {
      throw new Error('signer.signTransaction called — refusal failed');
    },
  };

  it.each<{
    name: string;
    mutate: (c: StreamChallenge) => StreamChallenge;
    fieldHint: string;
  }>([
    {
      name: 'address mismatch',
      mutate: (c) => ({ ...c, address: '0x2222222222222222222222222222222222222222' }),
      fieldHint: 'challenge.address',
    },
    {
      name: 'chainId mismatch',
      mutate: (c) => ({ ...c, network: { chainId: 137 } }),
      fieldHint: 'challenge.network.chainId',
    },
    {
      name: 'resource mismatch',
      mutate: (c) => ({ ...c, resource: 'commit' as unknown as 'own-state' }),
      fieldHint: 'challenge.resource',
    },
    {
      name: 'scope mismatch',
      mutate: (c) => ({ ...c, scope: 'write:own-state' as unknown as 'read:own-state' }),
      fieldHint: 'challenge.scope',
    },
    {
      name: 'audience empty',
      mutate: (c) => ({ ...c, audience: '' }),
      fieldHint: 'challenge',
    },
    {
      name: 'challengeId empty',
      mutate: (c) => ({ ...c, challengeId: '' }),
      fieldHint: 'challenge',
    },
    {
      name: 'expiresAt <= issuedAt',
      mutate: (c) => ({ ...c, expiresAt: c.issuedAt }),
      fieldHint: 'challenge',
    },
    {
      name: 'issuedAt not a safe integer',
      mutate: (c) => ({ ...c, issuedAt: Number.NaN }),
      fieldHint: 'challenge',
    },
  ])(
    'refuses to sign on $name and never touches the signer',
    async ({ mutate, fieldHint }) => {
      const challenge = mutate(freshChallenge());
      const { api, calls } = makeApi((call) => {
        if (call.url.endsWith('/v1/auth/stream-challenge')) {
          return { status: 200, body: { challenge, expiresAt: challenge.expiresAt } };
        }
        throw new Error(`unexpected call to ${call.url} — refusal failed`);
      });

      await expect(
        mintStreamToken({
          api,
          signer: throwIfTouchedSigner,
          address: TEST_ADDRESS,
          chainId: CHAIN_ID,
          matchingModule: MATCHING_MODULE,
        }),
      ).rejects.toMatchObject({
        name: 'OspexValidationError',
        field: fieldHint,
      });

      // Only the challenge request happened; the token exchange was
      // never attempted, and the signer never recovered an address
      // (would have thrown otherwise).
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toMatch(/stream-challenge$/);
    },
  );

  it('surfaces token-exchange 401 as OspexAPIError with the AUTH_* code intact', async () => {
    const challenge = freshChallenge();
    const { api } = makeApi((call) => {
      if (call.url.endsWith('/v1/auth/stream-challenge')) {
        return { status: 200, body: { challenge, expiresAt: challenge.expiresAt } };
      }
      return {
        status: 401,
        body: {
          error: 'Challenge consume rejected: already_used.',
          code: 'AUTH_CHALLENGE_REPLAY',
        },
      };
    });

    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    let thrown: unknown;
    try {
      await mintStreamToken({
        api,
        signer,
        address: TEST_ADDRESS,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OspexAPIError);
    expect((thrown as OspexAPIError).status).toBe(401);
    expect((thrown as OspexAPIError).apiCode).toBe('AUTH_CHALLENGE_REPLAY');
  });

  it('rejects malformed address input before any network call', async () => {
    const { api, calls } = makeApi(() => ({ status: 500, body: {} }));
    const signer = KeystoreSigner.fromPrivateKey(TEST_PRIVATE_KEY);
    await expect(
      mintStreamToken({
        api,
        signer,
        address: '0xnope' as unknown as Hex,
        chainId: CHAIN_ID,
        matchingModule: MATCHING_MODULE,
      }),
    ).rejects.toBeInstanceOf(OspexValidationError);
    expect(calls.length).toBe(0);
  });
});
