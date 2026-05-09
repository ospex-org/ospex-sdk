/**
 * Typed context the Balances namespace needs from its parent
 * OspexClient. Mirrors the read-only shape of `ApprovalsContext` —
 * `requireSigner` is consulted only when no explicit `owner` is
 * passed, so a caller passing `owner` keeps the call read-only.
 */

import type { PublicClient } from 'viem';
import type { ChainId } from '../types/protocol.js';
import type { Signer } from '../types/signer.js';
import type { OspexAddresses } from '../contracts/addresses.js';

export interface BalancesContext {
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
