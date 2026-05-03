/**
 * Typed context the Positions namespace needs from its parent
 * OspexClient. Mirrors `commitments/context.ts` so the lazy-getter
 * pattern is consistent across namespaces.
 *
 * Reads only need `api`. Writes (`settleSpeculation`, `claim`,
 * `claimAll`) additionally need `requireSigner`, `requireChainClient`,
 * and `getAddresses`. `requireChainClient` throws OspexConfigError when
 * the OspexClient was constructed without `rpcUrl`; `requireSigner`
 * throws when no `signer` was attached.
 */

import type { PublicClient } from 'viem';
import type { ApiClient } from '../api/client.js';
import type { PositionsApi } from '../api/positions.js';
import type { ChainId } from '../types/protocol.js';
import type { Signer } from '../types/signer.js';
import type { OspexAddresses } from '../contracts/addresses.js';

export interface PositionsContext {
  api: ApiClient;
  /** Pre-constructed API surface so reads route through the same typed
   * client the SDK already exposes for M1. Avoids duplicating the
   * address-validation + URL-building. */
  positionsApi: PositionsApi;
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
