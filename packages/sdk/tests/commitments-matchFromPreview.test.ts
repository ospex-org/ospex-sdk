/**
 * Unit tests for `matchFromPreview` — always-revalidate behavior.
 *
 * Covers:
 *   - re-fetches commitment + contest before sending
 *   - status changed since preview → throws (no tx sent)
 *   - nonceInvalidated flipped → throws
 *   - expiry passed → throws
 *   - remainingRiskAmount shrunk below the preview's fillMakerRisk → throws
 *   - canonical signed field changed → throws
 *   - lazy → existing transition → throws
 *   - existing → spec became closed → throws
 *   - taker allowance insufficient on chain → throws OspexAllowanceError
 *   - chainId / verifyingContract mismatch → throws
 *   - signer address differs from preview → throws
 *   - happy path: builds calldata via matchingModule.matchCommitment, returns MatchResult
 */

import { describe, expect, it, vi } from 'vitest';
import { type Hash, type PublicClient, type TransactionReceipt } from 'viem';
import { matchFromPreview } from '../src/commitments/matchFromPreview.js';
import { buildMatchPreview } from '../src/commitments/buildMatchPreview.js';
import { NonceCounter } from '../src/commitments/context.js';
import { OspexAllowanceError, OspexValidationError } from '../src/errors.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { Hex, Signer } from '../src/types/signer.js';
import type { Commitment } from '../src/types/commitment.js';
import type { Contest } from '../src/types/contest.js';
import type { MatchPreview } from '../src/types/matchPreview.js';

const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
const TAKER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const SCORER = '0x4444444444444444444444444444444444444444' as Hex;
const HASH = ('0x' + 'cd'.repeat(32)) as Hex;
const FAR_FUTURE_ISO = '2099-05-08T02:00:00Z';

const ADDRESSES = {
  matchingModule: '0x'.padEnd(42, '1') as Hex,
  positionModule: '0x'.padEnd(42, '2') as Hex,
  usdc: '0x'.padEnd(42, '3') as Hex,
  linkToken: '0x'.padEnd(42, '4') as Hex,
  ospexCore: '0x'.padEnd(42, '5') as Hex,
  speculationModule: '0x'.padEnd(42, '6') as Hex,
  contestModule: '0x'.padEnd(42, '7') as Hex,
  leaderboardModule: '0x'.padEnd(42, '8') as Hex,
  rulesModule: '0x'.padEnd(42, '9') as Hex,
  treasuryModule: '0x'.padEnd(42, 'b') as Hex,
  secondaryMarketModule: '0x'.padEnd(42, 'c') as Hex,
  oracleModule: '0x'.padEnd(42, 'd') as Hex,
  scorers: {
    moneyline: '0x'.padEnd(42, 'e') as Hex,
    spread: '0x'.padEnd(42, 'f') as Hex,
    total: '0x'.padEnd(42, '0') as Hex,
  },
};

function makeCommitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    commitmentHash: HASH,
    maker: MAKER,
    contestId: '42',
    scorer: SCORER,
    lineTicks: 0,
    positionType: 0,
    oddsTick: 250,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '17000000001',
    expiry: FAR_FUTURE_ISO,
    speculationKey: '0x'.padEnd(66, 'a'),
    signature: ('0x' + 'sig'.padEnd(130, '0')) as string,
    status: 'open',
    source: 'submit',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2026-05-09T00:00:00Z',
    ...overrides,
  };
}

function buildContest(overrides: Partial<Contest> = {}): Contest {
  return {
    contestId: '42',
    awayTeam: 'Los Angeles Lakers',
    homeTeam: 'Denver Nuggets',
    sport: 'nba',
    sportId: 1,
    matchTime: FAR_FUTURE_ISO,
    status: 'verified',
    awayTeamId: 'lakers-uuid',
    homeTeamId: 'nuggets-uuid',
    speculations: [
      {
        speculationId: '101',
        contestId: '42',
        type: 'moneyline',
        lineTicks: 0,
        line: 0,
        speculationStatus: 0,
      },
    ],
    ...overrides,
  };
}

