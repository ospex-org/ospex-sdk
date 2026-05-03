/**
 * waitForVerified polls on-chain ContestModule.getContest. Tests inject
 * a fake PublicClient + sleep to drive the loop deterministically.
 */
import { describe, expect, it, vi } from 'vitest';
import { OspexChainError } from '../src/errors.js';
import { waitForVerified } from '../src/contests/waitForVerified.js';
import type { ContestsContext } from '../src/contests/context.js';
import type { OspexAddresses } from '../src/contracts/addresses.js';

const MOCK_ADDRESSES = {
  contestModule: '0x1Eb0048650380369C6F4239dE070114463626102',
} as unknown as OspexAddresses;

interface FakePublicClient {
  readContract: ReturnType<typeof vi.fn>;
}

function makeCtx(
  publicClient: FakePublicClient,
): { ctx: ContestsContext } {
  return {
    ctx: {
      requireChainClient: () => publicClient,
      getAddresses: () => MOCK_ADDRESSES,
    } as unknown as ContestsContext,
  };
}

describe('waitForVerified', () => {
  it('resolves on first read when contest is already Verified (status=1)', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 1 }),
    };
    const { ctx } = makeCtx(publicClient);
    const sleep = vi.fn(async () => {});

    const result = await waitForVerified(ctx, 42n, { sleep });
    expect(result.contestId).toBe(42n);
    expect(result.status).toBe('verified');
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats Scored (status=2) and Voided (status=3) as terminal and returns immediately', async () => {
    const scored: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 2 }),
    };
    const voided: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 3 }),
    };
    expect((await waitForVerified(makeCtx(scored).ctx, 1n, { sleep: async () => {} })).status).toBe(
      'scored',
    );
    expect((await waitForVerified(makeCtx(voided).ctx, 1n, { sleep: async () => {} })).status).toBe(
      'voided',
    );
  });

  it('polls until status flips to Verified', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce({ contestStatus: 0 })
        .mockResolvedValueOnce({ contestStatus: 0 })
        .mockResolvedValueOnce({ contestStatus: 1 }),
    };
    const { ctx } = makeCtx(publicClient);
    const sleep = vi.fn(async () => {});

    const result = await waitForVerified(ctx, 7n, { sleep, pollIntervalMs: 10, timeoutMs: 60_000 });
    expect(result.status).toBe('verified');
    expect(publicClient.readContract).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws OspexChainError on timeout', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValue({ contestStatus: 0 }),
    };
    const { ctx } = makeCtx(publicClient);

    await expect(
      waitForVerified(ctx, 99n, {
        sleep: async () => {},
        pollIntervalMs: 10_000,
        timeoutMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(OspexChainError);
  });

  it('throws OspexChainError on unrecognized status enum', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 99 }),
    };
    const { ctx } = makeCtx(publicClient);
    await expect(waitForVerified(ctx, 1n, { sleep: async () => {} })).rejects.toBeInstanceOf(
      OspexChainError,
    );
  });
});
