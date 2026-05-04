/**
 * `client.commitments.cancelAllOnSpeculation(args)` — auto-default
 * newMinNonce calculation, explicit override, and invalidatedCount.
 *
 * The default-path test pins the formula:
 *   newMinNonce = max(onChainFloor, lastInProcess, supabaseMaxStored) + 1
 * by mocking each candidate to a different value and asserting the
 * resulting tx encodes the highest-plus-one.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { cancelAllOnSpeculation } from '../src/commitments/cancelAllOnSpeculation.js';
import { NonceCounter } from '../src/commitments/context.js';
import { deriveSpeculationKey } from '../src/chain/eip712.js';
import { matchingModuleAbi } from '../src/contracts/abi/index.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { CommitmentBody, CommitmentsListBody } from '../src/api/types.js';
import type { Signer } from '../src/types/signer.js';

const SIGNER_ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';
const SCORER = ('0x' + 'dd'.repeat(20)) as `0x${string}`;
const CONTEST_ID = 42n;
const LINE_TICKS = -35;
const SPEC_KEY = deriveSpeculationKey(CONTEST_ID, SCORER.toLowerCase() as Hex, LINE_TICKS);

interface RowOverrides {
  nonce: string;
  status: CommitmentBody['status'];
  nonceInvalidated?: boolean;
  speculationKey?: string;
}

function makeRow(overrides: RowOverrides): CommitmentBody {
  return {
    commitmentHash: '0x' + 'cc'.repeat(32),
    maker: SIGNER_ADDR,
    contestId: CONTEST_ID.toString(),
    scorer: SCORER,
    lineTicks: LINE_TICKS,
    positionType: 0,
    oddsTick: 191,
    marketType: 'spread',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: overrides.nonce,
    expiry: '2099-01-01T00:00:00.000Z',
    speculationKey: overrides.speculationKey ?? SPEC_KEY,
    signature: '0x' + 'cc'.repeat(65),
    status: overrides.status,
    source: 'agent',
    network: 'polygon',
    nonceInvalidated: overrides.nonceInvalidated ?? false,
    createdAt: '2026-05-04T00:00:00.000Z',
  };
}

interface FakeOpts {
  rows: CommitmentBody[];
  onChainFloor: bigint;
  preObserve?: { speculationKey: string; nonce: bigint };
}

function fakeContext(opts: FakeOpts): {
  ctx: CommitmentsContext;
  sentTxs: { to: Hex; data: Hex }[];
} {
  const txHash = ('0x' + 'bb'.repeat(32)) as Hash;
  const receipt = {
    status: 'success',
    transactionHash: txHash,
    blockNumber: 1234n,
    logs: [],
  } as unknown as TransactionReceipt;
  const sentTxs: { to: Hex; data: Hex }[] = [];

  // We need to capture the calldata that gets signed so we can decode
  // it and assert the on-chain newMinNonce. We do that via the signer
  // (which receives `to` + `data`).
  const publicClient = {
    sendRawTransaction: async () => txHash,
    waitForTransactionReceipt: async () => receipt,
    getTransactionCount: async () => 1,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 50n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => 60_000n,
    readContract: async () => opts.onChainFloor,
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => SIGNER_ADDR as `0x${string}`,
    signTypedData: async () => '0xdead' as `0x${string}`,
    signTransaction: async (args) => {
      sentTxs.push({ to: args.to as Hex, data: args.data as Hex });
      return '0xfeed' as `0x${string}`;
    },
  };

  const nonceCounter = new NonceCounter();
  if (opts.preObserve) {
    nonceCounter.observe(SIGNER_ADDR, opts.preObserve.speculationKey, opts.preObserve.nonce);
  }

  const ctx: CommitmentsContext = {
    api: {
      request: async (_path: string, _init?: unknown): Promise<unknown> => {
        const body: CommitmentsListBody = {
          commitments: opts.rows,
          pagination: { limit: 1000, offset: 0, total: opts.rows.length, hasMore: false },
        };
        return body;
      },
    } as unknown as CommitmentsContext['api'],
    requireSigner: () => signer,
    getChainId: () => 137,
    getAddresses: () =>
      ({
        matchingModule: ('0x' + '11'.repeat(20)) as `0x${string}`,
      }) as unknown as ReturnType<CommitmentsContext['getAddresses']>,
    requireChainClient: () => publicClient,
    nonceCounter,
  };
  return { ctx, sentTxs };
}

function decodeRaiseMinNonceCall(data: Hex): { newMinNonce: bigint } {
  const decoded = decodeFunctionData({
    abi: matchingModuleAbi,
    data,
  });
  if (decoded.functionName !== 'raiseMinNonce') {
    throw new Error(`unexpected function: ${String(decoded.functionName)}`);
  }
  const args = decoded.args as readonly [bigint, `0x${string}`, number, bigint];
  return { newMinNonce: args[3]! };
}

describe('commitments.cancelAllOnSpeculation', () => {
  const baseArgs = {
    contestId: CONTEST_ID,
    scorer: SCORER,
    lineTicks: LINE_TICKS,
  };

  it('default newMinNonce = max(onChainFloor, lastInProcess, supabaseMaxStored) + 1 (chain wins)', async () => {
    const { ctx, sentTxs } = fakeContext({
      onChainFloor: 5_000n,
      rows: [
        makeRow({ nonce: '2_000'.replace(/_/g, ''), status: 'open' }),
        makeRow({ nonce: '3_500'.replace(/_/g, ''), status: 'partially_filled' }),
      ],
      preObserve: { speculationKey: SPEC_KEY, nonce: 1_500n },
    });
    const result = await cancelAllOnSpeculation(ctx, baseArgs);
    expect(result.newMinNonce).toBe(5_001n);
    const decoded = decodeRaiseMinNonceCall(sentTxs[0]!.data);
    expect(decoded.newMinNonce).toBe(5_001n);
  });

  it('default newMinNonce — supabase max wins', async () => {
    const { ctx } = fakeContext({
      onChainFloor: 1_000n,
      rows: [
        makeRow({ nonce: '7_777'.replace(/_/g, ''), status: 'open' }),
        makeRow({ nonce: '4_000'.replace(/_/g, ''), status: 'cancelled' }),
      ],
      preObserve: { speculationKey: SPEC_KEY, nonce: 2_000n },
    });
    const result = await cancelAllOnSpeculation(ctx, baseArgs);
    expect(result.newMinNonce).toBe(7_778n);
  });

  it('default newMinNonce — in-process counter wins', async () => {
    const { ctx } = fakeContext({
      onChainFloor: 1_000n,
      rows: [makeRow({ nonce: '3_000'.replace(/_/g, ''), status: 'open' })],
      preObserve: { speculationKey: SPEC_KEY, nonce: 9_999n },
    });
    const result = await cancelAllOnSpeculation(ctx, baseArgs);
    expect(result.newMinNonce).toBe(10_000n);
  });

  it('explicit newMinNonce override path', async () => {
    const { ctx, sentTxs } = fakeContext({
      onChainFloor: 1_000n,
      rows: [makeRow({ nonce: '500', status: 'open' })],
    });
    const result = await cancelAllOnSpeculation(ctx, { ...baseArgs, newMinNonce: 12_345n });
    expect(result.newMinNonce).toBe(12_345n);
    expect(decodeRaiseMinNonceCall(sentTxs[0]!.data).newMinNonce).toBe(12_345n);
  });

  it('invalidatedCount counts only currently-matchable rows below newMinNonce', async () => {
    const { ctx } = fakeContext({
      onChainFloor: 0n,
      rows: [
        makeRow({ nonce: '100', status: 'open' }), // counted
        makeRow({ nonce: '101', status: 'partially_filled' }), // counted
        makeRow({ nonce: '102', status: 'cancelled' }), // skipped — terminal
        makeRow({ nonce: '103', status: 'filled' }), // skipped — terminal
        makeRow({ nonce: '104', status: 'open', nonceInvalidated: true }), // skipped — already invalid
        // Wrong-speculation row — should be filtered out by speculationKey:
        makeRow({
          nonce: '999',
          status: 'open',
          speculationKey: ('0x' + 'ff'.repeat(32)) as Hex,
        }),
      ],
    });
    const result = await cancelAllOnSpeculation(ctx, baseArgs);
    expect(result.invalidatedCount).toBe(2);
  });

  it('rows above newMinNonce are not counted', async () => {
    const { ctx } = fakeContext({
      onChainFloor: 0n,
      rows: [makeRow({ nonce: '100', status: 'open' })],
    });
    const result = await cancelAllOnSpeculation(ctx, { ...baseArgs, newMinNonce: 50n });
    expect(result.invalidatedCount).toBe(0);
  });
});
