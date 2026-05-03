/**
 * Hash-gate tests for the script-source fetcher. The on-chain check at
 * `OracleModule.createContestFromOracle` (`keccak256(abi.encodePacked(
 * params.createContestSourceJS)) == approvals.verifyApproval.scriptHash`)
 * makes this the single most expensive failure mode to misimplement —
 * a wrong hash wastes the user's LINK + USDC fee on a guaranteed revert.
 */
import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { OspexAPIError, OspexScriptApprovalError } from '../src/errors.js';
import { assertSourceMatches, fetchSource } from '../src/contests/helpers/fetchSource.js';
import type { ContestsContext } from '../src/contests/context.js';
import type { Hex } from '../src/types/signer.js';

const SAMPLE_SOURCE = "// Hello, Chainlink Functions\nreturn Functions.encodeUint256(1n);\n";
const SAMPLE_HASH = keccak256(toBytes(SAMPLE_SOURCE));

function makeCtx(fetchImpl: typeof globalThis.fetch): ContestsContext {
  return {
    fetch: fetchImpl,
  } as unknown as ContestsContext;
}

describe('assertSourceMatches', () => {
  it('returns the source on a matching hash', () => {
    const result = assertSourceMatches(SAMPLE_SOURCE, SAMPLE_HASH, 'test');
    expect(result).toBe(SAMPLE_SOURCE);
  });

  it('throws OspexScriptApprovalError on mismatch with reason=hash_mismatch', () => {
    const wrongHash = ('0x' + '00'.repeat(32)) as Hex;
    expect(() => assertSourceMatches(SAMPLE_SOURCE, wrongHash, 'verify')).toThrowError(
      OspexScriptApprovalError,
    );
    try {
      assertSourceMatches(SAMPLE_SOURCE, wrongHash, 'verify');
    } catch (err) {
      expect(err).toBeInstanceOf(OspexScriptApprovalError);
      const e = err as OspexScriptApprovalError;
      expect(e.reason).toBe('hash_mismatch');
      expect(e.expectedHash).toBe(wrongHash);
      expect(e.actualHash).toBe(SAMPLE_HASH);
    }
  });

  it('is case-insensitive on the hex hash comparison', () => {
    const upper = SAMPLE_HASH.toUpperCase().replace('0X', '0x') as Hex;
    expect(() => assertSourceMatches(SAMPLE_SOURCE, upper, 'test')).not.toThrow();
  });
});

describe('fetchSource', () => {
  it('returns the source body on a matching hash', async () => {
    const fetchImpl = (async () =>
      new Response(SAMPLE_SOURCE, { status: 200 })) as unknown as typeof globalThis.fetch;
    const ctx = makeCtx(fetchImpl);
    const result = await fetchSource(ctx, {
      url: 'https://example.com/source.js',
      expectedHash: SAMPLE_HASH,
    });
    expect(result).toBe(SAMPLE_SOURCE);
  });

  it('throws OspexScriptApprovalError on hash mismatch (does not return drifted source)', async () => {
    const fetchImpl = (async () =>
      new Response(SAMPLE_SOURCE + ' extra', { status: 200 })) as unknown as typeof globalThis.fetch;
    const ctx = makeCtx(fetchImpl);
    await expect(
      fetchSource(ctx, { url: 'https://example.com/source.js', expectedHash: SAMPLE_HASH }),
    ).rejects.toBeInstanceOf(OspexScriptApprovalError);
  });

  it('throws OspexAPIError on non-2xx upstream', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof globalThis.fetch;
    const ctx = makeCtx(fetchImpl);
    await expect(
      fetchSource(ctx, { url: 'https://example.com/missing.js', expectedHash: SAMPLE_HASH }),
    ).rejects.toBeInstanceOf(OspexAPIError);
  });

  it('throws OspexAPIError on transport failure', async () => {
    const fetchImpl = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof globalThis.fetch;
    const ctx = makeCtx(fetchImpl);
    await expect(
      fetchSource(ctx, { url: 'https://example.com/source.js', expectedHash: SAMPLE_HASH }),
    ).rejects.toBeInstanceOf(OspexAPIError);
  });
});
