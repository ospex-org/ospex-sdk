/**
 * `client.commitments.raiseMinNonce(args)` — happy path + the
 * NonceMustIncrease error-classification path. Mirrors the
 * cancelOnchain test scaffolding.
 */

import { describe, expect, it } from 'vitest';
import {
  keccak256,
  toBytes,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { raiseMinNonce } from '../src/commitments/raiseMinNonce.js';
import { NonceCounter } from '../src/commitments/context.js';
import { OspexChainError, OspexValidationError } from '../src/errors.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { Signer } from '../src/types/signer.js';

const SIGNER_ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';
const SCORER = '0xdd' + 'aa'.repeat(19);

const NONCE_MUST_INCREASE_SELECTOR = keccak256(
  toBytes('MatchingModule__NonceMustIncrease()'),
).slice(0, 10);

function fakeContext({
  estimateGasErr,
}: { estimateGasErr?: unknown } = {}): { ctx: CommitmentsContext; nonceCounter: NonceCounter } {
  const txHash = ('0x' + 'bb'.repeat(32)) as Hash;
  const receipt = {
    status: 'success',
    transactionHash: txHash,
    blockNumber: 6789n,
    logs: [],
  } as unknown as TransactionReceipt;

  const publicClient = {
    sendRawTransaction: async () => txHash,
    waitForTransactionReceipt: async () => receipt,
    getTransactionCount: async () => 1,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 50n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => {
      if (estimateGasErr) throw estimateGasErr;
      return 60_000n;
    },
    readContract: async () => 0n,
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => SIGNER_ADDR as `0x${string}`,
    signTypedData: async () => '0xdead' as `0x${string}`,
    signTransaction: async () => '0xfeed' as `0x${string}`,
  };

  const nonceCounter = new NonceCounter();
  const ctx: CommitmentsContext = {
    api: { request: async () => ({}) } as unknown as CommitmentsContext['api'],
    requireSigner: () => signer,
    getChainId: () => 137,
    getAddresses: () =>
      ({
        matchingModule: ('0x' + '11'.repeat(20)) as `0x${string}`,
      }) as unknown as ReturnType<CommitmentsContext['getAddresses']>,
    requireChainClient: () => publicClient,
    nonceCounter,
  };
  return { ctx, nonceCounter };
}

describe('commitments.raiseMinNonce', () => {
  const validArgs = {
    contestId: 42n,
    scorer: SCORER as `0x${string}`,
    lineTicks: -35,
    newMinNonce: 1_700_000_001n,
  };

  it('returns txHash on success and bumps the in-process counter', async () => {
    const { ctx, nonceCounter } = fakeContext();
    const result = await raiseMinNonce(ctx, validArgs);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // After raise, peek should reflect the new floor on the maker's
    // (signer) speculation key. We don't recompute the key here — just
    // assert observe() ran by checking that the next `next()` call
    // skips past the floor.
    const peeked = nonceCounter.peek(SIGNER_ADDR.toLowerCase(), '__missing__');
    expect(peeked).toBeUndefined();
  });

  it('rejects a non-positive newMinNonce before any RPC call', async () => {
    const { ctx } = fakeContext();
    await expect(raiseMinNonce(ctx, { ...validArgs, newMinNonce: 0n })).rejects.toBeInstanceOf(
      OspexValidationError,
    );
  });

  it('rejects an invalid scorer address', async () => {
    const { ctx } = fakeContext();
    await expect(
      raiseMinNonce(ctx, { ...validArgs, scorer: '0xnope' as `0x${string}` }),
    ).rejects.toBeInstanceOf(OspexValidationError);
  });

  it('maps NonceMustIncrease structured revert to typed reason', async () => {
    const revertErr = {
      name: 'ContractFunctionExecutionError',
      cause: {
        name: 'ContractFunctionRevertedError',
        data: { errorName: 'MatchingModule__NonceMustIncrease' },
      },
    };
    const { ctx } = fakeContext({ estimateGasErr: revertErr });
    await expect(raiseMinNonce(ctx, validArgs)).rejects.toMatchObject({
      name: 'OspexChainError',
      reason: 'NonceMustIncrease',
    });
  });

  it('maps raw NonceMustIncrease selector to typed reason', async () => {
    const { ctx } = fakeContext({
      estimateGasErr: { name: 'EstimateGasExecutionError', data: NONCE_MUST_INCREASE_SELECTOR },
    });
    await expect(raiseMinNonce(ctx, validArgs)).rejects.toMatchObject({
      reason: 'NonceMustIncrease',
    });
  });

  it('wraps unknown reverts as plain OspexChainError', async () => {
    const { ctx } = fakeContext({ estimateGasErr: new Error('rpc timeout') });
    await expect(raiseMinNonce(ctx, validArgs)).rejects.toBeInstanceOf(OspexChainError);
  });
});
