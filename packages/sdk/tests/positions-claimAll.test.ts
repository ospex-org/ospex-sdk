/**
 * `client.positions.claimAll` — multi-step txParams handling, per-position
 * failure isolation, dry-run path.
 *
 * Heavier mock surface than the single-method tests: we mock the
 * PositionsApi.claimParams to return a canned plan, then drive the
 * claim+settle pipeline with a programmable fake chain client whose
 * receipts can be flipped per-tx to simulate partial failures.
 */

import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toBytes,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { claimAll } from '../src/positions/claimAll.js';
import type { PositionsContext } from '../src/positions/context.js';
import type { ClaimParams } from '../src/types/position.js';
import type { Signer } from '../src/types/signer.js';

const SIGNER_ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';
const OSPEX_CORE = '0x0000000000000000000000000000000000abcdef' as `0x${string}`;

const EVENT_TYPE_CLAIMED = keccak256(toBytes('POSITION_CLAIMED'));
const EVENT_TYPE_SETTLED = keccak256(toBytes('SPECULATION_SETTLED'));

const CORE_EVENT_EMITTED_ABI = [
  {
    type: 'event',
    name: 'CoreEventEmitted',
    inputs: [
      { name: 'eventType', type: 'bytes32', indexed: true },
      { name: 'emitter', type: 'address', indexed: true },
      { name: 'eventData', type: 'bytes', indexed: false },
    ],
    anonymous: false,
  },
] as const;

function makeClaimedLog(
  speculationId: bigint,
  user: `0x${string}`,
  positionType: 0 | 1,
  payout: bigint,
): { address: `0x${string}`; topics: Hash[]; data: `0x${string}` } {
  const innerEventData = encodeAbiParameters(
    [
      { name: 'speculationId', type: 'uint256' },
      { name: 'user', type: 'address' },
      { name: 'positionType', type: 'uint8' },
      { name: 'payout', type: 'uint256' },
    ],
    [speculationId, user, positionType, payout],
  );
  const wrappedData = encodeAbiParameters([{ type: 'bytes' }], [innerEventData]);
  const topics = encodeEventTopics({
    abi: CORE_EVENT_EMITTED_ABI,
    eventName: 'CoreEventEmitted',
    args: { eventType: EVENT_TYPE_CLAIMED, emitter: OSPEX_CORE },
  });
  return {
    address: OSPEX_CORE,
    topics: topics as Hash[],
    data: wrappedData,
  };
}

function makeSettledLog(
  speculationId: bigint,
  winSideEnum: number,
): { address: `0x${string}`; topics: Hash[]; data: `0x${string}` } {
  const innerEventData = encodeAbiParameters(
    [
      { name: 'speculationId', type: 'uint256' },
      { name: 'winSide', type: 'uint8' },
      { name: 'scorer', type: 'address' },
    ],
    [speculationId, winSideEnum, '0x' + 'cd'.repeat(20) as `0x${string}`],
  );
  const wrappedData = encodeAbiParameters([{ type: 'bytes' }], [innerEventData]);
  const topics = encodeEventTopics({
    abi: CORE_EVENT_EMITTED_ABI,
    eventName: 'CoreEventEmitted',
    args: { eventType: EVENT_TYPE_SETTLED, emitter: OSPEX_CORE },
  });
  return {
    address: OSPEX_CORE,
    topics: topics as Hash[],
    data: wrappedData,
  };
}

interface PlannedTx {
  status: 'success' | 'reverted';
  logs: Array<{ address: `0x${string}`; topics: Hash[]; data: `0x${string}` }>;
}

