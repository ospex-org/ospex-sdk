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
    // The receipt is carried too, with `status: 'reverted'` — the
    // authoritative "this tx reverted on-chain" signal idempotent-recovery
    // paths key off. (They branch on `receipt.status`, not presence: a
    // confirmed-but-unparseable failure also carries a receipt, but `success`.)
    expect(chainErr.receipt).toBeDefined();
    expect(chainErr.receipt?.status).toBe('reverted');
  });

  it('still waits for the receipt before deciding (does not skip wait on send success)', async () => {
    const txHash = ('0x' + 'dd'.repeat(32)) as Hash;
    const { client, calls } = fakeClient('reverted', txHash);
    await expect(broadcastSignedTx(client, '0xdeadbeef')).rejects.toBeInstanceOf(OspexChainError);
    expect(calls.waited).toEqual([txHash]);
  });

  describe('receipt-wait failure after a successful broadcast (M2)', () => {
    function fakeClientWaitRejects(txHash: Hash, waitErr: Error): PublicClient {
      return {
        sendRawTransaction: async () => txHash,
        waitForTransactionReceipt: async () => {
          throw waitErr;
        },
      } as unknown as PublicClient;
    }

    it('preserves the txHash when the receipt wait times out (tx may still land)', async () => {
      const txHash = ('0x' + 'ee'.repeat(32)) as Hash;
      const timeout = new Error('Timed out while waiting for transaction to be confirmed.');
      timeout.name = 'WaitForTransactionReceiptTimeoutError';
      const client = fakeClientWaitRejects(txHash, timeout);

      let caught: unknown;
      try {
        await broadcastSignedTx(client, '0xdeadbeef');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OspexChainError);
      const chainErr = caught as OspexChainError;
      // The hash IS carried — the broadcast succeeded; only the wait failed.
      expect(chainErr.txHash).toBe(txHash);
      // No receipt: on-chain status is UNKNOWN, not reverted. This absence is
      // the discriminator the failure envelope relies on.
      expect(chainErr.receipt).toBeUndefined();
      // The original wait error is preserved on `cause` so the CLI cause-chain
      // walker can still classify timeout vs transport.
      expect((chainErr as { cause?: unknown }).cause).toBe(timeout);
      expect(chainErr.message).toMatch(/may still be mined/i);
    });

    it('preserves the txHash on a transport drop mid-poll', async () => {
      const txHash = ('0x' + 'ff'.repeat(32)) as Hash;
      const transport = new Error('socket hang up');
      transport.name = 'HttpRequestError';
      const client = fakeClientWaitRejects(txHash, transport);

      let caught: unknown;
      try {
        await broadcastSignedTx(client, '0xdeadbeef');
      } catch (err) {
        caught = err;
      }
      const chainErr = caught as OspexChainError;
      expect(chainErr).toBeInstanceOf(OspexChainError);
      expect(chainErr.txHash).toBe(txHash);
      expect(chainErr.receipt).toBeUndefined();
    });
  });
});
