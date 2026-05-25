/**
 * `client.positions.ensureSpeculationSettled` — the idempotent settle
 * path. Six branches:
 *   1. pre-flight read Open  → sends settle           → 'settled'
 *   2. pre-flight read Closed → no tx                 → 'alreadySettled'
 *   3. Open, settle pre-send-reverts AlreadySettled,
 *      re-read Closed                                 → 'recovered'
 *   4. Open, settle reverts (not AlreadySettled),
 *      re-read still Open                             → rethrows clearly
 *   5. pre-flight read fails → falls through, settle ok → 'settled'
 *   6. Open, inclusion-time revert (no selector),
 *      re-read Closed                                 → 'recovered'
 *
 * The chain client is faked: `readContract` is driven by a queue of
 * getSpeculation responses, and the settle pipeline (estimateGas →
 * sign → broadcast → receipt) is programmable per test.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toBytes,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { ensureSpeculationSettled } from '../src/positions/ensureSettled.js';
import { OspexChainError } from '../src/errors.js';
import type { PositionsContext } from '../src/positions/context.js';
import type { Signer } from '../src/types/signer.js';

const SIGNER_ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';
const OSPEX_CORE = '0x0000000000000000000000000000000000abcdef' as `0x${string}`;
const SPECULATION_MODULE = '0x0000000000000000000000000000000000beef00' as `0x${string}`;

const EVENT_TYPE_SETTLED = keccak256(toBytes('SPECULATION_SETTLED'));
const ALREADY_SETTLED_SELECTOR = keccak256(
  toBytes('SpeculationModule__AlreadySettled()'),
).slice(0, 10);

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
    [speculationId, winSideEnum, ('0x' + 'cd'.repeat(20)) as `0x${string}`],
  );
  const wrappedData = encodeAbiParameters([{ type: 'bytes' }], [innerEventData]);
  const topics = encodeEventTopics({
    abi: CORE_EVENT_EMITTED_ABI,
    eventName: 'CoreEventEmitted',
    args: { eventType: EVENT_TYPE_SETTLED, emitter: OSPEX_CORE },
  });
  return { address: OSPEX_CORE, topics: topics as Hash[], data: wrappedData };
}

type SpecRead = { speculationStatus: number; winSide: number } | Error;

function fakeCtx(opts: {
  reads: SpecRead[];
  estimateGas?: () => Promise<bigint>;
  receiptStatus?: 'success' | 'reverted';
  settleLog?: { address: `0x${string}`; topics: Hash[]; data: `0x${string}` };
}): { ctx: PositionsContext; sendRaw: ReturnType<typeof vi.fn> } {
  let readIdx = 0;
  const sendRaw = vi.fn(async () => ('0x' + 'aa'.repeat(32)) as Hash);
  const receipt = {
    status: opts.receiptStatus ?? 'success',
    transactionHash: ('0x' + 'aa'.repeat(32)) as Hash,
    blockNumber: 12345n,
    logs: opts.settleLog ? [opts.settleLog] : [],
  } as unknown as TransactionReceipt;

  const publicClient = {
    readContract: async () => {
      const r = opts.reads[readIdx++];
      if (r === undefined) throw new Error(`unexpected readContract call #${readIdx}`);
      if (r instanceof Error) throw r;
      return r;
    },
    sendRawTransaction: sendRaw,
    waitForTransactionReceipt: async () => receipt,
    getTransactionCount: async () => 7,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 50n, maxPriorityFeePerGas: 1n }),
    estimateGas: opts.estimateGas ?? (async () => 80_000n),
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => SIGNER_ADDR as `0x${string}`,
    signTypedData: async () => '0xdead' as `0x${string}`,
    signTransaction: async () => '0xfeed' as `0x${string}`,
  };

  const ctx: PositionsContext = {
    api: { request: async () => ({}) } as unknown as PositionsContext['api'],
    positionsApi: {} as unknown as PositionsContext['positionsApi'],
    requireSigner: () => signer,
    getChainId: () => 137,
    getAddresses: () =>
      ({
        matchingModule: '0x' + '11'.repeat(20),
        positionModule: '0x' + '22'.repeat(20),
        usdc: '0x' + '33'.repeat(20),
        ospexCore: OSPEX_CORE,
        speculationModule: SPECULATION_MODULE,
        contestModule: '0x' + '44'.repeat(20),
        leaderboardModule: '0x' + '55'.repeat(20),
        rulesModule: '0x' + '66'.repeat(20),
        treasuryModule: '0x' + '77'.repeat(20),
        secondaryMarketModule: '0x' + '88'.repeat(20),
        oracleModule: '0x' + '99'.repeat(20),
        scorers: {
          moneyline: '0x' + 'aa'.repeat(20),
          spread: '0x' + 'bb'.repeat(20),
          total: '0x' + 'cc'.repeat(20),
        },
      }) as unknown as ReturnType<PositionsContext['getAddresses']>,
    requireChainClient: () => publicClient,
  };
  return { ctx, sendRaw };
}

/** An error shaped like a viem pre-send revert carrying raw revert data. */
function revertWithData(data: string): Error {
  return Object.assign(new Error('execution reverted'), { data });
}

