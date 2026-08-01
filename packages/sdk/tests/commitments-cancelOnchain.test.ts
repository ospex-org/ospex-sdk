/**
 * `client.commitments.cancelOnchain({ hash } | { signedCommitment } | { commitment }, recoverHidden?)`
 * + `client.commitments.cancelOnchainSigned(payload)` — happy paths,
 * validation errors, mutually-exclusive args, hash↔struct round-trip,
 * idempotent re-cancel, the two error-classification paths for
 * `MatchingModule__NotCommitmentMaker` (structured + raw selector), and the
 * { commitment } overload + owner-auth book-hidden recovery (incl. the
 * requested-hash binding on both the visible and recovery paths).
 *
 * Same fake-publicClient + fake-signer pattern as positions-claim.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  keccak256,
  toBytes,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { cancelOnchain } from '../src/commitments/cancelOnchain.js';
import { buildDomain, hashCommitment, type OspexCommitmentMessage } from '../src/chain/eip712.js';
import { NonceCounter } from '../src/commitments/context.js';
import { OspexAPIError, OspexChainError, OspexValidationError } from '../src/errors.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { CommitmentBody } from '../src/api/types.js';
import type { Signer } from '../src/types/signer.js';

const SIGNER_ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';
const MATCHING_MODULE = ('0x' + '11'.repeat(20)) as `0x${string}`;
const CHAIN_ID = 137 as const;

// The EIP-712 struct the default fixture body reconstructs to. HASH is its hash under
// the test domain (CHAIN_ID + MATCHING_MODULE), so the default body round-trips exactly
// like a real API row would — cancelOnchain's reconstruction assertion passes. Tests that
// need a mismatch mutate a struct field (see the reconstruction-mismatch test). Keep these
// values in sync with the string fields in `fullCommitmentBody` below.
const BODY_STRUCT: OspexCommitmentMessage = {
  maker: SIGNER_ADDR as `0x${string}`,
  contestId: 42n,
  scorer: ('0xdd' + 'aa'.repeat(19)) as `0x${string}`,
  lineTicks: -35,
  positionType: 0,
  oddsTick: 191,
  riskAmount: 1_000_000n,
  nonce: 1_700_000_000n,
  expiry: BigInt(Math.floor(new Date('2099-01-01T00:00:00.000Z').getTime() / 1000)),
};
const HASH = hashCommitment(buildDomain(CHAIN_ID, MATCHING_MODULE), BODY_STRUCT);

const NOT_MAKER_SELECTOR = keccak256(toBytes('MatchingModule__NotCommitmentMaker()')).slice(0, 10);

function fullCommitmentBody(overrides: Partial<CommitmentBody> = {}): CommitmentBody {
  return {
    commitmentHash: HASH,
    maker: SIGNER_ADDR,
    contestId: '42',
    scorer: '0xdd' + 'aa'.repeat(19),
    lineTicks: -35,
    positionType: 0,
    oddsTick: 191,
    marketType: 'spread',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '1700000000',
    expiry: '2099-01-01T00:00:00.000Z',
    speculationKey: '0x' + 'ee'.repeat(32),
    signature: '0x' + 'cc'.repeat(65),
    status: 'open',
    source: 'agent',
    network: 'polygon',
    nonceInvalidated: false,
    createdAt: '2026-05-04T00:00:00.000Z',
    ...overrides,
  };
}

interface FakeOpts {
  apiResponder?: (path: string) => unknown;
  estimateGasErr?: unknown;
  status?: 'success' | 'reverted';
}

function fakeContext(opts: FakeOpts = {}): { ctx: CommitmentsContext } {
  const txHash = ('0x' + 'aa'.repeat(32)) as Hash;
  const receipt = {
    status: opts.status ?? 'success',
    transactionHash: txHash,
    blockNumber: 12345n,
    logs: [],
  } as unknown as TransactionReceipt;

  const publicClient = {
    sendRawTransaction: async () => txHash,
    waitForTransactionReceipt: async () => receipt,
    getTransactionCount: async () => 7,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 50n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => {
      if (opts.estimateGasErr) throw opts.estimateGasErr;
      return 80_000n;
    },
    readContract: async () => 0n,
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => SIGNER_ADDR as `0x${string}`,
    signTypedData: async () => '0xdead' as `0x${string}`,
    signTransaction: async () => '0xfeed' as `0x${string}`,
  };

  const ctx: CommitmentsContext = {
    api: {
      request: async (path: string) => {
        if (opts.apiResponder) return opts.apiResponder(path);
        return fullCommitmentBody();
      },
    } as unknown as CommitmentsContext['api'],
    requireSigner: () => signer,
    getChainId: () => CHAIN_ID,
    getAddresses: () =>
      ({
        matchingModule: MATCHING_MODULE,
      }) as unknown as ReturnType<CommitmentsContext['getAddresses']>,
    requireChainClient: () => publicClient,
    getContestsApi: unusedAccessor('getContestsApi'),
    getSpeculationsApi: unusedAccessor('getSpeculationsApi'),
    getTeams: unusedAccessor('getTeams'),
    nonceCounter: new NonceCounter(),
  };
  return { ctx };
}

describe('commitments.cancelOnchain', () => {
  it('returns txHash + commitmentHash on success', async () => {
    const { ctx } = fakeContext();
    const result = await cancelOnchain(ctx, { hash: HASH as `0x${string}` });
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.commitmentHash).toBe(HASH);
    expect(result.receipt.blockNumber).toBe(12345n);
  });

  it('rejects a malformed hash before any API/RPC call', async () => {
    const { ctx } = fakeContext();
    await expect(cancelOnchain(ctx, { hash: '0xabc' as `0x${string}` })).rejects.toBeInstanceOf(
      OspexValidationError,
    );
  });

  it('rejects a body with null required fields (indexer-only row)', async () => {
    const { ctx } = fakeContext({
      apiResponder: () => fullCommitmentBody({ scorer: null, lineTicks: null }),
    });
    await expect(cancelOnchain(ctx, { hash: HASH as `0x${string}` })).rejects.toBeInstanceOf(
      OspexValidationError,
    );
  });

  it('propagates 404 from the API as OspexAPIError without sending a tx', async () => {
    let estimateGasCalled = false;
    const { ctx } = fakeContext({
      apiResponder: () => {
        throw new OspexAPIError('not found', { status: 404, apiCode: 'NOT_FOUND' });
      },
    });
    (ctx.requireChainClient() as unknown as { estimateGas: () => Promise<bigint> }).estimateGas =
      async () => {
        estimateGasCalled = true;
        return 0n;
      };
    await expect(cancelOnchain(ctx, { hash: HASH as `0x${string}` })).rejects.toBeInstanceOf(OspexAPIError);
    expect(estimateGasCalled).toBe(false);
  });

  it('throws before gas estimation when the reconstructed struct does not hash to the requested hash', async () => {
    // The API row drifted from the signed payload (mutated riskAmount → different hash).
    // cancelOnchain must refuse before signing / broadcasting rather than set
    // s_cancelledCommitments on a different commitment than the one requested.
    let estimateGasCalled = false;
    const { ctx } = fakeContext({
      apiResponder: () =>
        fullCommitmentBody({ riskAmount: '999999', remainingRiskAmount: '999999' }),
    });
    (ctx.requireChainClient() as unknown as { estimateGas: () => Promise<bigint> }).estimateGas =
      async () => {
        estimateGasCalled = true;
        return 0n;
      };
    await expect(cancelOnchain(ctx, { hash: HASH as `0x${string}` })).rejects.toBeInstanceOf(
      OspexValidationError,
    );
    expect(estimateGasCalled).toBe(false);
  });

  it('idempotent: cancelling an already-cancelled commitment still succeeds (no AlreadyCancelled revert)', async () => {
    // The contract has no AlreadyCancelled guard — the SDK MUST NOT
    // synthesize one. Status='cancelled' on the row is fine; the tx
    // just rewrites s_cancelledCommitments[hash]=true and re-emits.
    const { ctx } = fakeContext({
      apiResponder: () => fullCommitmentBody({ status: 'cancelled' }),
    });
    const result = await cancelOnchain(ctx, { hash: HASH as `0x${string}` });
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('maps structured ContractFunctionRevertedError to reason=NotCommitmentMaker', async () => {
    const revertErr: { name: string; cause: unknown } = {
      name: 'ContractFunctionExecutionError',
      cause: {
        name: 'ContractFunctionRevertedError',
        data: { errorName: 'MatchingModule__NotCommitmentMaker' },
      },
    };
    const { ctx } = fakeContext({ estimateGasErr: revertErr });
    await expect(cancelOnchain(ctx, { hash: HASH as `0x${string}` })).rejects.toMatchObject({
      name: 'OspexChainError',
      reason: 'NotCommitmentMaker',
    });
  });

  it('maps raw revert hex with the NotCommitmentMaker selector to typed reason', async () => {
    const rawErr: { name: string; data: string } = {
      name: 'EstimateGasExecutionError',
      data: NOT_MAKER_SELECTOR,
    };
    const { ctx } = fakeContext({ estimateGasErr: rawErr });
    await expect(cancelOnchain(ctx, { hash: HASH as `0x${string}` })).rejects.toMatchObject({
      name: 'OspexChainError',
      reason: 'NotCommitmentMaker',
    });
  });

  it('wraps unknown reverts as plain OspexChainError without a reason', async () => {
    const { ctx } = fakeContext({ estimateGasErr: new Error('rpc went sideways') });
    const promise = cancelOnchain(ctx, { hash: HASH as `0x${string}` });
    await expect(promise).rejects.toBeInstanceOf(OspexChainError);
    await expect(promise).rejects.toMatchObject({ reason: undefined });
  });

  it('refuses a redacted (book-hidden) response BEFORE touching signer / RPC / gas', async () => {
    // Hidden public bodies omit signature/nonce/risk/odds — letting them through
    // would land in `BigInt(undefined)` and throw `TypeError`. cancelOnchain
    // must route through CommitmentsApi.get → toCommitment → requireVisible so
    // the verdict is a typed OspexValidationError({ field: 'commitment' }).
    // The narrow has to fire BEFORE any signer / chain-client / gas
    // estimation — wire those accessors to throw so the test asserts the
    // ordering as well as the verdict.
    const hiddenWireBody: Record<string, unknown> = {
      redacted: true,
      payloadAvailable: false,
      commitmentHash: HASH,
      maker: SIGNER_ADDR,
      contestId: '42',
      positionType: 0,
      status: 'cancelled',
      storedStatus: 'open',
      filledRiskAmount: '0',
      expiry: '2099-01-01T00:00:00.000Z',
      bookVisible: false,
      nonceInvalidated: false,
    };
    const ctx: CommitmentsContext = {
      api: {
        request: async () => hiddenWireBody,
      } as unknown as CommitmentsContext['api'],
      requireSigner: () => {
        throw new Error('signer must not be accessed for a redacted commitment');
      },
      requireChainClient: () => {
        throw new Error('chain client must not be accessed for a redacted commitment');
      },
      getChainId: () => CHAIN_ID,
      getAddresses: () => {
        throw new Error('addresses must not be accessed for a redacted commitment');
      },
      getContestsApi: unusedAccessor('getContestsApi'),
      getSpeculationsApi: unusedAccessor('getSpeculationsApi'),
      getTeams: unusedAccessor('getTeams'),
      nonceCounter: new NonceCounter(),
    };
    await expect(cancelOnchain(ctx, { hash: HASH as `0x${string}` })).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'commitment',
      message: expect.stringContaining('cancel on chain'),
    });
  });
});

// ─── cancelOnchainSigned (M5/PR2) ────────────────────────────────────────

import { cancelOnchainSigned } from '../src/commitments/cancelOnchain.js';
import type { SignedCommitmentPayload } from '../src/types/commitment.js';

const VALID_SIG = ('0x' + 'cc'.repeat(65)) as `0x${string}`;

function makeSignedPayload(
  overrides: Partial<SignedCommitmentPayload> = {},
): SignedCommitmentPayload {
  return {
    commitmentHash: HASH,
    commitment: { ...BODY_STRUCT },
    signature: VALID_SIG,
    ...overrides,
  };
}

describe('commitments.cancelOnchainSigned — canonical low-level primitive', () => {
  it('broadcasts cancelCommitment with the supplied struct on the happy path', async () => {
    // The payload encodes the same nine struct fields the contract expects;
    // the signature is captured but never re-sent on chain (the contract
    // recomputes the hash from the struct). Mock signer / chain to assert
    // the calldata reaches buildSignAndSend.
    const { ctx } = fakeContext();
    const result = await cancelOnchainSigned(ctx, makeSignedPayload());
    expect(result.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(result.commitmentHash).toBe(HASH.toLowerCase());
    expect(result.receipt.status).toBe('success');
  });

  it('does NOT hit the public commitments API — load-bearing for book-hidden makers', async () => {
    // Hidden rows redact the matchable payload from the anonymous list, so
    // a maker holding the signed payload in local state must be able to
    // cancel without touching CommitmentsApi.get. Wire the API to throw
    // and assert the cancel still lands.
    const { ctx } = fakeContext({
      apiResponder: () => {
        throw new Error('cancelOnchainSigned must not hit the commitments API');
      },
    });
    const result = await cancelOnchainSigned(ctx, makeSignedPayload());
    expect(result.txHash).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('refuses a payload whose struct does not hash to commitmentHash', async () => {
    const { ctx } = fakeContext();
    // Bump the nonce — the recomputed hash will diverge from HASH.
    const bad = makeSignedPayload({
      commitment: { ...BODY_STRUCT, nonce: BODY_STRUCT.nonce + 1n },
    });
    await expect(cancelOnchainSigned(ctx, bad)).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'commitmentHash',
      message: expect.stringContaining('does not match commitmentHash'),
    });
  });

  it('refuses an invalid commitmentHash format', async () => {
    const { ctx } = fakeContext();
    const bad = makeSignedPayload({ commitmentHash: '0xnothex' as `0x${string}` });
    await expect(cancelOnchainSigned(ctx, bad)).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'commitmentHash',
    });
  });

  it('refuses an invalid signature format (length / hex)', async () => {
    const { ctx } = fakeContext();
    // Real EIP-712 sigs are 65 bytes = 130 hex chars; truncated payloads
    // are a programming error, not a contract revert. Surface them clearly.
    const bad = makeSignedPayload({ signature: ('0x' + 'aa') as `0x${string}` });
    await expect(cancelOnchainSigned(ctx, bad)).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'signature',
    });
  });

  it.each([
    ['contestId', { ...BODY_STRUCT, contestId: '42' as unknown as bigint }],
    ['riskAmount', { ...BODY_STRUCT, riskAmount: 1_000_000 as unknown as bigint }],
    ['lineTicks', { ...BODY_STRUCT, lineTicks: '-35' as unknown as number }],
  ])('refuses a malformed commitment.%s (wrong type)', async (_field, badStruct) => {
    const { ctx } = fakeContext();
    await expect(
      cancelOnchainSigned(
        ctx,
        makeSignedPayload({ commitment: badStruct as typeof BODY_STRUCT }),
      ),
    ).rejects.toBeInstanceOf(OspexValidationError);
  });
});

describe('commitments.cancelOnchain — overload routing', () => {
  it('{ signedCommitment } branch delegates to cancelOnchainSigned (no API hit)', async () => {
    // The signed branch is the canonical path; it skips the fetch + narrow
    // entirely. Wire the API to throw so we prove the function never reaches it.
    const { ctx } = fakeContext({
      apiResponder: () => {
        throw new Error('signedCommitment branch must not fetch from the API');
      },
    });
    const result = await cancelOnchain(ctx, {
      signedCommitment: makeSignedPayload(),
    });
    expect(result.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(result.commitmentHash).toBe(HASH.toLowerCase());
  });

  it('throws when MORE THAN ONE branch is supplied (mutually exclusive)', async () => {
    const { ctx } = fakeContext();
    await expect(
      cancelOnchain(ctx, {
        // Use a loose any-cast: the type system already forbids this
        // shape statically; the runtime guard catches dynamic callers
        // (CLI building args via spread, ad-hoc tooling).
        hash: HASH as `0x${string}`,
        signedCommitment: makeSignedPayload(),
      } as unknown as Parameters<typeof cancelOnchain>[1]),
    ).rejects.toMatchObject({
      name: 'OspexValidationError',
      message: expect.stringContaining('exactly one'),
    });
  });

  it('throws when NEITHER { hash } nor { signedCommitment } nor { commitment } is supplied', async () => {
    const { ctx } = fakeContext();
    await expect(
      cancelOnchain(
        ctx,
        {} as unknown as Parameters<typeof cancelOnchain>[1],
      ),
    ).rejects.toMatchObject({
      name: 'OspexValidationError',
      message: expect.stringContaining('one of'),
    });
  });
});

// ─── { commitment } overload + recoverHidden (cancel-recovery) ───────────

import { ApiClient } from '../src/api/client.js';
import type {
  Hash as HashType,
  PublicClient as PublicClientType,
  TransactionReceipt as TransactionReceiptType,
} from 'viem';
import type {
  PublicHiddenCommitment,
  PublicVisibleCommitment,
} from '../src/types/commitment.js';
import type {
  OwnerCommitmentBody,
  OwnerStateSnapshotBody,
  StreamChallenge,
} from '../src/api/types.js';

/**
 * These code paths read no contest / speculation / team data, so the
 * corresponding context accessors must never be touched. Wiring them to
 * throw keeps that a tested property rather than an assumption: a
 * regression that starts calling one turns the expected typed error into a
 * loud tripwire instead of passing silently.
 */
