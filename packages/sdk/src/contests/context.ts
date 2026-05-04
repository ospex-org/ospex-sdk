/**
 * Typed context the Contests namespace receives from its parent
 * OspexClient. Mirrors the CommitmentsContext / PositionsContext
 * pattern: lazy resolution of signer + chain client so reads work
 * without an rpcUrl, and writes throw OspexConfigError if the caller
 * never supplied one.
 */
import type { PublicClient } from 'viem';
import type { ApiClient } from '../api/client.js';
import type { ContestsApi } from '../api/contests.js';
import type { ChainId } from '../types/protocol.js';
import type { Signer } from '../types/signer.js';
import type { OspexAddresses } from '../contracts/addresses.js';

export interface ContestsContext {
  api: ApiClient;
  contestsApi: ContestsApi;
  requireSigner(): Signer;
  getChainId(): ChainId;
  getAddresses(): OspexAddresses;
  requireChainClient(): PublicClient;
  /**
   * Override for the ospex-api-server URL (encrypted secrets). Tests
   * pass a stub; production uses the verified Heroku URL from
   * `contracts/constants.ts`.
   */
  apiServerUrl?: string;
  /**
   * Override for the global `fetch` used by helpers (script source,
   * encrypted secrets). Tests inject a mock. Defaults to globalThis.fetch.
   */
  fetch?: typeof globalThis.fetch;
}