describe('positions.ensureSpeculationSettled', () => {
  it('1. sends the settle tx when the speculation is still open', async () => {
    const { ctx, sendRaw } = fakeCtx({
      reads: [{ speculationStatus: 0, winSide: 0 }], // pre-flight: Open
      settleLog: makeSettledLog(42n, 1), // away
    });
    const r = await ensureSpeculationSettled(ctx, { speculationId: 42n });
    expect(r.outcome).toBe('settled');
    expect(r.winSide).toBe('away');
    expect(r.txHash).toMatch(/^0x[0-9a-f]+$/);
    expect(sendRaw).toHaveBeenCalledTimes(1);
  });

  it('2. skips the tx when the speculation is already settled (pre-flight)', async () => {
    const { ctx, sendRaw } = fakeCtx({
      reads: [{ speculationStatus: 1, winSide: 1 }], // pre-flight: Closed, away
    });
    const r = await ensureSpeculationSettled(ctx, { speculationId: 42n });
    expect(r.outcome).toBe('alreadySettled');
    expect(r.winSide).toBe('away');
    expect(r.txHash).toBeUndefined();
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it('3. recovers when a concurrent settle pre-send-reverts AlreadySettled (no tx broadcast)', async () => {
    const { ctx, sendRaw } = fakeCtx({
      reads: [
        { speculationStatus: 0, winSide: 0 }, // pre-flight: Open
        { speculationStatus: 1, winSide: 2 }, // re-read: Closed, home
      ],
      estimateGas: async () => {
        throw revertWithData(ALREADY_SETTLED_SELECTOR);
      },
    });
    const r = await ensureSpeculationSettled(ctx, { speculationId: 42n });
    expect(r.outcome).toBe('recovered');
    expect(r.winSide).toBe('home');
    expect(r.txHash).toBeUndefined();
    // Pre-send revert — nothing was broadcast, so no reverted tx hash.
    expect(r.revertedTxHash).toBeUndefined();
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it('4. rethrows a genuine settle failure (not already-settled, re-read still open)', async () => {
    const { ctx } = fakeCtx({
      reads: [
        { speculationStatus: 0, winSide: 0 }, // pre-flight: Open
        { speculationStatus: 0, winSide: 0 }, // re-read: still Open
      ],
      estimateGas: async () => {
        throw revertWithData('0xdeadbeef'); // some other revert
      },
    });
    await expect(ensureSpeculationSettled(ctx, { speculationId: 42n })).rejects.toBeInstanceOf(
      OspexChainError,
    );
  });

  it('5. degrades gracefully when the pre-flight read fails, then settles', async () => {
    const { ctx, sendRaw } = fakeCtx({
      reads: [new Error('rpc hiccup')], // pre-flight read throws
      settleLog: makeSettledLog(42n, 3), // over
    });
    const r = await ensureSpeculationSettled(ctx, { speculationId: 42n });
    expect(r.outcome).toBe('settled');
    expect(r.winSide).toBe('over');
    expect(sendRaw).toHaveBeenCalledTimes(1);
  });

  it('6. recovers from an inclusion-time revert (no decoded selector) via re-read, preserving the reverted tx hash', async () => {
    const { ctx, sendRaw } = fakeCtx({
      reads: [
        { speculationStatus: 0, winSide: 0 }, // pre-flight: Open
        { speculationStatus: 1, winSide: 4 }, // re-read: Closed, under
      ],
      receiptStatus: 'reverted', // estimateGas ok, but the mined tx reverts
    });
    const r = await ensureSpeculationSettled(ctx, { speculationId: 42n });
    expect(r.outcome).toBe('recovered');
    expect(r.winSide).toBe('under');
    expect(r.txHash).toBeUndefined(); // not a confirmed settle
    // This wallet DID broadcast a settle that reverted — the audit trail
    // must keep its hash.
    expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(r.revertedTxHash).toBe(('0x' + 'aa'.repeat(32)) as `0x${string}`);
  });

  it('rejects a non-positive speculationId before any chain work', async () => {
    const { ctx, sendRaw } = fakeCtx({ reads: [] });
    await expect(ensureSpeculationSettled(ctx, { speculationId: 0n })).rejects.toBeInstanceOf(
      OspexChainError,
    );
    expect(sendRaw).not.toHaveBeenCalled();
  });
});
