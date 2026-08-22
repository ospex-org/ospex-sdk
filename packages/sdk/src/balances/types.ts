/**
 * Types for the balances snapshot — wallet-centric view of POL (native
 * gas) and USDC balances. Sibling of `ApprovalsSnapshot`; together they
 * back `ospex doctor`'s readiness view and any future non-CLI consumer
 * (market-maker, frontend) that needs the same "what's in the wallet"
 * check.
 *
 * Kept minimal: raw bigint balances + the token address they were
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
  /** USDC token address (network-specific, sourced from the address book). */
  usdcAddress: Hex;
}

export interface ReadBalancesArgs {
  /**
   * Wallet address to read balances for. Defaults to the configured
   * signer's address — passing `owner` explicitly skips the signer
   * lookup, which avoids a Foundry-keystore passphrase prompt for
   * read-only flows like `ospex doctor --address`.
   */
  owner?: Hex;
  /**
   * Pin both reads to this block. Omit for the current block (the
   * behaviour that predates this option, unchanged).
   *
   * Exists so a funding comparison can be taken at one instant: pass the
   * `atBlock` from `client.commitments.getFilledRisk(...)` and the
   * balances describe the same block as the filled risk they are being
   * compared against. On a load-balanced endpoint whose node has not
   * reached that block the read throws rather than answering from a
   * different one.
   */
  blockNumber?: bigint;
}
