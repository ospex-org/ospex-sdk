/**
 * broadcastSignedTx — receipt-status handling.
 *
 * viem's waitForTransactionReceipt resolves with a receipt for both
 * successful and reverted transactions, distinguished only by
 * `receipt.status`. The SDK must treat reverted as a chain error;
 * otherwise commitments.match() / commitments.approve() return
 * "success" while the tx actually failed on chain.
 */

import { describe, expect, it } from 'vitest';
import type { Hash, PublicClient, TransactionReceipt } from 'viem';
import { broadcastSignedTx } from '../src/chain/client.js';
import { OspexChainError } from '../src/errors.js';

interface FakeClientCalls {
  sentRaw: string[];
  waited: Hash[];
}

function fakeClient(receiptStatus: 'success' | 'reverted', txHash: Hash): {
  client: PublicClient;
  calls: FakeClientCalls;
} {
  const calls: FakeClientCalls = { sentRaw: [], waited: [] };
  const receipt = {
    status: receiptStatus,
    transactionHash: txHash,
    blockNumber: 1n,
  } as unknown as TransactionReceipt;
  const client = {
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: string }) => {
      calls.sentRaw.push(serializedTransaction);
      return txHash;
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hash }) => {
      calls.waited.push(hash);
      return receipt;
    },
  } as unknown as PublicClient;
  return { client, calls };
}

describe('broadcastSignedTx', () => {
  it('returns the receipt when status is success', async () => {
    const txHash = ('0x' + 'aa'.repeat(32)) as Hash;
    const { client, calls } = fakeClient('success', txHash);
    const result = await broadcastSignedTx(client, '0xdeadbeef');
    expect(result.txHash).toBe(txHash);
    expect(result.receipt.status).toBe('success');
    expect(calls.sentRaw).toEqual(['0xdeadbeef']);
    expect(calls.waited).toEqual([txHash]);
  });

  it('throws OspexChainError when status is reverted', async () => {
    const txHash = ('0x' + 'bb'.repeat(32)) as Hash;
    const { client } = fakeClient('reverted', txHash);
    await expect(broadcastSignedTx(client, '0xdeadbeef')).rejects.toBeInstanceOf(OspexChainError);
  });

  it('reverted-receipt error carries the txHash so the caller can investigate', async () => {
    const txHash = ('0x' + 'cc'.repeat(32)) as Hash;
    const { client } = fakeClient('reverted', txHash);
    let caught: unknown;
    try {
      await broadcastSignedTx(client, '0xdeadbeef');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OspexChainError);
    const chainErr = caught as OspexChainError;
    expect(chainErr.txHash).toBe(txHash);
    expect(chainErr.code).toBe('CHAIN_ERROR');
    expect(chainErr.message).toMatch(/reverted/i);
  });

  it('still waits for the receipt before deciding (does not skip wait on send success)', async () => {
    const txHash = ('0x' + 'dd'.repeat(32)) as Hash;
    const { client, calls } = fakeClient('reverted', txHash);
    await expect(broadcastSignedTx(client, '0xdeadbeef')).rejects.toBeInstanceOf(OspexChainError);
    expect(calls.waited).toEqual([txHash]);
  });
});
