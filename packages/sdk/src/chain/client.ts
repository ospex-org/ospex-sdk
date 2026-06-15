/**
 * viem chain-client adapter. Wraps viem's `createPublicClient` so the
 * rest of the SDK gets one ergonomic helper for both reads (eth_call)
 * and broadcasting signed transactions. Holds zero state — instantiate
 * per call to avoid leaking transports across `OspexClient` instances.
 *
 * The SDK never constructs a viem WalletClient. Signing goes through
 * the Signer abstraction (`signer.signTransaction`) and the resulting
 * serialized hex is broadcast via this module's `broadcastSignedTx`.
 */

import {
  createPublicClient,
  http,
  type Hash,
  type Hex as ViemHex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import type { ChainId } from '../types/protocol.js';
import { OspexChainError, OspexConfigError } from '../errors.js';

const CHAIN_BY_ID = {
  137: polygon,
  80002: polygonAmoy,
} as const;

export function getViemChain(chainId: ChainId): typeof polygon | typeof polygonAmoy {
  const chain = CHAIN_BY_ID[chainId];
  if (!chain) {
    throw new OspexConfigError(
      `No viem chain mapping for chain id ${chainId}. Supported: 137 (mainnet), 80002 (amoy).`,
    );
  }
  return chain;
}

export function createReadClient(rpcUrl: string, chainId: ChainId): PublicClient {
  if (!rpcUrl) {
    throw new OspexConfigError(
      'rpcUrl is required for chain operations. Configure it via the OspexClient constructor or `ospex init`.',
    );
  }
  return createPublicClient({
    chain: getViemChain(chainId),
    transport: http(rpcUrl),
  });
}

/**
 * Broadcast a signed serialized transaction (returned by Signer's
 * `signTransaction`) and wait for confirmation. One round-trip through
 * the public client; no Signer interaction.
 *
 * viem's `waitForTransactionReceipt` resolves with a receipt regardless
 * of execution outcome — both successful and reverted transactions
 * produce a receipt, distinguished only by `receipt.status`. If the
 * caller doesn't check the status, a reverted tx silently looks like
 * a success. We treat anything other than `'success'` as a chain error
 * here, with the txHash attached so the caller can investigate on
 * Polygonscan.
 *
 * The receipt WAIT itself can fail after a successful broadcast — viem's
 * default 180s timeout elapses, or the transport drops mid-poll. The
 * broadcast still landed a txHash and the tx MAY still be mined, so the
 * error carries the txHash (but NO receipt: on-chain status is UNKNOWN,
 * not reverted). Without it the txHash dies in this stack frame and the
 * failure envelope steers an agent toward an unsafe blind retry of a tx
 * that may already be confirming. Three distinguishable shapes result —
 * branch on receipt presence/status, never on txHash alone:
 *   - txHash + `receipt.status === 'reverted'` — tx reverted on-chain.
 *   - txHash + no receipt — broadcast landed, receipt not observed; UNKNOWN.
 *   - no txHash — broadcast itself failed (no hash from the transport).
 */
export async function broadcastSignedTx(
  publicClient: PublicClient,
  serializedTransaction: ViemHex,
): Promise<{ txHash: Hash; receipt: TransactionReceipt }> {
  const txHash = await publicClient.sendRawTransaction({ serializedTransaction });
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  } catch (err) {
    // Broadcast SUCCEEDED (we hold a txHash) but waiting for the receipt
    // failed — wait timeout or transport drop mid-poll. Attach the txHash
    // (NO receipt) so the caller can reconcile on-chain and never
    // blind-retries a tx that may already be landing. `cause` is preserved
    // so the CLI's cause-chain walker can still classify timeout vs
    // transport. `buildSignAndSend` re-throws OspexChainError untouched, so
    // the txHash survives the wrap.
    throw new OspexChainError(
      'Transaction was broadcast but waiting for its receipt failed; the ' +
        'transaction may still be mined. Inspect the txHash on-chain before retrying.',
      { txHash, cause: err },
    );
  }
  if (receipt.status !== 'success') {
    // Carry the receipt, not just the hash. Here `receipt.status` is
    // `'reverted'` — the authoritative "this tx reverted on-chain" signal —
    // and it holds gasUsed / effectiveGasPrice for accounting. Downstream
    // idempotent-recovery paths branch on `receipt.status` (NOT presence): a
    // post-broadcast parse failure on a SUCCESSFUL tx also carries a receipt,
    // but with `status: 'success'`, so it isn't mistaken for a revert.
    throw new OspexChainError('Transaction reverted on-chain.', { txHash, receipt });
  }
  return { txHash, receipt };
}
