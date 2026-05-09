/**
 * Typed context the Approvals namespace needs from its parent
 * OspexClient. Mirrors `commitments/context.ts` and
 * `positions/context.ts`.
 *
 * `requireSigner` is only consulted when the caller of `read()` does
 * NOT pass an explicit `owner` — passing one keeps the call read-only
 * and skips the signer lookup (and therefore any keystore passphrase
 * prompt).
 */

import type { PublicClient } from 'viem';
import type { ChainId } from '../types/protocol.js';
import type { Signer } from '../types/signer.js';
import type { OspexAddresses } from '../contracts/addresses.js';

export interface ApprovalsContext {
  /** Resolves the configured signer or throws OspexConfigError. */
  requireSigner(): Signer;
  /** Resolves the chain id (137 / 80002) for this client instance. */
  getChainId(): ChainId;
  /** Returns the contract addresses for the configured chain. */
  getAddresses(): OspexAddresses;
  /**
   * Resolves a viem PublicClient bound to the configured rpcUrl, or
   * throws OspexConfigError if no rpcUrl was provided.
   */
  requireChainClient(): PublicClient;
}
