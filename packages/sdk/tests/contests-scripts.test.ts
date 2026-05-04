/**
 * ScriptsCache TTL + 503 error mapping tests. Caching matters because
 * the SDK creates one Contests instance per OspexClient — a bursty
 * caller (`ospex contests create` in a tight loop) shouldn't hit
 * core-api on every invocation.
 */
import { describe, expect, it, vi } from 'vitest';
import { OspexAPIError, OspexScriptApprovalError } from '../src/errors.js';
import { ScriptsCache } from '../src/contests/scripts.js';
import type { ContestsContext } from '../src/contests/context.js';
import type { ApprovedScripts } from '../src/types/contest.js';
import type { ContestsApi } from '../src/api/contests.js';

const SAMPLE_APPROVALS: ApprovedScripts = {
  network: 'polygon',
  approvedSigner: '0xfd6C7Fc1F182de53AA636584f1c6B80d9D885886',
  verify: {
    scriptHash: '0x01c48e15068b68b7d5986d5013edd83a243ac31a761567e9db0e57b513c26c01',
    purpose: 0,
    leagueId: 0,
    version: 1,
    validUntil: 1793030835,
    signature: '0xdead',
    sourceUrl: 'https://example.com/verify.js',
  },
  marketUpdate: {
    scriptHash: '0x7f5ce70565133fedb2e0f1aeb925f38a3b26924917cff852e7de40a9297119b4',
    purpose: 1,
    leagueId: 0,
    version: 1,
    validUntil: 0,
    signature: '0xbeef',
    sourceUrl: 'https://example.com/markets.js',
  },
  score: {
    scriptHash: '0xcb2a11db3190c322239b52afb3caefccfccd850566834819b012c5520f8d31cd',
    purpose: 2,
    leagueId: 0,
    version: 1,
    validUntil: 0,
    signature: '0xc0de',
    sourceUrl: 'https://example.com/score.js',
  },
};

function makeCtx(scriptsImpl: () => Promise<ApprovedScripts>): {
  ctx: ContestsContext;
  callCount: () => number;
} {
  let callCount = 0;
  const contestsApi = {
    scripts: vi.fn(async () => {
      callCount += 1;
      return scriptsImpl();
    }),
  } as unknown as ContestsApi;
  const ctx = { contestsApi } as unknown as ContestsContext;
  return { ctx, callCount: () => callCount };
}

describe('ScriptsCache', () => {
  it('caches across calls within the TTL', async () => {
    const cache = new ScriptsCache();
    const { ctx, callCount } = makeCtx(async () => SAMPLE_APPROVALS);

    const first = await cache.get(ctx);
    const second = await cache.get(ctx);

    expect(first).toEqual(SAMPLE_APPROVALS);
    expect(second).toEqual(SAMPLE_APPROVALS);
    expect(callCount()).toBe(1);
  });

  it('invalidate() forces a refetch', async () => {
    const cache = new ScriptsCache();
    const { ctx, callCount } = makeCtx(async () => SAMPLE_APPROVALS);

    await cache.get(ctx);
    cache.invalidate();
    await cache.get(ctx);
    expect(callCount()).toBe(2);
  });

  it('maps 503 SCRIPT_APPROVALS_NOT_CONFIGURED to OspexScriptApprovalError(reason=not_configured)', async () => {
    const cache = new ScriptsCache();
    const { ctx } = makeCtx(async () => {
      throw new OspexAPIError('Script approvals not configured for this network.', {
        status: 503,
        apiCode: 'SCRIPT_APPROVALS_NOT_CONFIGURED',
        path: '/v1/contests/scripts/approved',
      });
    });

    await expect(cache.get(ctx)).rejects.toBeInstanceOf(OspexScriptApprovalError);
    try {
      await cache.get(ctx);
    } catch (err) {
      expect((err as OspexScriptApprovalError).reason).toBe('not_configured');
    }
  });

  it('rethrows non-503 errors unchanged (e.g. 500 stays as OspexAPIError)', async () => {
    const cache = new ScriptsCache();
    const { ctx } = makeCtx(async () => {
      throw new OspexAPIError('Internal error', {
        status: 500,
        apiCode: 'INTERNAL_ERROR',
        path: '/v1/contests/scripts/approved',
      });
    });

    await expect(cache.get(ctx)).rejects.toBeInstanceOf(OspexAPIError);
    await expect(cache.get(ctx)).rejects.not.toBeInstanceOf(OspexScriptApprovalError);
  });
});