const unusedAccessor =
  (what: string) =>
  (): never => {
    throw new Error(`unexpected ${what} access`);
  };

const SCORER = ('0xdd' + 'aa'.repeat(19)) as `0x${string}`;
const VALID_SIG_65 = ('0x' + 'cc'.repeat(65)) as `0x${string}`;
const EXPIRY_ISO = '2099-01-01T00:00:00.000Z';
const EXPIRY_UNIX = String(Math.floor(new Date(EXPIRY_ISO).getTime() / 1000));

// A VISIBLE row whose struct reconstructs to BODY_STRUCT → hashes to HASH, so
// buildPayloadFromVisible → cancelOnchainSigned's assertReconstructHash passes.
const VISIBLE_COMMITMENT: PublicVisibleCommitment = {
  visibility: 'visible',
  redacted: false,
  commitmentHash: HASH,
  maker: SIGNER_ADDR,
  contestId: '42',
  scorer: SCORER,
  lineTicks: -35,
  positionType: 0,
  oddsTick: 191,
  marketType: 'spread',
  riskAmount: '1000000',
  filledRiskAmount: '0',
  remainingRiskAmount: '1000000',
  nonce: '1700000000',
  expiry: EXPIRY_ISO,
  speculationKey: '0x' + 'ee'.repeat(32),
  signature: VALID_SIG_65,
  status: 'open',
  storedStatus: 'open',
  source: 'agent',
  network: 'polygon',
  nonceInvalidated: false,
  isLive: true,
  createdAt: '2026-05-04T00:00:00.000Z',
};

