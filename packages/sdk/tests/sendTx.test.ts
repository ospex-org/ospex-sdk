/**
 * `buildSignAndSend` gas-handling unit tests.
 *
 * The CreOracleReceiver create / score paths pass a hardcoded `gas` parameter
 * (`OSPEX_CREATE_CONTEST_TX_GAS` / `OSPEX_SCORE_CONTEST_TX_GAS`) to bypass
 * `eth_estimateGas`, which is unreliable on some Polygon RPCs (Infura
 * strips revert data; public RPCs hit state-history errors). These tests
 * pin the contract that buildSignAndSend honors:
 *
 *   - When `gas` is provided, estimateGas is NOT called and the value
 *     flows through to the signer's signTransaction args verbatim.
 *   - When `gas` is omitted, estimateGas IS called and its result is
 *     scaled by 1.1× before being forwarded.
 *
 * The publicClient + signer are stubbed; this is purely a logic test.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildSignAndSend } from '../src/commitments/sendTx.js';
import { OspexChainError } from '../src/errors.js';
import type { PublicClient } from 'viem';
import type { Signer, SignTransactionArgs } from '../src/types/signer.js';

interface Captured {
  estimateGasCalls: number;
  signArgs: SignTransactionArgs | null;
}

function makeStubs(estimateGasReturn: bigint): {
  publicClient: PublicClient;
  signer: Signer;
  captured: Captured;
} {
  const captured: Captured = { estimateGasCalls: 0, signArgs: null };

  const publicClient = {
    getTransactionCount: vi.fn().mockResolvedValue(42),
    estimateFeesPerGas: vi.fn().mockResolvedValue({
      maxFeePerGas: 100_000_000_000n,
      maxPriorityFeePerGas: 1_500_000_000n,
    }),
    estimateGas: vi.fn().mockImplementation(async () => {
      captured.estimateGasCalls++;
      return estimateGasReturn;
    }),
    sendRawTransaction: vi.fn().mockResolvedValue('0x' + 'aa'.repeat(32)),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: 'success',
      logs: [],
    }),
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: vi.fn().mockResolvedValue('0xeDf57Fc01028f4e5Ee9852eedebe5CD875130967'),
    signTransaction: vi.fn().mockImplementation(async (args: SignTransactionArgs) => {
      captured.signArgs = args;
      // Minimal valid-looking serialized tx; sendRawTransaction is mocked
      // so its precise bytes don't matter.
      return ('0x02' + '00'.repeat(100)) as `0x${string}`;
    }),
  } as unknown as Signer;

  return { publicClient, signer, captured };
}

describe('buildSignAndSend — gas handling', () => {
  it('skips estimateGas and forwards the caller-supplied `gas` to the signer', async () => {
    const { publicClient, signer, captured } = makeStubs(99_999n);

    await buildSignAndSend({
      publicClient,
      signer,
      chainId: 137,
      to: '0x1111111111111111111111111111111111111111',
      data: '0x1234' as `0x${string}`,
      gas: 2_000_000n,
    });

    expect(captured.estimateGasCalls).toBe(0);
    expect(captured.signArgs?.gas).toBe(2_000_000n);
  });

  it('calls estimateGas and scales by 1.1× when `gas` is omitted', async () => {
    const { publicClient, signer, captured } = makeStubs(1_000_000n);

    await buildSignAndSend({
      publicClient,
      signer,
      chainId: 137,
      to: '0x1111111111111111111111111111111111111111',
      data: '0x1234' as `0x${string}`,
    });

    expect(captured.estimateGasCalls).toBe(1);
    // 1_000_000 * 110 / 100 = 1_100_000
    expect(captured.signArgs?.gas).toBe(1_100_000n);
  });
});

describe('buildSignAndSend — receipt-wait failure preserves txHash (M2)', () => {
  it('propagates the OspexChainError (with txHash, no receipt) when the wait fails after broadcast', async () => {
    const txHash = '0x' + 'cc'.repeat(32);
    const { publicClient, signer } = makeStubs(1_000_000n);
    // Broadcast succeeds (returns a hash) but the receipt wait rejects — the
    // exact path the review flagged as losing the hash in buildSignAndSend's
    // generic wrap. broadcastSignedTx now throws an OspexChainError carrying
    // the hash, and buildSignAndSend re-throws OspexChainError untouched.
    (publicClient.sendRawTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(txHash);
    (publicClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('wait timed out'), { name: 'WaitForTransactionReceiptTimeoutError' }),
    );

    let caught: unknown;
    try {
      await buildSignAndSend({
        publicClient,
        signer,
        chainId: 137,
        to: '0x1111111111111111111111111111111111111111',
        data: '0x1234' as `0x${string}`,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OspexChainError);
    const chainErr = caught as OspexChainError;
    expect(chainErr.txHash).toBe(txHash);
    expect(chainErr.receipt).toBeUndefined();
  });
});
