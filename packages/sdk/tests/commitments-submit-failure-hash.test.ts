/**
 * #7 (H2) — a `/v1/commitments` POST that fails AFTER the EIP-712 hash was
 * computed must surface that hash on the thrown `OspexAPIError`, so a caller
 * can probe whether the (maybe-inserted) commitment landed before retrying
 * (a blind retry signs a new nonce → new hash → server dedup misses → doubled
 * exposure). Covers the shared `withCommitmentHash` helper and both POST sites
 * (`submitRaw` + `submitPrepared`), including the NONCE_TOO_LOW retry path.
 */

import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { submitRaw, withCommitmentHash } from '../src/commitments/submitRaw.js';
import { submitPrepared } from '../src/commitments/submitPrepared.js';
import { NonceCounter } from '../src/commitments/context.js';
import {
  buildDomain,
  deriveSpeculationKey,
  hashCommitment,
  type OspexCommitmentMessage,
} from '../src/chain/eip712.js';
import { OspexAPIError } from '../src/errors.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { CommitmentBody } from '../src/api/types.js';
import type { SubmitPreview } from '../src/types/preview.js';
import type { Signer } from '../src/types/signer.js';

const MAKER = ('0x' + 'aa'.repeat(20)) as `0x${string}`;
const SCORER = ('0x' + 'cc'.repeat(20)) as `0x${string}`;
const MATCHING_MODULE = ('0x' + '11'.repeat(20)) as `0x${string}`;
const POSITION_MODULE = ('0x' + '22'.repeat(20)) as `0x${string}`;
const USDC = ('0x' + '33'.repeat(20)) as `0x${string}`;
const CHAIN_ID = 137 as const;
const SIG = ('0x' + '11'.repeat(65)) as `0x${string}`;
const SIG_RETRY = ('0x' + '22'.repeat(65)) as `0x${string}`;

const EXPIRY_SEC = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);

const ARGS = {
  contestId: 42n,
  scorer: SCORER,
  lineTicks: 0,
  positionType: 0 as const,
  oddsTick: 200,
  riskAmount: 1_000_000n,
  expiry: EXPIRY_SEC,
};

/** The hash the SDK computes for ARGS signed with `nonce`. */
function expectedHashForNonce(nonce: bigint): string {
  const message: OspexCommitmentMessage = {
    maker: MAKER,
    contestId: ARGS.contestId,
    scorer: SCORER,
    lineTicks: ARGS.lineTicks,
    positionType: ARGS.positionType,
    oddsTick: ARGS.oddsTick,
    riskAmount: ARGS.riskAmount,
    nonce,
    expiry: EXPIRY_SEC,
  };
  return hashCommitment(buildDomain(CHAIN_ID, MATCHING_MODULE), message);
}

function fakeContext(opts: {
  apiResponder: (callIndex: number) => Promise<CommitmentBody>;
  nonceFloorSeq?: bigint[];
  signatureSeq?: `0x${string}`[];
}): CommitmentsContext {
  const nonceFloorSeq = opts.nonceFloorSeq ?? [0n];
  const signatureSeq = opts.signatureSeq ?? [SIG];
  let nonceReadIdx = 0;
  let sigIdx = 0;
  let apiCallIdx = 0;

  const publicClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'allowance') return 1_000_000n;
      if (functionName === 's_minNonces') {
        const floor = nonceFloorSeq[nonceReadIdx] ?? nonceFloorSeq[nonceFloorSeq.length - 1];
        nonceReadIdx += 1;
        return floor ?? 0n;
      }
      throw new Error(`unexpected readContract: ${functionName}`);
    },
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => MAKER,
    signTypedData: async () => {
      const sig = signatureSeq[sigIdx] ?? signatureSeq[signatureSeq.length - 1];
      sigIdx += 1;
      return sig ?? SIG;
    },
    signTransaction: async () => '0xdead' as `0x${string}`,
  };

  return {
    api: {
      request: async () => {
        const idx = apiCallIdx;
        apiCallIdx += 1;
        return opts.apiResponder(idx);
      },
    } as unknown as CommitmentsContext['api'],
    requireSigner: () => signer,
    getChainId: () => CHAIN_ID,
    getAddresses: () =>
      ({
        matchingModule: MATCHING_MODULE,
        positionModule: POSITION_MODULE,
        usdc: USDC,
      }) as unknown as ReturnType<CommitmentsContext['getAddresses']>,
    requireChainClient: () => publicClient,
    nonceCounter: new NonceCounter(),
  };
}

