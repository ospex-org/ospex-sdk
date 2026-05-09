/**
 * Types for the balances snapshot — wallet-centric view of POL (native
 * gas), USDC, and LINK balances. Sibling of `ApprovalsSnapshot`;
 * together they back `ospex doctor`'s readiness view and any future
 * non-CLI consumer (market-maker, frontend) that needs the same
 * "what's in the wallet" check.
 *
 * Kept minimal: raw bigint balances + the token addresses they were
 * read against. Display formatting is the consumer's job (the CLI
 * doctor does this with viem's `formatUnits`).
 */

import type { Hex } from '../types/signer.js';

export interface BalancesSnapshot {
  /** The wallet whose balances were read. */
  owner: Hex;
  /** Configured chain id this snapshot was taken against (137 / 80002). */
  chainId: number;
  /**
   * Native gas-token balance. POL on Polygon, in wei (18 decimals).
   * Anything > 0 lets a tx land; the doctor flags 0 as a hard blocker.
   */
  native: bigint;
  /** USDC balance in 6-decimal wei units. */
  usdc: bigint;
  /** LINK balance in 18-decimal wei units. */
  link: bigint;
  /** USDC token address (network-specific, sourced from the address book). */
  usdcAddress: Hex;
  /** LINK token address (network-specific). */
  linkAddress: Hex;
}

export interface ReadBalancesArgs {
  /**
   * Wallet address to read balances for. Defaults to the configured
   * signer's address — passing `owner` explicitly skips the signer
   * lookup, which avoids a Foundry-keystore passphrase prompt for
   * read-only flows like `ospex doctor --address`.
   */
  owner?: Hex;
}