function buildPreview(opts: {
  commitment?: Commitment;
  speculation?: MatchPreview['speculation'];
} = {}): MatchPreview {
  return buildMatchPreview({
    commitment: opts.commitment ?? makeCommitment(),
    chainId: 137,
    matchingModuleAddress: ADDRESSES.matchingModule,
    taker: TAKER,
    awayTeam: 'Los Angeles Lakers',
    homeTeam: 'Denver Nuggets',
    awayTeamId: 'lakers-uuid',
    homeTeamId: 'nuggets-uuid',
    sport: 'nba',
    matchTime: FAR_FUTURE_ISO,
    speculation: opts.speculation ?? { mode: 'existing', speculationId: '101' },
    speculationKey: '0x'.padEnd(66, 'a') as Hex,
    speculationCreationTotalFeeWei6: 500_000n,
    takerTreasuryAllowanceWei6: 500_000n,
    makerTreasuryAllowanceWei6: 500_000n,
    treasuryModuleAddress: ADDRESSES.treasuryModule,
    positionModuleAddress: ADDRESSES.positionModule,
    takerPositionAllowanceWei6: 5_000_000n, // generous default
    nowUnixSec: 1_700_000_000n,
  });
}

interface CtxOpts {
  freshCommitment?: Commitment;
  freshContest?: Contest;
  takerAllowanceWei6?: bigint;
  takerAddress?: Hex;
  estimateGasFails?: boolean;
}

function buildCtx(opts: CtxOpts = {}): {
  ctx: CommitmentsContext;
  apiRequest: ReturnType<typeof vi.fn>;
  contestsGet: ReturnType<typeof vi.fn>;
  publicClient: PublicClient;
} {
  const fresh = opts.freshCommitment ?? makeCommitment();
  const freshContest = opts.freshContest ?? buildContest();
  const apiRequest = vi.fn(async (_path: string) => fresh);
  const contestsGet = vi.fn(async () => freshContest);
  const contestsApi = { get: contestsGet } as unknown as ReturnType<
    CommitmentsContext['getContestsApi']
  >;

  const txHash = ('0x' + 'aa'.repeat(32)) as Hash;
  const receipt = {
    status: 'success',
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
      if (opts.estimateGasFails) throw new Error('estimate failed');
      return 80_000n;
    },
    readContract: async () => opts.takerAllowanceWei6 ?? 100_000_000n,
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => (opts.takerAddress ?? TAKER) as `0x${string}`,
    signTypedData: async () => '0xdead' as `0x${string}`,
    signTransaction: async () => '0xfeed' as `0x${string}`,
  };

  const ctx: CommitmentsContext = {
    api: { request: apiRequest } as unknown as CommitmentsContext['api'],
    requireSigner: () => signer,
    getChainId: () => 137,
    getAddresses: () => ADDRESSES,
    requireChainClient: () => publicClient,
    nonceCounter: new NonceCounter(),
    getContestsApi: () => contestsApi,
    getSpeculationsApi: () => ({}) as ReturnType<CommitmentsContext['getSpeculationsApi']>,
    getTeams: () => ({}) as ReturnType<CommitmentsContext['getTeams']>,
  };
  return { ctx, apiRequest, contestsGet, publicClient };
}

describe('matchFromPreview — always re-fetches', () => {
  it('fetches commitment and contest before sending', async () => {
    const preview = buildPreview();
    const { ctx, apiRequest, contestsGet } = buildCtx();
    await matchFromPreview(ctx, preview);
    expect(apiRequest).toHaveBeenCalledWith(`/v1/commitments/${HASH.toLowerCase()}`);
    expect(contestsGet).toHaveBeenCalledWith('42');
  });
});