// The same commitment after an off-chain DELETE — book-hidden, redacted public
// body (the allow-list strips the matchable struct). The discriminant the
// `{ commitment }` branch routes on.
const HIDDEN_COMMITMENT: PublicHiddenCommitment = {
  visibility: 'hidden',
  redacted: true,
  payloadAvailable: false,
  commitmentHash: HASH,
  maker: SIGNER_ADDR,
  contestId: '42',
  positionType: 0,
  status: 'cancelled',
  storedStatus: 'open',
  filledRiskAmount: '0',
  expiry: EXPIRY_ISO,
  bookVisible: false,
  nonceInvalidated: false,
};

// Wire signed payload whose struct hashes to HASH under (CHAIN_ID,
// MATCHING_MODULE) — i.e. exactly BODY_STRUCT, decimal-string encoded.
const SIGNED_PAYLOAD_WIRE: NonNullable<OwnerCommitmentBody['signedPayload']> = {
  commitmentHash: HASH,
  commitment: {
    maker: SIGNER_ADDR,
    contestId: '42',
    scorer: SCORER,
    lineTicks: -35,
    positionType: 0,
    oddsTick: 191,
    riskAmount: '1000000',
    nonce: '1700000000',
    expiry: EXPIRY_UNIX,
  },
  signature: VALID_SIG_65,
};

