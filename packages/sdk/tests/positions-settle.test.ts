/**
 * `client.positions.settleSpeculation` — happy path + revert path.
 *
 * Mocks the chain client (sendRawTransaction + waitForTransactionReceipt)
 * and the signer (getAddress + signTransaction). The SPECULATION_SETTLED
 * event log is constructed inline so we exercise the receipt-parsing
 * branch end-to-end.
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
import { settleSpeculation } from '../src/positions/settle.js';
import { OspexChainError } from '../src/errors.js';
import type { PositionsContext } from '../src/positions/context.js';
import type { Signer } from '../src/types/signer.js';

const SIGNER_ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';
const OSPEX_CORE = '0x0000000000000000000000000000000000abcdef';
const SPECULATION_MODULE = '0x0000000000000000000000000000000000beef00';

const EVENT_TYPE_SETTLED = keccak256(toBytes('SPECULATION_SETTLED'));
const EVENT_TYPE_OTHER = keccak256(toBytes('SOMETHING_ELSE'));

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
  scorer: `0x${string}`,
  emitter: `0x${string}`,
  eventType: `0x${string}` = EVENT_TYPE_SETTLED,
): { address: `0x${string}`; topics: Hash[]; data: `0x${string}` } {
  const innerEventData = encodeAbiParameters(
    [
      { name: 'speculationId', type: 'uint256' },
      { name: 'winSide', type: 'uint8' },
      { name: 'scorer', type: 'address' },
    ],
    [speculationId, winSideEnum, scorer],
  );
  // The event's non-indexed param is `eventData: bytes`, so the log's
  // `data` field is the ABI-encoded form of that single `bytes` value
  // (offset + length + payload), not the raw inner bytes.
  const wrappedData = encodeAbiParameters([{ type: 'bytes' }], [innerEventData]);
  // Use viem's helper so the event-signature topic exactly matches what
  // viem's decoder will compute.
  const topics = encodeEventTopics({
    abi: CORE_EVENT_EMITTED_ABI,
    eventName: 'CoreEventEmitted',
    args: { eventType, emitter },
  });
  return {
    address: emitter,
    topics: topics as Hash[],
    data: wrappedData,
  };
}

interface FakeClientCalls {
  sentRaw: string[];
  waited: Hash[];
}

function fakeContext({
  status = 'success' as 'success' | 'reverted',
  txHash = ('0x' + 'aa'.repeat(32)) as Hash,
  logs = [] as Array<{ address: `0x${string}`; topics: Hash[]; data: `0x${string}` }>,
  ospexCore = OSPEX_CORE as `0x${string}`,
  speculationModule = SPECULATION_MODULE as `0x${string}`,
  signer,
}: {
  status?: 'success' | 'reverted';
  txHash?: Hash;
  logs?: Array<{ address: `0x${string}`; topics: Hash[]; data: `0x${string}` }>;
  ospexCore?: `0x${string}`;
  speculationModule?: `0x${string}`;
  signer?: Signer;
} = {}): { ctx: PositionsContext; calls: FakeClientCalls } {
  const calls: FakeClientCalls = { sentRaw: [], waited: [] };
  const receipt = {
    status,
    transactionHash: txHash,
    blockNumber: 12345n,
    logs,
  } as unknown as TransactionReceipt;
  const publicClient = {
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: string }) => {
      calls.sentRaw.push(serializedTransaction);
      return txHash;
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hash }) => {
      calls.waited.push(hash);
      return receipt;
    },
    getTransactionCount: async () => 7,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 50n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => 80_000n,
  } as unknown as PublicClient;

  const fakeSigner: Signer = signer ?? {
    getAddress: async () => SIGNER_ADDR as `0x${string}`,
    signTypedData: async () => '0xdead' as `0x${string}`,
    signTransaction: async () => '0xfeed' as `0x${string}`,
  };

  const ctx: PositionsContext = {
    api: { request: async () => ({}) } as unknown as PositionsContext['api'],
    positionsApi: {} as unknown as PositionsContext['positionsApi'],
    requireSigner: () => fakeSigner,
    getChainId: () => 137,
    getAddresses: () =>
      ({
        matchingModule: '0x' + '11'.repeat(20),
        positionModule: '0x' + '22'.repeat(20),
        usdc: '0x' + '33'.repeat(20),
        ospexCore,
        speculationModule,
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
  return { ctx, calls };
}

describe('positions.settleSpeculation', () => {
  it('returns the on-chain winSide parsed from the SPECULATION_SETTLED log', async () => {
    const { ctx } = fakeContext({
      logs: [makeSettledLog(42n, 2, '0x' + 'cd'.repeat(20) as `0x${string}`, OSPEX_CORE as `0x${string}`)],
    });
    const result = await settleSpeculation(ctx, { speculationId: 42n });
    expect(result.winSide).toBe('home');
    expect(result.blockNumber).toBe(12345n);
    expect(result.txHash).toMatch(/^0x[0-9a-f]+$/);
  });

  it('decodes void as winSide=void (enum=6)', async () => {
    const { ctx } = fakeContext({
      logs: [makeSettledLog(7n, 6, '0x' + 'cd'.repeat(20) as `0x${string}`, OSPEX_CORE as `0x${string}`)],
    });
    const result = await settleSpeculation(ctx, { speculationId: 7n });
    expect(result.winSide).toBe('void');
  });

  it('throws OspexChainError when the tx receipt is reverted', async () => {
    const { ctx } = fakeContext({ status: 'reverted' });
    await expect(settleSpeculation(ctx, { speculationId: 1n })).rejects.toBeInstanceOf(OspexChainError);
  });

  it('falls back to winSide=tbd when no SPECULATION_SETTLED log is present in the receipt', async () => {
    const { ctx } = fakeContext({ logs: [] });
    const result = await settleSpeculation(ctx, { speculationId: 99n });
    expect(result.winSide).toBe('tbd');
  });

  it('ignores logs from an unrelated emitter even if eventType matches', async () => {
    const otherEmitter = ('0x' + 'ee'.repeat(20)) as `0x${string}`;
    const { ctx } = fakeContext({
      logs: [makeSettledLog(42n, 1, '0x' + 'cd'.repeat(20) as `0x${string}`, otherEmitter)],
    });
    const result = await settleSpeculation(ctx, { speculationId: 42n });
    expect(result.winSide).toBe('tbd'); // log filtered by address
  });

  it('skips CoreEventEmitted logs whose eventType is not SPECULATION_SETTLED', async () => {
    const irrelevantLog = makeSettledLog(
      42n,
      1,
      ('0x' + 'cd'.repeat(20)) as `0x${string}`,
      OSPEX_CORE as `0x${string}`,
      EVENT_TYPE_OTHER,
    );
    const { ctx } = fakeContext({ logs: [irrelevantLog] });
    const result = await settleSpeculation(ctx, { speculationId: 42n });
    expect(result.winSide).toBe('tbd');
  });

  it('rejects non-positive speculationId before reaching the chain', async () => {
    const { ctx } = fakeContext();
    await expect(settleSpeculation(ctx, { speculationId: 0n })).rejects.toBeInstanceOf(OspexChainError);
  });
});
