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
 */
export async function broadcastSignedTx(
  publicClient: PublicClient,
  serializedTransaction: ViemHex,
): Promise<{ txHash: Hash; receipt: TransactionReceipt }> {
  const txHash = await publicClient.sendRawTransaction({ serializedTransaction });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    // Carry the receipt, not just the hash: its presence is the authoritative
    // "this tx reverted on-chain" signal (and it holds gasUsed /
    // effectiveGasPrice for accounting). Downstream idempotent-recovery paths
    // rely on this to distinguish a real revert from a post-broadcast parse
    // failure on a SUCCESSFUL tx — the latter carries a hash but no receipt.
    throw new OspexChainError('Transaction reverted on-chain.', { txHash, receipt });
  }
  return { txHash, receipt };
}
