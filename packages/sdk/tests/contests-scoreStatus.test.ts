/**
 * scoreStatus does ONE on-chain ContestModule.getContest read and never
 * throws on "not scored". Scores are gated on status==='scored'.
 */
import { describe, expect, it, vi } from 'vitest';
import { OspexChainError, OspexValidationError } from '../src/errors.js';
import { scoreStatus } from '../src/contests/scoreStatus.js';
import type { ContestsContext } from '../src/contests/context.js';
import type { OspexAddresses } from '../src/contracts/addresses.js';

const MOCK_ADDRESSES = {
  contestModule: '0x1Eb0048650380369C6F4239dE070114463626102',
} as unknown as OspexAddresses;

interface FakePublicClient {
  readContract: ReturnType<typeof vi.fn>;
}

function makeCtx(publicClient: FakePublicClient): ContestsContext {
  return {
    requireChainClient: () => publicClient,
    getAddresses: () => MOCK_ADDRESSES,
  } as unknown as ContestsContext;
}

describe('scoreStatus', () => {
  it('scored → { scored:true } with numeric scores', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 2, awayScore: 5, homeScore: 1 }),
    };
    const r = await scoreStatus(makeCtx(publicClient), 3n);
    expect(r.contestId).toBe(3n);
    expect(r.status).toBe('scored');
    expect(r.scored).toBe(true);
    expect(r.awayScore).toBe(5);
    expect(r.homeScore).toBe(1);
  });

  it('scored 0-0 → { scored:true } with real 0 scores (not null)', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 2, awayScore: 0, homeScore: 0 }),
    };
    const r = await scoreStatus(makeCtx(publicClient), 3n);
    expect(r.scored).toBe(true);
    expect(r.awayScore).toBe(0);
    expect(r.homeScore).toBe(0);
  });

  it('verified → { scored:false, scores null } (does NOT throw)', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 1, awayScore: 0, homeScore: 0 }),
    };
    const r = await scoreStatus(makeCtx(publicClient), 3n);
    expect(r.status).toBe('verified');
    expect(r.scored).toBe(false);
    expect(r.awayScore).toBeNull();
    expect(r.homeScore).toBeNull();
  });

  it('unverified → { scored:false, scores null }', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 0 }),
    };
    const r = await scoreStatus(makeCtx(publicClient), 3n);
    expect(r.status).toBe('unverified');
    expect(r.scored).toBe(false);
    expect(r.awayScore).toBeNull();
    expect(r.homeScore).toBeNull();
  });

  it('voided → { scored:false, scores null } (never inferred as a result)', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 3 }),
    };
    const r = await scoreStatus(makeCtx(publicClient), 3n);
    expect(r.status).toBe('voided');
    expect(r.scored).toBe(false);
    expect(r.awayScore).toBeNull();
    expect(r.homeScore).toBeNull();
  });

  it('rejects a non-positive contestId with OspexValidationError before any read', async () => {
    const publicClient: FakePublicClient = { readContract: vi.fn() };
    await expect(scoreStatus(makeCtx(publicClient), 0n)).rejects.toBeInstanceOf(
      OspexValidationError,
    );
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it('throws OspexChainError on rpc failure', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockRejectedValueOnce(new Error('rpc down')),
    };
    await expect(scoreStatus(makeCtx(publicClient), 3n)).rejects.toBeInstanceOf(OspexChainError);
  });

  it('throws OspexChainError on unrecognized status enum', async () => {
    const publicClient: FakePublicClient = {
      readContract: vi.fn().mockResolvedValueOnce({ contestStatus: 99 }),
    };
    await expect(scoreStatus(makeCtx(publicClient), 3n)).rejects.toBeInstanceOf(OspexChainError);
  });
});
