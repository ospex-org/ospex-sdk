/**
 * waitForScored polls on-chain ContestModule.getContest. Tests inject a
 * fake PublicClient + sleep to drive the loop deterministically. Mirrors
 * contests-waitForVerified.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { OspexChainError } from '../src/errors.js';
import { waitForScored } from '../src/contests/waitForScored.js';
import type { ContestsContext } from '../src/contests/context.js';
import type { OspexAddresses } from '../src/contracts/addresses.js';

const MOCK_ADDRESSES = {
  contestModule: '0x1Eb0048650380369C6F4239dE070114463626102',
} as unknown as OspexAddresses;

interface FakePublicClient {
  readContract: ReturnType<typeof vi.fn>;
}

function makeCtx(publicClient: FakePublicClient): { ctx: ContestsContext } {
  return {
    ctx: {
      requireChainClient: () => publicClient,
      getAddresses: () => MOCK_ADDRESSES,
    } as unknown as ContestsContext,
  };
}

describe('waitForScored', () => {
  it('resolves on first read when the contest is already Scored (status=2) with scores', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 2, awayScore: 4, homeScore: 2 }),
    };
    const { ctx } = makeCtx(publicClient);
    const sleep = vi.fn(async () => {});

    const result = await waitForScored(ctx, 42n, { sleep });
    expect(result.contestId).toBe(42n);
    expect(result.status).toBe('scored');
    expect(result.awayScore).toBe(4);
    expect(result.homeScore).toBe(2);
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('surfaces a legitimate 0-0 final as real scores (not null)', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 2, awayScore: 0, homeScore: 0 }),
    };
    const result = await waitForScored(makeCtx(publicClient).ctx, 1n, { sleep: async () => {} });
    expect(result.status).toBe('scored');
    expect(result.awayScore).toBe(0);
    expect(result.homeScore).toBe(0);
  });

  it('resolves on Voided (status=3) immediately WITHOUT waiting the timeout, scores null', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 3 }),
    };
    const sleep = vi.fn(async () => {});
    // A tiny timeout: if waitForScored spun on voided it would throw; it must not.
    const result = await waitForScored(makeCtx(publicClient).ctx, 1n, {
      sleep,
      pollIntervalMs: 10,
      timeoutMs: 1,
    });
    expect(result.status).toBe('voided');
    expect(result.awayScore).toBeNull();
    expect(result.homeScore).toBeNull();
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls through unverified/verified until status flips to Scored', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce({ contestStatus: 0 })
        .mockResolvedValueOnce({ contestStatus: 1 })
        .mockResolvedValueOnce({ contestStatus: 2, awayScore: 7, homeScore: 3 }),
    };
    const { ctx } = makeCtx(publicClient);
    const sleep = vi.fn(async () => {});

    const result = await waitForScored(ctx, 7n, { sleep, pollIntervalMs: 10, timeoutMs: 60_000 });
    expect(result.status).toBe('scored');
    expect(result.awayScore).toBe(7);
    expect(result.homeScore).toBe(3);
    expect(publicClient.readContract).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws OspexChainError on timeout while still verified (score never lands)', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValue({ contestStatus: 1 }),
    };
    const { ctx } = makeCtx(publicClient);

    await expect(
      waitForScored(ctx, 99n, { sleep: async () => {}, pollIntervalMs: 10_000, timeoutMs: 5_000 }),
    ).rejects.toBeInstanceOf(OspexChainError);
  });

  it('throws OspexChainError on unrecognized status enum', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 99 }),
    };
    await expect(
      waitForScored(makeCtx(publicClient).ctx, 1n, { sleep: async () => {} }),
    ).rejects.toBeInstanceOf(OspexChainError);
  });
});
