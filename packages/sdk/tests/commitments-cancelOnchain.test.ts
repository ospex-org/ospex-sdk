/**
 * `client.commitments.cancelOnchain(hash)` — happy path, validation
 * errors, idempotent re-cancel, and the two error-classification paths
 * for `MatchingModule__NotCommitmentMaker` (structured + raw selector).
 *
 * Same fake-publicClient + fake-signer pattern as positions-claim.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  keccak256,
  toBytes,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { cancelOnchain } from '../src/commitments/cancelOnchain.js';
import { NonceCounter } from '../src/commitments/context.js';
import { OspexAPIError, OspexChainError, OspexValidationError } from '../src/errors.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { CommitmentBody } from '../src/api/types.js';
import type { Signer } from '../src/types/signer.js';

const SIGNER_ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';
const HASH = '0x' + 'ab'.repeat(32);

const NOT_MAKER_SELECTOR = keccak256(toBytes('MatchingModule__NotCommitmentMaker()')).slice(0, 10);

function fullCommitmentBody(overrides: Partial<CommitmentBody> = {}): CommitmentBody {
  return {
    commitmentHash: HASH,
    maker: SIGNER_ADDR,
    contestId: '42',
    scorer: '0xdd' + 'aa'.repeat(19),
    lineTicks: -35,
    positionType: 0,
    oddsTick: 191,
    marketType: 'spread',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '1700000000',
    expiry: '2099-01-01T00:00:00.000Z',
    speculationKey: '0x' + 'ee'.repeat(32),
    signature: '0x' + 'cc'.repeat(65),
    status: 'open',
    source: 'agent',
    network: 'polygon',
    nonceInvalidated: false,
    createdAt: '2026-05-04T00:00:00.000Z',
    ...overrides,
  };
}

interface FakeOpts {
  apiResponder?: (path: string) => unknown;
  estimateGasErr?: unknown;
  status?: 'success' | 'reverted';
}

function fakeContext(opts: FakeOpts = {}): { ctx: CommitmentsContext } {
  const txHash = ('0x' + 'aa'.repeat(32)) as Hash;
  const receipt = {
    status: opts.status ?? 'success',
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
      if (opts.estimateGasErr) throw opts.estimateGasErr;
      return 80_000n;
    },
    readContract: async () => 0n,
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => SIGNER_ADDR as `0x${string}`,
    signTypedData: async () => '0xdead' as `0x${string}`,
    signTransaction: async () => '0xfeed' as `0x${string}`,
  };

  const ctx: CommitmentsContext = {
    api: {
      request: async (path: string) => {
        if (opts.apiResponder) return opts.apiResponder(path);
        return fullCommitmentBody();
      },
    } as unknown as CommitmentsContext['api'],
    requireSigner: () => signer,
    getChainId: () => 137,
    getAddresses: () =>
      ({
        matchingModule: ('0x' + '11'.repeat(20)) as `0x${string}`,
      }) as unknown as ReturnType<CommitmentsContext['getAddresses']>,
    requireChainClient: () => publicClient,
    nonceCounter: new NonceCounter(),
  };
  return { ctx };
}

describe('commitments.cancelOnchain', () => {
  it('returns txHash + commitmentHash on success', async () => {
    const { ctx } = fakeContext();
    const result = await cancelOnchain(ctx, HASH as `0x${string}`);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.commitmentHash).toBe(HASH);
    expect(result.receipt.blockNumber).toBe(12345n);
  });

  it('rejects a malformed hash before any API/RPC call', async () => {
    const { ctx } = fakeContext();
    await expect(cancelOnchain(ctx, '0xabc' as `0x${string}`)).rejects.toBeInstanceOf(
      OspexValidationError,
    );
  });

  it('rejects a body with null required fields (indexer-only row)', async () => {
    const { ctx } = fakeContext({
      apiResponder: () => fullCommitmentBody({ scorer: null, lineTicks: null }),
    });
    await expect(cancelOnchain(ctx, HASH as `0x${string}`)).rejects.toBeInstanceOf(
      OspexValidationError,
    );
  });

  it('propagates 404 from the API as OspexAPIError without sending a tx', async () => {
    let estimateGasCalled = false;
    const { ctx } = fakeContext({
      apiResponder: () => {
        throw new OspexAPIError('not found', { status: 404, apiCode: 'NOT_FOUND' });
      },
    });
    (ctx.requireChainClient() as unknown as { estimateGas: () => Promise<bigint> }).estimateGas =
      async () => {
        estimateGasCalled = true;
        return 0n;
      };
    await expect(cancelOnchain(ctx, HASH as `0x${string}`)).rejects.toBeInstanceOf(OspexAPIError);
    expect(estimateGasCalled).toBe(false);
  });

  it('idempotent: cancelling an already-cancelled commitment still succeeds (no AlreadyCancelled revert)', async () => {
    // The contract has no AlreadyCancelled guard — the SDK MUST NOT
    // synthesize one. Status='cancelled' on the row is fine; the tx
    // just rewrites s_cancelledCommitments[hash]=true and re-emits.
    const { ctx } = fakeContext({
      apiResponder: () => fullCommitmentBody({ status: 'cancelled' }),
    });
    const result = await cancelOnchain(ctx, HASH as `0x${string}`);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('maps structured ContractFunctionRevertedError to reason=NotCommitmentMaker', async () => {
    const revertErr: { name: string; cause: unknown } = {
      name: 'ContractFunctionExecutionError',
      cause: {
        name: 'ContractFunctionRevertedError',
        data: { errorName: 'MatchingModule__NotCommitmentMaker' },
      },
    };
    const { ctx } = fakeContext({ estimateGasErr: revertErr });
    await expect(cancelOnchain(ctx, HASH as `0x${string}`)).rejects.toMatchObject({
      name: 'OspexChainError',
      reason: 'NotCommitmentMaker',
    });
  });

  it('maps raw revert hex with the NotCommitmentMaker selector to typed reason', async () => {
    const rawErr: { name: string; data: string } = {
      name: 'EstimateGasExecutionError',
      data: NOT_MAKER_SELECTOR,
    };
    const { ctx } = fakeContext({ estimateGasErr: rawErr });
    await expect(cancelOnchain(ctx, HASH as `0x${string}`)).rejects.toMatchObject({
      name: 'OspexChainError',
      reason: 'NotCommitmentMaker',
    });
  });

  it('wraps unknown reverts as plain OspexChainError without a reason', async () => {
    const { ctx } = fakeContext({ estimateGasErr: new Error('rpc went sideways') });
    const promise = cancelOnchain(ctx, HASH as `0x${string}`);
    await expect(promise).rejects.toBeInstanceOf(OspexChainError);
    await expect(promise).rejects.toMatchObject({ reason: undefined });
  });
});