describe('withCommitmentHash', () => {
  const HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

  it('returns a non-OspexAPIError unchanged (no wrapping)', () => {
    const e = new Error('not an api error');
    expect(withCommitmentHash(e, HASH)).toBe(e);
  });

  it('attaches commitmentHash and preserves status / apiCode / path / cause / code', () => {
    const cause = new Error('root');
    const orig = new OspexAPIError('rate limited', {
      status: 429,
      apiCode: 'RATE_LIMITED',
      path: '/v1/commitments',
      cause,
    });
    const out = withCommitmentHash(orig, HASH) as OspexAPIError;
    expect(out).toBeInstanceOf(OspexAPIError);
    expect(out.commitmentHash).toBe(HASH);
    expect(out.status).toBe(429);
    expect(out.apiCode).toBe('RATE_LIMITED');
    expect(out.path).toBe('/v1/commitments');
    expect(out.cause).toBe(cause);
    expect(out.code).toBe('API_ERROR');
  });

  it('is idempotent — does not re-wrap an error already carrying a commitmentHash', () => {
    const orig = new OspexAPIError('x', { status: 503, commitmentHash: HASH });
    const out = withCommitmentHash(orig, ('0x' + 'cd'.repeat(32)) as `0x${string}`);
    expect(out).toBe(orig);
    expect((out as OspexAPIError).commitmentHash).toBe(HASH);
  });
});

describe('submitRaw — ambiguous POST failure surfaces the locally-computed commitmentHash', () => {
  it('attaches commitmentHash to a 5xx OspexAPIError (preserving status) so the caller can probe before retrying', async () => {
    const nonce = 1_700_000_000n;
    const ctx = fakeContext({
      apiResponder: async () => {
        throw new OspexAPIError('upstream exploded', { status: 503 });
      },
    });
    let thrown: unknown;
    try {
      await submitRaw(ctx, { ...ARGS, nonce });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OspexAPIError);
    expect((thrown as OspexAPIError).commitmentHash).toBe(expectedHashForNonce(nonce));
    expect((thrown as OspexAPIError).status).toBe(503);
    expect((thrown as OspexAPIError).code).toBe('API_ERROR');
  });

  it('attaches commitmentHash on a transport failure (no status)', async () => {
    const nonce = 1_700_000_500n;
    const ctx = fakeContext({
      apiResponder: async () => {
        throw new OspexAPIError('network error', { path: '/v1/commitments' });
      },
    });
    let thrown: unknown;
    try {
      await submitRaw(ctx, { ...ARGS, nonce });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as OspexAPIError).status).toBeUndefined();
    expect((thrown as OspexAPIError).commitmentHash).toBe(expectedHashForNonce(nonce));
  });

  it('NONCE_TOO_LOW then a 5xx retry surfaces the RETRY hash (not the original) and stays an OspexAPIError', async () => {
    // First POST → NONCE_TOO_LOW (the wrap must NOT break the retry dispatch,
    // which keys on apiCode); retry POST → 5xx. The escaping error must carry
    // the RETRY struct's hash (a higher nonce), proving the final attempt's
    // hash is surfaced.
    const ctx = fakeContext({
      apiResponder: async (callIndex) => {
        if (callIndex === 0) {
          throw new OspexAPIError('nonce too low', { apiCode: 'NONCE_TOO_LOW', status: 409 });
        }
        throw new OspexAPIError('still down', { status: 503 });
      },
      nonceFloorSeq: [0n, 5_000_000_000n],
      signatureSeq: [SIG, SIG_RETRY],
    });
    let thrown: unknown;
    try {
      await submitRaw(ctx, ARGS);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OspexAPIError);
    expect((thrown as OspexAPIError).status).toBe(503);
    const h = (thrown as OspexAPIError).commitmentHash;
    expect(typeof h).toBe('string');
    // The retry signed a fresh nonce ≥ 5e9, so its hash differs from the
    // initial-attempt (nonce 0) hash — confirming the final attempt's hash.
    expect(h).not.toBe(expectedHashForNonce(0n));
  });
});

describe('submitPrepared — ambiguous POST failure surfaces the locally-computed commitmentHash', () => {
  function minimalPreview(nonce: bigint): SubmitPreview {
    // submitPrepared only reads `raw.*` (+ validates the speculationKey
    // derivation and lineTicks); the rest of SubmitPreview is unused here.
    return {
      raw: {
        maker: MAKER,
        chainId: CHAIN_ID,
        verifyingContract: MATCHING_MODULE,
        contestId: ARGS.contestId.toString(),
        scorer: SCORER,
        lineTicks: ARGS.lineTicks,
        positionType: ARGS.positionType,
        oddsTick: ARGS.oddsTick,
        riskAmount: ARGS.riskAmount.toString(),
        expiry: EXPIRY_SEC.toString(),
        nonce: nonce.toString(),
        speculationKey: deriveSpeculationKey(ARGS.contestId, SCORER, ARGS.lineTicks),
      },
    } as unknown as SubmitPreview;
  }

  it('attaches the hash of the previewed commitment to a failed POST', async () => {
    const nonce = 1_700_000_000n;
    const ctx = fakeContext({
      apiResponder: async () => {
        throw new OspexAPIError('gateway timeout', { status: 504 });
      },
    });
    let thrown: unknown;
    try {
      await submitPrepared(ctx, minimalPreview(nonce));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OspexAPIError);
    expect((thrown as OspexAPIError).commitmentHash).toBe(expectedHashForNonce(nonce));
    expect((thrown as OspexAPIError).status).toBe(504);
  });
});