function fakeContext({
  claimParams,
  plannedTxs,
}: {
  claimParams: ClaimParams;
  plannedTxs: PlannedTx[];
}): PositionsContext {
  let txIndex = 0;
  const publicClient = {
    sendRawTransaction: async () => {
      const idx = txIndex;
      const txHash = (`0x${String(idx + 1).padStart(64, '0')}`) as Hash;
      return txHash;
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hash }) => {
      const planned = plannedTxs[txIndex];
      txIndex += 1;
      if (!planned) {
        throw new Error(`unexpected tx ${hash} (index ${txIndex - 1})`);
      }
      return {
        status: planned.status,
        transactionHash: hash,
        blockNumber: BigInt(12345 + txIndex),
        logs: planned.logs,
      } as unknown as TransactionReceipt;
    },
    getTransactionCount: async () => 7,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 50n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => 80_000n,
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => SIGNER_ADDR as `0x${string}`,
    signTypedData: async () => '0xdead' as `0x${string}`,
    signTransaction: async () => '0xfeed' as `0x${string}`,
  };

  return {
    api: { request: async () => ({}) } as unknown as PositionsContext['api'],
    positionsApi: {
      claimParams: async () => claimParams,
    } as unknown as PositionsContext['positionsApi'],
    requireSigner: () => signer,
    getChainId: () => 137,
    getAddresses: () =>
      ({
        matchingModule: '0x' + '11'.repeat(20),
        positionModule: '0x' + '22'.repeat(20),
        usdc: '0x' + '33'.repeat(20),
        ospexCore: OSPEX_CORE,
        speculationModule: '0x' + '44'.repeat(20),
        contestModule: '0x' + '55'.repeat(20),
        leaderboardModule: '0x' + '66'.repeat(20),
        rulesModule: '0x' + '77'.repeat(20),
        treasuryModule: '0x' + '88'.repeat(20),
        secondaryMarketModule: '0x' + '99'.repeat(20),
        oracleModule: '0x' + 'aa'.repeat(20),
        scorers: {
          moneyline: '0x' + 'bb'.repeat(20),
          spread: '0x' + 'cc'.repeat(20),
          total: '0x' + 'dd'.repeat(20),
        },
      }) as unknown as ReturnType<PositionsContext['getAddresses']>,
    requireChainClient: () => publicClient,
  };
}

