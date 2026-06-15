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
  /** `'wait-timeout'`: the broadcast succeeds but `waitForTransactionReceipt`
   * rejects (the M2 shape) — the leg's error carries a txHash but NO receipt. */
  status: 'success' | 'reverted' | 'wait-timeout';
  logs: Array<{ address: `0x${string}`; topics: Hash[]; data: `0x${string}` }>;
}

/** A sequence of on-chain reads for one speculationId, consumed in order
 * across the entry's legs: settle pre-flight + (re-read on revert) come
 * from `getSpeculation` (`{speculationStatus, winSide}`); claim pre-flight
 * + (re-read on revert) come from `getPosition` (`{claimed}`). The last
 * element repeats once the sequence is exhausted. On-chain enum indices:
 * status 0 = Open, 1 = Closed. */
type SpecReadSeq = Array<
  | { speculationStatus: number; winSide: number }
  | { claimed: boolean }
>;

function fakeContext({
  claimParams,
  plannedTxs,
  specStates = {},
  onReadContract,
}: {
  claimParams: ClaimParams;
  plannedTxs: PlannedTx[];
  /** Per-speculationId getSpeculation read sequences (pre-flight, then
   * re-read on a settle revert). Only consulted for pendingSettle
   * entries. */
  specStates?: Record<string, SpecReadSeq>;
  /** Invoked at the start of every getSpeculation read — used to assert
   * read-only modes (dry-run) never touch the chain. */
  onReadContract?: () => void;
}): PositionsContext {
  let txIndex = 0;
  const specReadIdx: Record<string, number> = {};
  const publicClient = {
    readContract: async ({ args }: { args: readonly unknown[] }) => {
      onReadContract?.();
      const id = String(args[0]);
      const seq = specStates[id];
      if (!seq || seq.length === 0) {
        throw new Error(`no spec state configured for speculation ${id}`);
      }
      const i = specReadIdx[id] ?? 0;
      specReadIdx[id] = i + 1;
      return seq[Math.min(i, seq.length - 1)];
    },
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
      if (planned.status === 'wait-timeout') {
        // Broadcast succeeded (sendRawTransaction returned a hash) but the
        // receipt wait fails — the M2 shape. broadcastSignedTx throws
        // OspexChainError({ txHash }) with NO receipt.
        throw Object.assign(new Error('wait timed out'), {
          name: 'WaitForTransactionReceiptTimeoutError',
        });
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
      // Pre-flight read: speculation 2 is still Open → settle proceeds.
      specStates: { '2': [{ speculationStatus: 0, winSide: 0 }] },
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
    // Explicit step record: settle sent, then claim sent.
    expect(result.entries[0]!.steps.map((s) => [s.name, s.outcome])).toEqual([
      ['settleSpeculation', 'sent'],
      ['claimPosition', 'sent'],
    ]);
    // Settle-leg totals breakdown: this run settled fresh.
    expect(result.totals.settledFresh).toBe(1);
    expect(result.totals.alreadySettled).toBe(0);
    expect(result.totals.recoveredAlreadySettled).toBe(0);
    expect(result.totals.claimedFresh).toBe(1);
  });

  it('skips an already-settled speculation and proceeds straight to claim', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `3_${SIGNER_ADDR}_0`,
            speculationId: '3',
            description: 'Away moneyline — Won (stale pendingSettle)',
            bucket: 'pendingSettle',
            result: 'won',
            estimatedPayoutUSDC: 150,
            estimatedPayoutWei6: '150000000',
            txParams: [
              {
                method: 'settleSpeculation',
                target: 'SpeculationModule',
                args: { speculationId: '3' },
              },
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '3', positionType: 0 },
              },
            ],
          },
        ],
      },
      // Pre-flight read: speculation 3 is already Closed (home won) →
      // settle is skipped; only the claim tx is sent.
      specStates: { '3': [{ speculationStatus: 1, winSide: 2 }] },
      plannedTxs: [
        {
          status: 'success',
          logs: [makeClaimedLog(3n, SIGNER_ADDR as `0x${string}`, 0, 150_000_000n)],
        },
      ],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.success).toBe(true);
    const entry = result.entries[0]!;
    expect(entry.success).toBe(true);
    // Only the claim tx landed — settle was skipped, no settle tx.
    expect(entry.txHashes).toHaveLength(1);
    expect(entry.winSide).toBe('home');
    expect(entry.payoutWei6).toBe('150000000');
    expect(entry.steps.map((s) => [s.name, s.outcome])).toEqual([
      ['settleSpeculation', 'skippedAlreadySettled'],
      ['claimPosition', 'sent'],
    ]);
    // Settle-leg totals breakdown: a pre-flight read found it already settled.
    expect(result.totals.settledFresh).toBe(0);
    expect(result.totals.alreadySettled).toBe(1);
    expect(result.totals.recoveredAlreadySettled).toBe(0);
  });

  it('recovers from a concurrent settle (revert + re-read closed) then claims', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `4_${SIGNER_ADDR}_1`,
            speculationId: '4',
            description: 'Under total — Won (raced settle)',
            bucket: 'pendingSettle',
            result: 'won',
            estimatedPayoutUSDC: 120,
            estimatedPayoutWei6: '120000000',
            txParams: [
              {
                method: 'settleSpeculation',
                target: 'SpeculationModule',
                args: { speculationId: '4' },
              },
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '4', positionType: 1 },
              },
            ],
          },
        ],
      },
      // Pre-flight: Open. After the settle reverts on inclusion, the
      // re-read shows Closed (under won) → recovered.
      specStates: {
        '4': [
          { speculationStatus: 0, winSide: 0 },
          { speculationStatus: 1, winSide: 4 },
        ],
      },
      plannedTxs: [
        { status: 'reverted', logs: [] }, // our settle lost the race
        {
          status: 'success',
          logs: [makeClaimedLog(4n, SIGNER_ADDR as `0x${string}`, 1, 120_000_000n)],
        },
      ],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.success).toBe(true);
    const entry = result.entries[0]!;
    expect(entry.success).toBe(true);
    expect(entry.txHashes).toHaveLength(1); // only the claim
    expect(entry.winSide).toBe('under');
    expect(entry.steps.map((s) => [s.name, s.outcome])).toEqual([
      ['settleSpeculation', 'recoveredAlreadySettled'],
      ['claimPosition', 'sent'],
    ]);
    // Settle-leg totals breakdown: a concurrent settle won the race.
    expect(result.totals.settledFresh).toBe(0);
    expect(result.totals.alreadySettled).toBe(0);
    expect(result.totals.recoveredAlreadySettled).toBe(1);
    // This wallet broadcast a settle that reverted on inclusion — keep
    // its hash on the recovered step, but NOT in the confirmed txHashes.
    const settleStep = entry.steps[0]!;
    const claimStep = entry.steps[1]!;
    expect(settleStep.txHash).toBeDefined();
    expect(entry.txHashes).toEqual([claimStep.txHash]);
    expect(entry.txHashes).not.toContain(settleStep.txHash);
  });

  it('aggregates the settle-leg totals breakdown across a mixed multi-entry sweep', async () => {
    // Three pendingSettle entries, one per settle outcome — proves the
    // settle-leg counters SUM across entries (each single-entry test above
    // only pins a count of 1). All three claim legs are fresh.
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `10_${SIGNER_ADDR}_0`,
            speculationId: '10',
            description: 'fresh settle',
            bucket: 'pendingSettle',
            result: 'won',
            estimatedPayoutUSDC: 100,
            estimatedPayoutWei6: '100000000',
            txParams: [
              { method: 'settleSpeculation', target: 'SpeculationModule', args: { speculationId: '10' } },
              { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '10', positionType: 0 } },
            ],
          },
          {
            positionId: `11_${SIGNER_ADDR}_0`,
            speculationId: '11',
            description: 'already settled (pre-flight closed)',
            bucket: 'pendingSettle',
            result: 'won',
            estimatedPayoutUSDC: 50,
            estimatedPayoutWei6: '50000000',
            txParams: [
              { method: 'settleSpeculation', target: 'SpeculationModule', args: { speculationId: '11' } },
              { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '11', positionType: 0 } },
            ],
          },
          {
            positionId: `12_${SIGNER_ADDR}_1`,
            speculationId: '12',
            description: 'recovered settle (race lost)',
            bucket: 'pendingSettle',
            result: 'won',
            estimatedPayoutUSDC: 120,
            estimatedPayoutWei6: '120000000',
            txParams: [
              { method: 'settleSpeculation', target: 'SpeculationModule', args: { speculationId: '12' } },
              { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '12', positionType: 1 } },
            ],
          },
        ],
      },
      specStates: {
        '10': [{ speculationStatus: 0, winSide: 0 }], // Open → settle sent (fresh)
        '11': [{ speculationStatus: 1, winSide: 2 }], // Closed pre-flight → skipped
        '12': [
          { speculationStatus: 0, winSide: 0 }, // Open pre-flight
          { speculationStatus: 1, winSide: 4 }, // Closed re-read after revert → recovered
        ],
      },
      plannedTxs: [
        { status: 'success', logs: [makeSettledLog(10n, 1)] }, // 10 settle
        { status: 'success', logs: [makeClaimedLog(10n, SIGNER_ADDR as `0x${string}`, 0, 100_000_000n)] }, // 10 claim
        { status: 'success', logs: [makeClaimedLog(11n, SIGNER_ADDR as `0x${string}`, 0, 50_000_000n)] }, // 11 claim (settle skipped)
        { status: 'reverted', logs: [] }, // 12 settle lost the race
        { status: 'success', logs: [makeClaimedLog(12n, SIGNER_ADDR as `0x${string}`, 1, 120_000_000n)] }, // 12 claim
      ],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.success).toBe(true);
    expect(result.totals.claimed).toBe(3);
    expect(result.totals.failed).toBe(0);
    // Settle-leg breakdown SUMS across the three entries (one of each outcome).
    expect(result.totals.settledFresh).toBe(1);
    expect(result.totals.alreadySettled).toBe(1);
    expect(result.totals.recoveredAlreadySettled).toBe(1);
    // All three claim legs were fresh; no already/recovered claims.
    expect(result.totals.claimedFresh).toBe(3);
    expect(result.totals.alreadyClaimed).toBe(0);
    expect(result.totals.recoveredAlreadyClaimed).toBe(0);
    // Fresh payout total = the three confirmed claims (100 + 50 + 120).
    expect(result.totals.totalPayoutWei6).toBe('270000000');
  });

  it('still fails clearly on a genuine settle failure (re-read not settled)', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `5_${SIGNER_ADDR}_0`,
            speculationId: '5',
            description: 'Home moneyline — needs settle',
            bucket: 'pendingSettle',
            result: 'won',
            estimatedPayoutUSDC: 90,
            estimatedPayoutWei6: '90000000',
            txParams: [
              {
                method: 'settleSpeculation',
                target: 'SpeculationModule',
                args: { speculationId: '5' },
              },
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '5', positionType: 0 },
              },
            ],
          },
        ],
      },
      // Pre-flight Open; settle reverts; re-read STILL Open → genuine
      // failure, must surface (not recovered).
      specStates: {
        '5': [
          { speculationStatus: 0, winSide: 0 },
          { speculationStatus: 0, winSide: 0 },
        ],
      },
      plannedTxs: [
        { status: 'reverted', logs: [] }, // settle genuinely reverts
      ],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.success).toBe(false);
    const entry = result.entries[0]!;
    expect(entry.success).toBe(false);
    expect(entry.error).toBeDefined();
    expect(entry.txHashes).toHaveLength(0); // claim never attempted
    // The failed step is the settle — not mislabeled as a claim.
    expect(entry.steps.map((s) => [s.name, s.outcome])).toEqual([
      ['settleSpeculation', 'failed'],
    ]);
    // The settle reverted on inclusion — its tx hash must survive on the
    // failed step (the gas-spending failure has to stay auditable).
    expect(entry.steps[0]!.txHash).toBeDefined();
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
    // Per-leg outcome breakdowns are all zero on dry-run (no steps run) —
    // both the claim leg and the new settle leg.
    expect(result.totals.claimedFresh).toBe(0);
    expect(result.totals.alreadyClaimed).toBe(0);
    expect(result.totals.recoveredAlreadyClaimed).toBe(0);
    expect(result.totals.settledFresh).toBe(0);
    expect(result.totals.alreadySettled).toBe(0);
    expect(result.totals.recoveredAlreadySettled).toBe(0);
  });

  it('dry-run stays read-only — no chain read even for a pendingSettle entry', async () => {
    let reads = 0;
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `6_${SIGNER_ADDR}_0`,
            speculationId: '6',
            description: 'Away moneyline — Won (needs settle)',
            bucket: 'pendingSettle',
            result: 'won',
            estimatedPayoutUSDC: 175,
            estimatedPayoutWei6: '175000000',
            txParams: [
              {
                method: 'settleSpeculation',
                target: 'SpeculationModule',
                args: { speculationId: '6' },
              },
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '6', positionType: 0 },
              },
            ],
          },
        ],
      },
      // Configured, but must never be consulted in dry-run.
      specStates: { '6': [{ speculationStatus: 0, winSide: 0 }] },
      plannedTxs: [],
      onReadContract: () => {
        reads += 1;
      },
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR, opts: { dryRun: true } });
    expect(reads).toBe(0); // no getSpeculation read happened
    expect(result.entries[0]!.txHashes).toEqual([]);
    expect(result.entries[0]!.steps).toEqual([]); // no steps executed in dry-run
    expect(result.entries[0]!.payoutWei6).toBe('175000000');
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

  it('treats an already-claimed claimable entry as success — skipped, no tx, no payout', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `1_${SIGNER_ADDR}_0`,
            speculationId: '1',
            description: 'Lakers moneyline — Won (already claimed)',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 191,
            estimatedPayoutWei6: '191000000',
            txParams: [
              { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '1', positionType: 0 } },
            ],
          },
        ],
      },
      // Claim-leg pre-flight read: position already claimed → skip the tx.
      specStates: { '1': [{ claimed: true }] },
      plannedTxs: [], // no claim tx sent
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.success).toBe(true);
    const entry = result.entries[0]!;
    expect(entry.success).toBe(true);
    expect(entry.txHashes).toEqual([]);
    expect(entry.payoutWei6).toBeUndefined(); // no derived payout
    expect(entry.steps.map((s) => [s.name, s.outcome])).toEqual([
      ['claimPosition', 'skippedAlreadyClaimed'],
    ]);
    // Successful ENTRY, but no FRESH claim — totals must separate them, and
    // the already-claimed payout must NOT enter the run's realized total.
    expect(result.totals.claimed).toBe(1);
    expect(result.totals.claimedFresh).toBe(0);
    expect(result.totals.alreadyClaimed).toBe(1);
    expect(result.totals.recoveredAlreadyClaimed).toBe(0);
    expect(result.totals.totalPayoutWei6).toBe('0');
    expect(result.totals.totalPayoutUSDC).toBe(0);
  });

  it('recovers from an already-claimed claim revert — reverted hash kept off confirmed txHashes', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `1_${SIGNER_ADDR}_0`,
            speculationId: '1',
            description: 'Lakers moneyline — Won (raced claim)',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 191,
            estimatedPayoutWei6: '191000000',
            txParams: [
              { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '1', positionType: 0 } },
            ],
          },
        ],
      },
      // Pre-flight unclaimed; our claim reverts on inclusion; re-read shows
      // claimed → recovered (a concurrent caller / rerun beat us).
      specStates: { '1': [{ claimed: false }, { claimed: true }] },
      plannedTxs: [{ status: 'reverted', logs: [] }],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.success).toBe(true);
    const entry = result.entries[0]!;
    expect(entry.success).toBe(true);
    expect(entry.payoutWei6).toBeUndefined();
    expect(entry.steps.map((s) => [s.name, s.outcome])).toEqual([
      ['claimPosition', 'recoveredAlreadyClaimed'],
    ]);
    // The reverted claim spent gas — its hash survives on the step but never
    // enters the confirmed-only `txHashes`.
    const claimStep = entry.steps[0]!;
    expect(claimStep.txHash).toBeDefined();
    expect(entry.txHashes).toEqual([]);
    expect(entry.txHashes).not.toContain(claimStep.txHash);
    expect(result.totals.recoveredAlreadyClaimed).toBe(1);
    expect(result.totals.claimedFresh).toBe(0);
    expect(result.totals.totalPayoutWei6).toBe('0');
  });

  it('excludes already-claimed entries from fresh payout totals (mixed sweep)', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `1_${SIGNER_ADDR}_0`,
            speculationId: '1',
            description: 'Fresh win',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 50,
            estimatedPayoutWei6: '50000000',
            txParams: [
              { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '1', positionType: 0 } },
            ],
          },
          {
            positionId: `2_${SIGNER_ADDR}_0`,
            speculationId: '2',
            description: 'Already claimed win',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 999,
            estimatedPayoutWei6: '999000000',
            txParams: [
              { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '2', positionType: 0 } },
            ],
          },
        ],
      },
      specStates: {
        '1': [{ claimed: false }], // fresh
        '2': [{ claimed: true }], // already claimed
      },
      plannedTxs: [
        // Only entry 1 sends a claim tx.
        { status: 'success', logs: [makeClaimedLog(1n, SIGNER_ADDR as `0x${string}`, 0, 50_000_000n)] },
      ],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.success).toBe(true);
    expect(result.entries[0]!.payoutWei6).toBe('50000000');
    expect(result.entries[1]!.payoutWei6).toBeUndefined();
    expect(result.totals.claimed).toBe(2); // both entries succeeded
    expect(result.totals.claimedFresh).toBe(1);
    expect(result.totals.alreadyClaimed).toBe(1);
    // The $999 already-claimed payout must NOT leak into the realized total.
    expect(result.totals.totalPayoutWei6).toBe('50000000');
    expect(result.totals.totalPayoutUSDC).toBeCloseTo(50, 6);
  });

  // #98 review blocker (end-to-end): a claim tx that SUCCEEDS but whose
  // receipt has no parseable POSITION_CLAIMED event must FAIL the entry —
  // never be silently relabeled an already-claimed skip/recover with the
  // payout dropped. (The success receipt carries no reverted receipt, so the
  // SDK's recovery gate correctly declines to recover.)
  it('fails the entry on a confirmed-but-unparseable claim (no silent recovery)', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `1_${SIGNER_ADDR}_0`,
            speculationId: '1',
            description: 'Won but event unparseable',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 191,
            estimatedPayoutWei6: '191000000',
            txParams: [
              { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '1', positionType: 0 } },
            ],
          },
        ],
      },
      specStates: { '1': [{ claimed: false }] }, // pre-flight unclaimed
      // Tx confirms (success) but carries NO POSITION_CLAIMED log → claim()
      // throws "no matching POSITION_CLAIMED event".
      plannedTxs: [{ status: 'success', logs: [] }],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.success).toBe(false);
    const entry = result.entries[0]!;
    expect(entry.success).toBe(false);
    expect(entry.error?.message).toMatch(/POSITION_CLAIMED/i);
    expect(entry.steps.map((s) => [s.name, s.outcome])).toEqual([['claimPosition', 'failed']]);
    // The failed step keeps the (confirmed) tx hash for audit, and records its
    // TRUE on-chain status — `confirmed`, NOT reverted. The tx landed; the
    // SDK just couldn't parse the payout event. This is what lets the CLI
    // envelope avoid mislabeling it a reverted tx (PR #98 review round 2).
    const step = entry.steps[0]!;
    expect(step.txHash).toBeDefined();
    expect(step.txStatus).toBe('confirmed');
    // Not counted as a fresh/already/recovered claim, and no payout.
    expect(result.totals.claimedFresh).toBe(0);
    expect(result.totals.alreadyClaimed).toBe(0);
    expect(result.totals.recoveredAlreadyClaimed).toBe(0);
    expect(result.totals.totalPayoutWei6).toBe('0');
  });

  // M2 regression: a claim leg whose receipt wait times out (broadcast ok, no
  // receipt) must fail the entry, KEEP the txHash for audit, and record
  // txStatus UNDEFINED — never 'reverted'. The tx may still be mined; tagging
  // it reverted would mis-account a possibly-successful claim. (failedStep
  // sets txHash from err.txHash but leaves txStatus unset when err.receipt is
  // absent.)
  it('a receipt-wait-timeout claim keeps txHash but leaves txStatus undefined on the failed step (M2)', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `1_${SIGNER_ADDR}_0`,
            speculationId: '1',
            description: 'Broadcast ok, receipt wait timed out',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 10,
            estimatedPayoutWei6: '10000000',
            txParams: [
              { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '1', positionType: 0 } },
            ],
          },
        ],
      },
      specStates: { '1': [{ claimed: false }] }, // pre-flight unclaimed
      plannedTxs: [{ status: 'wait-timeout', logs: [] }],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.entries[0]!.success).toBe(false);
    const step = result.entries[0]!.steps[0]!;
    expect(step.outcome).toBe('failed');
    expect(step.txHash).toBeDefined(); // hash preserved for reconciliation
    expect(step.txStatus).toBeUndefined(); // status UNKNOWN — not reverted
    // No payout booked, not counted as a successful/recovered claim.
    expect(result.totals.totalPayoutWei6).toBe('0');
  });

  // Symmetric check: a genuine on-chain revert records txStatus 'reverted'.
  it('a genuinely reverted claim records txStatus reverted on the failed step', async () => {
    const ctx = fakeContext({
      claimParams: {
        address: SIGNER_ADDR,
        positions: [
          {
            positionId: `1_${SIGNER_ADDR}_0`,
            speculationId: '1',
            description: 'Reverts on inclusion (and stays reverted)',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 10,
            estimatedPayoutWei6: '10000000',
            txParams: [
              { method: 'claimPosition', target: 'PositionModule', args: { speculationId: '1', positionType: 0 } },
            ],
          },
        ],
      },
      // Pre-flight unclaimed; claim reverts on inclusion; re-read STILL
      // unclaimed → genuine failure (not a benign already-claimed race).
      specStates: { '1': [{ claimed: false }, { claimed: false }] },
      plannedTxs: [{ status: 'reverted', logs: [] }],
    });

    const result = await claimAll(ctx, { address: SIGNER_ADDR });
    expect(result.entries[0]!.success).toBe(false);
    const step = result.entries[0]!.steps[0]!;
    expect(step.outcome).toBe('failed');
    expect(step.txHash).toBeDefined();
    expect(step.txStatus).toBe('reverted');
  });
});
