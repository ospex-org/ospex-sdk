/**
 * Block-explorer URL helpers. Polygonscan has separate domains for
 * mainnet (137) and Amoy (80002). The CLI prints the link after every
 * on-chain write so the user can verify inclusion without copy-pasting
 * the txHash by hand.
 */

import type { ChainId } from '@ospex/sdk';

export function polygonscanTxUrl(chainId: ChainId, txHash: string): string {
  return chainId === 80002
    ? `https://amoy.polygonscan.com/tx/${txHash}`
    : `https://polygonscan.com/tx/${txHash}`;
}