function ownerBodyForHash(
  signedPayload: OwnerCommitmentBody['signedPayload'],
): OwnerCommitmentBody {
  return {
    commitmentHash: HASH,
    maker: SIGNER_ADDR,
    contestId: '42',
    scorer: SCORER,
    lineTicks: -35,
    positionType: 0,
    oddsTick: 191,
    marketType: 'spread',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '1700000000',
    expiry: EXPIRY_ISO,
    speculationKey: '0x' + 'ee'.repeat(32),
    signature: VALID_SIG_65,
    status: 'cancelled',
    storedStatus: 'open',
    source: 'agent',
    network: 'polygon',
    nonceInvalidated: false,
    bookVisible: false,
    createdAt: '2026-05-04T00:00:00.000Z',
    speculationId: '1',
    sport: 'baseball_mlb',
    awayTeam: 'Away',
    homeTeam: 'Home',
    updatedAtUnixSec: 1735700000,
    signedPayload,
  };
}

function snapshotPage(
  commitments: OwnerCommitmentBody[],
  truncated: boolean,
  cursor: string,
): OwnerStateSnapshotBody {
  return { cursor, commitments, positions: [], truncated, positionsTruncated: false };
}

function freshChallenge(): StreamChallenge {
  const now = Math.floor(Date.now() / 1000);
  return {
    address: SIGNER_ADDR,
    resource: 'own-state',
    scope: 'read:own-state',
    network: { chainId: CHAIN_ID },
    audience: 'api.ospex.test',
    challengeId: 'CHALLENGE_ID',
    issuedAt: now,
    expiresAt: now + 180,
  };
}

