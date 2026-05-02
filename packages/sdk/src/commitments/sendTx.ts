/**
 * Build → sign → broadcast pipeline. The Signer interface is
 * library-agnostic, so this module pulls together viem's request
 * builders + the SDK's Signer + the public client's broadcast in one
 * place. Always EIP-1559 (Polygon supports type-2 txs end-to-end).
 *
 * Gas estimation uses the public client's `estimateGas` plus a small
 * cushion (10%) to absorb the slight delta between estimation and
 * inclusion. Polygon Amoy in particular under-estimates frequently
 * (per `ospex-foundry-matched-pairs/docs/DEPLOYMENT.md:214`).
 */

import { type Hash, type Hex as ViemHex, type PublicClient } from 'viem';
import { broadcastSignedTx } from '../chain/client.js';
import { OspexChainError } from '../errors.js';
import type { ChainId } from '../types/protocol.js';
import type { Hex, SignTransactionArgs, Signer } from '../types/signer.js';

export interface SendTxParams {
  publicClient: PublicClient;
  signer: Signer;
  chainId: ChainId;
  to: Hex;
  data: Hex;
  /** Override gas. If omitted, estimated + 10% cushion. */
  gas?: bigint;
}

export interface SendTxResult {
  txHash: Hash;
  receipt: Awaited<ReturnType<typeof broadcastSignedTx>>['receipt'];
}

export async function buildSignAndSend(params: SendTxParams): Promise<SendTxResult> {
  const { publicClient, signer, chainId, to, data } = params;
  const from = await signer.getAddress();

  let nonce: number;
  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  let gas: bigint;
  try {
    [nonce, { maxFeePerGas, maxPriorityFeePerGas }, gas] = await Promise.all([
      publicClient.getTransactionCount({ address: from, blockTag: 'pending' }),
      publicClient.estimateFeesPerGas(),
      params.gas !== undefined
        ? Promise.resolve(params.gas)
        : publicClient.estimateGas({ account: from, to, data }).then((g) => (g * 110n) / 100n),
    ]);
  } catch (err) {
    throw new OspexChainError('Pre-send chain reads failed (gas / fees / nonce).', { cause: err });
  }

  const txArgs: SignTransactionArgs = {
    to,
    data,
    chainId,
    nonce,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type: 'eip1559',
  };

  let serialized: ViemHex;
  try {
    serialized = (await signer.signTransaction(txArgs)) as ViemHex;
  } catch (err) {
    // Surface signer errors as-is — they're already typed
    // (OspexSigningError) by KeystoreSigner. Anything else gets
    // wrapped as a chain error since the user intended to send a tx.
    throw err instanceof Error && 'code' in err
      ? err
      : new OspexChainError('Signer.signTransaction failed.', { cause: err });
  }

  try {
    return await broadcastSignedTx(publicClient, serialized);
  } catch (err) {
    throw new OspexChainError('Transaction broadcast or inclusion failed.', { cause: err });
  }
}