describe('matchFromPreview — happy path', () => {
  it('passes through unchanged → returns MatchResult with txHash + computed amounts', async () => {
    const preview = buildPreview();
    const { ctx } = buildCtx();
    const result = await matchFromPreview(ctx, preview);
    expect(result.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(result.takerRisk).toBe(BigInt(preview.economics.takerRiskWei6));
    expect(result.fillMakerRisk).toBe(BigInt(preview.economics.fillMakerRiskWei6));
    expect(result.commitment.commitmentHash).toBe(HASH);
  });
});

describe('matchFromPreview — staleness checks', () => {
  it('status changed since preview → throws', async () => {
    const preview = buildPreview();
    const { ctx } = buildCtx({
      freshCommitment: makeCommitment({ status: 'cancelled' }),
    });
    await expect(matchFromPreview(ctx, preview)).rejects.toThrow(/no longer matchable.*cancelled/);
  });

  it('nonceInvalidated flipped → throws', async () => {
    const preview = buildPreview();
    const { ctx } = buildCtx({
      freshCommitment: makeCommitment({ nonceInvalidated: true }),
    });
    await expect(matchFromPreview(ctx, preview)).rejects.toThrow(/nonce was invalidated/);
  });

  it('expiry passed (wall-clock advanced; signed expiry unchanged) → throws', async () => {
    // Simulate: the preview was prepared moments before expiry; fresh
    // commitment is byte-identical (canonical field check passes); but
    // wall-clock now is past the expiry. Mock Date.now to advance.
    const nearFutureExpiry = '2026-05-09T12:00:00Z';
    const expirySec = Math.floor(new Date(nearFutureExpiry).getTime() / 1000);
    const preview = buildPreview({
      commitment: makeCommitment({ expiry: nearFutureExpiry }),
    });
    const { ctx } = buildCtx({
      freshCommitment: makeCommitment({ expiry: nearFutureExpiry }),
    });
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue((expirySec + 60) * 1000); // 1 minute past expiry
    try {
      await expect(matchFromPreview(ctx, preview)).rejects.toThrow(/expiry passed/);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('remainingRiskAmount shrunk below previewed fill → throws', async () => {
    const preview = buildPreview();
    // Preview's fillMakerRisk is 1_000_000 (full fill of 1 USDC). Now remaining = 500_000.
    const { ctx } = buildCtx({
      freshCommitment: makeCommitment({ remainingRiskAmount: '500000' }),
    });
    await expect(matchFromPreview(ctx, preview)).rejects.toThrow(/remaining capacity shrunk/);
  });

  it('canonical signed field changed → throws (with field name)', async () => {
    const preview = buildPreview();
    // Change oddsTick — a signed field. The signature on the row is no
    // longer the one the preview committed to.
    const { ctx } = buildCtx({
      freshCommitment: makeCommitment({ oddsTick: 191 }),
    });
    await expect(matchFromPreview(ctx, preview)).rejects.toThrow(/oddsTick.*changed between preview and re-fetch/);
  });
});

describe('matchFromPreview — speculation transitions', () => {
  it('lazy preview → existing now: throws (preview was overly cautious; let user re-confirm)', async () => {
    const preview = buildPreview({
      speculation: { mode: 'lazy', speculationId: null, speculationKey: '0x'.padEnd(66, 'a') },
    });
    // Contest now has the matching open speculation → mode flips to existing.
    const { ctx } = buildCtx({
      freshContest: buildContest(), // default has a moneyline open spec
    });
    await expect(matchFromPreview(ctx, preview)).rejects.toThrow(/speculation existence changed/i);
  });

  it('existing preview → spec is now closed: throws', async () => {
    const preview = buildPreview();
    const { ctx } = buildCtx({
      freshContest: buildContest({
        speculations: [
          {
            speculationId: '101',
            contestId: '42',
            type: 'moneyline',
            lineTicks: 0,
            line: 0,
            speculationStatus: 1, // closed
          },
        ],
      }),
    });
    await expect(matchFromPreview(ctx, preview)).rejects.toThrow(/now closed.*State changed/);
  });
});

describe('matchFromPreview — allowance recheck', () => {
  it('allowance insufficient on chain → throws OspexAllowanceError', async () => {
    const preview = buildPreview();
    const { ctx } = buildCtx({ takerAllowanceWei6: 100n }); // way less than needed
    await expect(matchFromPreview(ctx, preview)).rejects.toThrow(OspexAllowanceError);
  });
});

describe('matchFromPreview — preview-vs-client guards', () => {
  it('signer changed since preview → throws', async () => {
    const preview = buildPreview();
    const otherTaker = '0x'.padEnd(42, '7') as Hex;
    const { ctx } = buildCtx({ takerAddress: otherTaker });
    await expect(matchFromPreview(ctx, preview)).rejects.toThrow(/Signer address changed/);
  });

  it('chainId mismatch → throws', async () => {
    const preview = buildPreview();
    // Mutate the preview to simulate it was prepared on a different chain.
    const stale: MatchPreview = { ...preview, chainId: 80002 };
    const { ctx } = buildCtx();
    await expect(matchFromPreview(ctx, stale)).rejects.toThrow(/chainId 80002.*configured for chainId 137/);
  });

  it('verifyingContract mismatch → throws', async () => {
    const preview = buildPreview();
    const stale: MatchPreview = {
      ...preview,
      verifyingContract: '0x'.padEnd(42, '9') as Hex,
    };
    const { ctx } = buildCtx();
    await expect(matchFromPreview(ctx, stale)).rejects.toThrow(/verifyingContract.*does not match/);
  });
});

void OspexValidationError; // imported to confirm the throw type at compile time