interface RecoveryOpts {
  snapshotPages?: OwnerStateSnapshotBody[];
  /** Body returned by GET /v1/commitments/:hash (the hash branch only). */
  commitmentGet?: unknown;
}

/**
 * A CommitmentsContext whose `api` is a real ApiClient over a fake fetch that
 * serves the owner-auth flow (stream-challenge → stream-token → snapshot pages)
 * plus an optional public commitments GET — so the owner-auth recovery path can
 * be exercised end-to-end (mint token → page snapshot → cancelOnchainSigned).
 */
function fakeRecoveryContext(opts: RecoveryOpts = {}): {
  ctx: CommitmentsContext;
  snapshotCallCount: () => number;
} {
  const txHash = ('0x' + 'aa'.repeat(32)) as HashType;
  const receipt = {
    status: 'success',
    transactionHash: txHash,
    blockNumber: 12345n,
    logs: [],
  } as unknown as TransactionReceiptType;
  const publicClient = {
    sendRawTransaction: async () => txHash,
    waitForTransactionReceipt: async () => receipt,
    getTransactionCount: async () => 7,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 50n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => 80_000n,
    readContract: async () => 0n,
  } as unknown as PublicClientType;
  const signer: Signer = {
    getAddress: async () => SIGNER_ADDR as `0x${string}`,
    signTypedData: async () => '0xdead' as `0x${string}`,
    signTransaction: async () => '0xfeed' as `0x${string}`,
  };
  const challenge = freshChallenge();
  const pages = opts.snapshotPages ?? [];
  let pageIdx = 0;
  let snapshotCalls = 0;
  const fakeFetch: typeof globalThis.fetch = async (url, init) => {
    void init;
    const u = String(url);
    const body: unknown = (() => {
      if (u.endsWith('/v1/auth/stream-challenge')) {
        return { challenge, expiresAt: challenge.expiresAt };
      }
      if (u.endsWith('/v1/auth/stream-token')) {
        return { token: 'BEARER', expiresAt: challenge.issuedAt + 900 };
      }
      if (u.includes('/v1/own-state/snapshot')) {
        snapshotCalls += 1;
        const p = pages[pageIdx] ?? pages[pages.length - 1];
        pageIdx += 1;
        return p;
      }
      if (u.includes('/v1/commitments/')) {
        return opts.commitmentGet;
      }
      return { error: 'unexpected', code: 'INTERNAL_ERROR' };
    })();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const api = new ApiClient({ apiUrl: 'https://api.test', fetch: fakeFetch });
  const ctx: CommitmentsContext = {
    api: api as unknown as CommitmentsContext['api'],
    requireSigner: () => signer,
    getChainId: () => CHAIN_ID,
    getAddresses: () =>
      ({ matchingModule: MATCHING_MODULE }) as unknown as ReturnType<
        CommitmentsContext['getAddresses']
      >,
    requireChainClient: () => publicClient,
    getContestsApi: unusedAccessor('getContestsApi'),
    getSpeculationsApi: unusedAccessor('getSpeculationsApi'),
    getTeams: unusedAccessor('getTeams'),
    nonceCounter: new NonceCounter(),
  };
  return { ctx, snapshotCallCount: () => snapshotCalls };
}

describe('commitments.cancelOnchain — { commitment } overload + recoverHidden (cancel-recovery)', () => {
  it('{ commitment } (visible) reconstructs + cancels WITHOUT a public-API fetch', async () => {
    // The dual `cancel --also-onchain` on-chain leg passes the already-resolved
    // (visible) row so it never re-fetches a body its own off-chain DELETE just
    // hid. Wire the API to throw to prove no fetch happens.
    const { ctx } = fakeContext({
      apiResponder: () => {
        throw new Error('{ commitment } branch must not fetch the commitments API');
      },
    });
    const result = await cancelOnchain(ctx, { commitment: VISIBLE_COMMITMENT });
    expect(result.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(result.commitmentHash).toBe(HASH.toLowerCase());
  });

  it('{ commitment } (redacted) WITHOUT recoverHidden refuses before signer / RPC', async () => {
    // The backward-compatible default: a redacted row is refused with the
    // structured owner-auth guidance, before any signer / chain access.
    const ctx: CommitmentsContext = {
      api: {
        request: async () => {
          throw new Error('API must not be hit for a redacted refusal');
        },
      } as unknown as CommitmentsContext['api'],
      requireSigner: () => {
        throw new Error('signer must not be accessed for a redacted refusal');
      },
      requireChainClient: () => {
        throw new Error('chain client must not be accessed for a redacted refusal');
      },
      getChainId: () => CHAIN_ID,
      getAddresses: () => {
        throw new Error('addresses must not be accessed for a redacted refusal');
      },
      getContestsApi: unusedAccessor('getContestsApi'),
      getSpeculationsApi: unusedAccessor('getSpeculationsApi'),
      getTeams: unusedAccessor('getTeams'),
      nonceCounter: new NonceCounter(),
    };
    await expect(
      cancelOnchain(ctx, { commitment: HIDDEN_COMMITMENT }),
    ).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'commitment',
      message: expect.stringContaining('cancel on chain'),
    });
  });

  it('{ commitment } (redacted) WITH recoverHidden recovers the signed payload via owner-auth + cancels', async () => {
    const { ctx, snapshotCallCount } = fakeRecoveryContext({
      snapshotPages: [snapshotPage([ownerBodyForHash(SIGNED_PAYLOAD_WIRE)], false, 'LIVE')],
    });
    const result = await cancelOnchain(ctx, {
      commitment: HIDDEN_COMMITMENT,
      recoverHidden: true,
    });
    expect(result.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(result.commitmentHash).toBe(HASH.toLowerCase());
    expect(snapshotCallCount()).toBe(1);
  });

  it('{ hash } WITH recoverHidden recovers a book-hidden fetched row', async () => {
    // Hash branch: api.get returns the redacted body → owner-auth recovery.
    const hiddenWireBody: Record<string, unknown> = {
      redacted: true,
      payloadAvailable: false,
      commitmentHash: HASH,
      maker: SIGNER_ADDR,
      contestId: '42',
      positionType: 0,
      status: 'cancelled',
      storedStatus: 'open',
      filledRiskAmount: '0',
      expiry: EXPIRY_ISO,
      bookVisible: false,
      nonceInvalidated: false,
    };
    const { ctx } = fakeRecoveryContext({
      commitmentGet: hiddenWireBody,
      snapshotPages: [snapshotPage([ownerBodyForHash(SIGNED_PAYLOAD_WIRE)], false, 'LIVE')],
    });
    const result = await cancelOnchain(ctx, {
      hash: HASH as `0x${string}`,
      recoverHidden: true,
    });
    expect(result.commitmentHash).toBe(HASH.toLowerCase());
  });

  it('recoverHidden: snapshot drains without the hash → clear "not found in scope" error', async () => {
    const { ctx } = fakeRecoveryContext({
      // Drains (truncated:false) without the target hash → getOwnerCommitment null.
      snapshotPages: [snapshotPage([], false, 'LIVE')],
    });
    await expect(
      cancelOnchain(ctx, { commitment: HIDDEN_COMMITMENT, recoverHidden: true }),
    ).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'hash',
      message: expect.stringContaining('not found in your owner-auth'),
    });
  });

  it('recoverHidden: owner row carries null signedPayload → clear "no signed payload" error', async () => {
    const { ctx } = fakeRecoveryContext({
      snapshotPages: [snapshotPage([ownerBodyForHash(null)], false, 'LIVE')],
    });
    await expect(
      cancelOnchain(ctx, { commitment: HIDDEN_COMMITMENT, recoverHidden: true }),
    ).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'signedPayload',
      message: expect.stringContaining('no signed payload'),
    });
  });

  it('recoverHidden: a recovered payload whose struct mis-hashes is REFUSED, not broadcast (assertReconstructHash on the recovery branch)', async () => {
    // The recovery branch delegates to cancelOnchainSigned, which re-derives the
    // hash from the struct and refuses a drift BEFORE broadcasting — so an
    // own-state row whose signedPayload struct doesn't hash to its commitmentHash
    // (here: a bumped nonce) can never cancel the wrong on-chain slot. Locks the
    // recovery→assertion wiring against a future refactor that bypasses
    // cancelOnchainSigned.
    const drifted: NonNullable<OwnerCommitmentBody['signedPayload']> = {
      ...SIGNED_PAYLOAD_WIRE,
      commitment: { ...SIGNED_PAYLOAD_WIRE.commitment, nonce: '1700000099' },
    };
    const { ctx } = fakeRecoveryContext({
      snapshotPages: [snapshotPage([ownerBodyForHash(drifted)], false, 'LIVE')],
    });
    await expect(
      cancelOnchain(ctx, { commitment: HIDDEN_COMMITMENT, recoverHidden: true }),
    ).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'commitmentHash',
      message: expect.stringContaining('does not match commitmentHash'),
    });
  });

  it('{ hash } binds the cancel to the REQUESTED hash — refuses a wrong-row API body', async () => {
    // Defense-in-depth: api.get(H2) returns a coherent body for a DIFFERENT
    // commitment (it hashes to HASH, not the requested H2). The cancel MUST
    // refuse — bound to the REQUESTED hash, never the fetched body's own hash —
    // rather than silently cancel whatever the body describes. With the
    // requested-hash binding, assertReconstructHash(struct, H2) sees the struct
    // hash to HASH ≠ H2 and throws.
    const DIFFERENT_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
    const { ctx } = fakeContext(); // default apiResponder → body hashing to HASH
    await expect(cancelOnchain(ctx, { hash: DIFFERENT_HASH })).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'commitmentHash',
      message: expect.stringContaining('does not match commitmentHash'),
    });
  });

  it('recoverHidden: a recovered payload whose commitmentHash ≠ the requested hash is REFUSED (requested-hash binding)', async () => {
    // The own-state ROW matches the requested hash, but its embedded
    // signedPayload targets a DIFFERENT commitmentHash (an internally
    // inconsistent owner-auth body). The recovery MUST refuse — binding the
    // cancel to the requested hash — rather than cancel the payload's hash.
    const OTHER_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
    const inconsistent: NonNullable<OwnerCommitmentBody['signedPayload']> = {
      ...SIGNED_PAYLOAD_WIRE,
      commitmentHash: OTHER_HASH,
    };
    const { ctx } = fakeRecoveryContext({
      snapshotPages: [snapshotPage([ownerBodyForHash(inconsistent)], false, 'LIVE')],
    });
    await expect(
      cancelOnchain(ctx, { commitment: HIDDEN_COMMITMENT, recoverHidden: true }),
    ).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'commitmentHash',
      message: expect.stringContaining('refusing to cancel a different commitment'),
    });
  });
});