describe('positions.claimAll', () => {
  it('runs a single claim step for a claimable entry', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `1_${SIGNER_ADDR}_0`,
            speculationId: '1',
            description: 'Lakers moneyline — Won',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 191,
            estimatedPayoutWei6: '191000000',
            txParams: [
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '1', positionType: 0 },
              },
            ],
          },
        ],
      },
      plannedTxs: [
        {
          status: 'success',
          logs: [makeClaimedLog(1n, SIGNER_ADDR as `0x${string}`, 0, 191_000_000n)],
        },
      ],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.success).toBe(true);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.success).toBe(true);
    expect(entry.txHashes).toHaveLength(1);
    expect(entry.payoutWei6).toBe('191000000');
    expect(entry.payoutUSDC).toBeCloseTo(191, 6);
    expect(result.totals.claimed).toBe(1);
    expect(result.totals.failed).toBe(0);
  });

  it('runs settle then claim for a pendingSettle entry', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `2_${SIGNER_ADDR}_0`,
            speculationId: '2',
            description: 'Away moneyline — Won (needs settle)',
            bucket: 'pendingSettle',
            result: 'won',
            estimatedPayoutUSDC: 200,
            estimatedPayoutWei6: '200000000',
            txParams: [
              {
                method: 'settleSpeculation',
                target: 'SpeculationModule',
                args: { speculationId: '2' },
              },
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '2', positionType: 0 },
              },
            ],
          },
        ],
      },
      plannedTxs: [
        { status: 'success', logs: [makeSettledLog(2n, 1)] },
        {
          status: 'success',
          logs: [makeClaimedLog(2n, SIGNER_ADDR as `0x${string}`, 0, 200_000_000n)],
        },
      ],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.success).toBe(true);
    expect(result.entries[0]!.txHashes).toHaveLength(2);
    expect(result.entries[0]!.winSide).toBe('away');
    expect(result.entries[0]!.payoutWei6).toBe('200000000');
  });

  it('isolates per-entry failures — one bad entry does not abort the rest', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `1_${SIGNER_ADDR}_0`,
            speculationId: '1',
            description: 'A',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 50,
            estimatedPayoutWei6: '50000000',
            txParams: [
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '1', positionType: 0 },
              },
            ],
          },
          {
            positionId: `2_${SIGNER_ADDR}_0`,
            speculationId: '2',
            description: 'B',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 75,
            estimatedPayoutWei6: '75000000',
            txParams: [
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '2', positionType: 0 },
              },
            ],
          },
        ],
      },
      plannedTxs: [
        // Entry 1 reverts.
        { status: 'reverted', logs: [] },
        // Entry 2 succeeds.
        {
          status: 'success',
          logs: [makeClaimedLog(2n, SIGNER_ADDR as `0x${string}`, 0, 75_000_000n)],
        },
      ],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.success).toBe(false);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.success).toBe(false);
    expect(result.entries[0]!.error).toBeDefined();
    expect(result.entries[1]!.success).toBe(true);
    expect(result.entries[1]!.payoutWei6).toBe('75000000');
    expect(result.totals.claimed).toBe(1);
    expect(result.totals.failed).toBe(1);
  });

  it('dry-run skips all on-chain work and returns the action plan', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `1_${SIGNER_ADDR}_0`,
            speculationId: '1',
            description: 'A',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 50,
            estimatedPayoutWei6: '50000000',
            txParams: [
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '1', positionType: 0 },
              },
            ],
          },
        ],
      },
      plannedTxs: [], // none expected
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR, opts: { dryRun: true } });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.success).toBe(true);
    expect(result.entries[0]!.txHashes).toEqual([]);
    expect(result.entries[0]!.payoutWei6).toBe('50000000');
    expect(result.success).toBe(false); // dry-run never reports success
    // Predicted-payout totals are aggregated in dry-run too — otherwise
    // the CLI summary line shows "$0.00" while every entry shows a
    // non-zero predicted payout.
    expect(result.totals.totalPayoutWei6).toBe('50000000');
    expect(result.totals.totalPayoutUSDC).toBeCloseTo(50, 6);
  });

  it('rejects live-mode --address that does not match the configured signer', async () => {
    const otherWallet = ('0x' + 'ee'.repeat(20)) as `0x${string}`;
    const ctx = fakeContext({
      claimParams: { address: SIGNER_ADDR, positions: [] },
      plannedTxs: [],
    });
    // No `opts.dryRun` — live mode. Address differs from the signer.
    await expect(
      claimAll(ctx, { address: otherWallet }),
    ).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'address',
      message: expect.stringMatching(/does not match the configured signer/i),
    });
  });

  it('allows dry-run for any address even when the signer is different', async () => {
    const otherWallet = ('0x' + 'ee'.repeat(20)) as `0x${string}`;
    const ctx = fakeContext({
      claimParams: {
        address: otherWallet,
        positions: [
          {
            positionId: `7_${otherWallet}_0`,
            speculationId: '7',
            description: 'X',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 25,
            estimatedPayoutWei6: '25000000',
            txParams: [
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '7', positionType: 0 },
              },
            ],
          },
        ],
      },
      plannedTxs: [], // none expected
    });
    // Dry-run + cross-wallet inspection: no signer ↔ address coupling.
    const result = await claimAll(ctx, { address: otherWallet, opts: { dryRun: true } });
    expect(result.address).toBe(otherWallet.toLowerCase());
    expect(result.entries).toHaveLength(1);
    expect(result.totals.totalPayoutWei6).toBe('25000000');
  });

  it('defaults --address to the signer when omitted in live mode', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `9_${SIGNER_ADDR}_0`,
            speculationId: '9',
            description: 'D',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 10,
            estimatedPayoutWei6: '10000000',
            txParams: [
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '9', positionType: 0 },
              },
            ],
          },
        ],
      },
      plannedTxs: [
        {
          status: 'success',
          logs: [makeClaimedLog(9n, SIGNER_ADDR as `0x${string}`, 0, 10_000_000n)],
        },
      ],
    });
    const result = await claimAll(ctx); // no address, no dryRun
    expect(result.address).toBe(SIGNER_ADDR);
    expect(result.success).toBe(true);
    expect(result.entries[0]!.payoutWei6).toBe('10000000');
  });

  it('rejects unknown txParams.method values forward-compatibly', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `1_${SIGNER_ADDR}_0`,
            speculationId: '1',
            description: 'A',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 50,
            estimatedPayoutWei6: '50000000',
            txParams: [
              {
                method: 'futureMethod' as unknown as 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '1', positionType: 0 },
              },
            ],
          },
        ],
      },
      plannedTxs: [],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.entries[0]!.success).toBe(false);
    expect(result.entries[0]!.error?.message).toMatch(/unrecognized txParams.method/i);
  });

  it('returns empty entries when there is nothing to do', async () => {
    const ctx = fakeContext({
      claimParams: { address: SIGNER_ADDR, positions: [] },
      plannedTxs: [],
    });
    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.entries).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.totals.claimed).toBe(0);
  });
});
