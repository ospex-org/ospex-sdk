/**
 * `client.positions.claim` — happy path + revert path + payout parsing.
 *
 * Same fake-chain-client + fake-signer pattern as positions-settle.test.ts.
 * The POSITION_CLAIMED event is constructed inline so the SDK's payout
 * parsing is exercised end-to-end.
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
import { claim } from '../src/positions/claim.js';
import { OspexChainError, OspexValidationError } from '../src/errors.js';
import type { PositionsContext } from '../src/positions/context.js';
import type { Signer } from '../src/types/signer.js';

const SIGNER_ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';
const OSPEX_CORE = '0x0000000000000000000000000000000000abcdef';

const EVENT_TYPE_CLAIMED = keccak256(toBytes('POSITION_CLAIMED'));

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
  emitter: `0x${string}`,
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
    args: { eventType: EVENT_TYPE_CLAIMED, emitter },
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
  signer,
}: {
  status?: 'success' | 'reverted';
  txHash?: Hash;
  logs?: Array<{ address: `0x${string}`; topics: Hash[]; data: `0x${string}` }>;
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
  return { ctx, calls };
}

describe('positions.claim', () => {
  it('returns the payout parsed from the POSITION_CLAIMED log', async () => {
    const { ctx } = fakeContext({
      logs: [
        makeClaimedLog(
          42n,
          SIGNER_ADDR as `0x${string}`,
          0,
          191_000_000n,
          OSPEX_CORE as `0x${string}`,
        ),
      ],
    });
    const result = await claim(ctx, { speculationId: 42n, positionType: 0 });
    expect(result.payoutWei6).toBe(191_000_000n);
    expect(result.payoutUSDC).toBeCloseTo(191, 6);
    expect(result.blockNumber).toBe(12345n);
  });

  it('throws OspexChainError when the tx receipt is reverted', async () => {
    const { ctx } = fakeContext({ status: 'reverted' });
    await expect(claim(ctx, { speculationId: 1n, positionType: 0 })).rejects.toBeInstanceOf(
      OspexChainError,
    );
  });

  it('throws OspexChainError when no matching POSITION_CLAIMED log is found', async () => {
    const { ctx } = fakeContext({ logs: [] });
    await expect(claim(ctx, { speculationId: 1n, positionType: 0 })).rejects.toMatchObject({
      name: 'OspexChainError',
      message: expect.stringMatching(/no matching POSITION_CLAIMED/i),
    });
  });

  it('ignores POSITION_CLAIMED logs for a different speculationId / user / positionType', async () => {
    const otherUser = ('0x' + 'ff'.repeat(20)) as `0x${string}`;
    const { ctx } = fakeContext({
      logs: [
        makeClaimedLog(99n, otherUser, 1, 50n, OSPEX_CORE as `0x${string}`), // wrong user
        makeClaimedLog(42n, SIGNER_ADDR as `0x${string}`, 1, 50n, OSPEX_CORE as `0x${string}`), // wrong positionType
      ],
    });
    await expect(claim(ctx, { speculationId: 42n, positionType: 0 })).rejects.toMatchObject({
      name: 'OspexChainError',
    });
  });

  it('rejects an invalid positionType before any chain call', async () => {
    const { ctx } = fakeContext();
    await expect(
      claim(ctx, { speculationId: 1n, positionType: 5 as unknown as 0 | 1 }),
    ).rejects.toBeInstanceOf(OspexValidationError);
  });

  it('rejects a non-positive speculationId before any chain call', async () => {
    const { ctx } = fakeContext();
    await expect(claim(ctx, { speculationId: 0n, positionType: 0 })).rejects.toBeInstanceOf(
      OspexValidationError,
    );
  });
});
