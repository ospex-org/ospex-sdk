/**
 * Build → sign → broadcast pipeline. The Signer interface is
 * library-agnostic, so this module pulls together viem's request
 * builders + the SDK's Signer + the public client's broadcast in one
 * place. Always EIP-1559 (Polygon supports type-2 txs end-to-end).
 *
 * Gas estimation uses the public client's `estimateGas` plus a small
 * cushion (10%) to absorb the slight delta between estimation and
 * inclusion. Polygon Amoy in particular under-estimates frequently.
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

/**
 * Compose a viem-style chain error into a one-line summary for the
 * OspexChainError message. viem errors pack the decoded revert into
 * `shortMessage` (e.g. "Execution reverted with reason: …") and the
 * full chain-of-explanation into `message` / `metaMessages`. We prefer
 * `shortMessage` for the headline and append `metaMessages` so a
 * decoded custom-error name surfaces inline. The original viem error
 * is preserved on `cause` for callers that want the full chain.
 */
function formatPreSendErr(stage: string, err: unknown): string {
  const e = err as {
    shortMessage?: string;
    message?: string;
    metaMessages?: string[];
  } | undefined;
  const headline = e?.shortMessage ?? e?.message ?? String(err);
  const meta = e?.metaMessages?.length ? ' / ' + e.metaMessages.join(' / ') : '';
  return `Pre-send chain reads failed (${stage}): ${headline}${meta}`;
}

export async function buildSignAndSend(params: SendTxParams): Promise<SendTxResult> {
  const { publicClient, signer, chainId, to, data } = params;
  const from = await signer.getAddress();

  let nonce: number;
  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  let gas: bigint;
  try {
    nonce = await publicClient.getTransactionCount({ address: from, blockTag: 'pending' });
  } catch (err) {
    throw new OspexChainError(formatPreSendErr('nonce read', err), { cause: err });
  }
  try {
    ({ maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas());
  } catch (err) {
    throw new OspexChainError(formatPreSendErr('estimateFeesPerGas', err), { cause: err });
  }
  try {
    if (params.gas !== undefined) {
      gas = params.gas;
    } else {
      const estimated = await publicClient.estimateGas({ account: from, to, data });
      gas = (estimated * 110n) / 100n;
    }
  } catch (err) {
    // estimateGas failures are the most common source of "I can't tell what's
    // wrong" tickets — the underlying error from viem usually carries the
    // decoded revert reason (`shortMessage` + `metaMessages`), but we used
    // to swallow it under a generic wrapper. Surface the full message and
    // attach the original via `cause` so the CLI's cause-chain walker can
    // expose any custom-error selector / decoded reason.
    throw new OspexChainError(formatPreSendErr('estimateGas', err), { cause: err });
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
    // broadcastSignedTx already throws OspexChainError on reverted
    // receipts (with the txHash attached). Re-throw those untouched so
    // the structured info isn't buried under another wrapper.
    if (err instanceof OspexChainError) throw err;
    throw new OspexChainError('Transaction broadcast or inclusion failed.', { cause: err });
  }
}
