/**
 * Typed context the Commitments namespace needs from its parent
 * OspexClient. Passed by reference so the parent can lazily provide
 * a chain client / signer only when the methods actually need them.
 *
 * `chainId` is currently fixed to the configured network (one client,
 * one chain). When write methods need on-chain reads or sends, they
 * call `requireChainClient()` which throws OspexConfigError if the
 * caller didn't provide an `rpcUrl`.
 */

import type { PublicClient } from 'viem';
import type { ApiClient } from '../api/client.js';
import type { ContestsApi } from '../api/contests.js';
import type { SpeculationsApi } from '../api/speculations.js';
import type { ChainId } from '../types/protocol.js';
import type { Signer } from '../types/signer.js';
import type { OspexAddresses } from '../contracts/addresses.js';
import type { Teams } from '../teams/index.js';

export interface CommitmentsContext {
  api: ApiClient;
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
  /**
   * Per-instance, per-(maker, speculationKey) nonce counter. Allows
   * rapid-fire submits within the same process to pick distinct
   * nonces even when unix-seconds collide. Multi-process callers
   * pass `nonce` explicitly to `submit`.
   */
  nonceCounter: NonceCounter;
  /**
   * The high-level `submit` orchestrator (`prepareSubmit`) needs to
   * fetch contest / speculation detail and team aliases. These getters
   * are lazy so the parent OspexClient doesn't have to construct
   * Contests/Speculations/Teams namespaces before a write actually
   * fires. Same pattern as `requireSigner` / `requireChainClient`.
   */
  getContestsApi(): ContestsApi;
  getSpeculationsApi(): SpeculationsApi;
  getTeams(): Teams;
}

export class NonceCounter {
  private readonly lastUsed = new Map<string, bigint>();

  /** Build the per-(maker, speculationKey) cache key. */
  private static keyFor(maker: string, speculationKey: string): string {
    return `${maker.toLowerCase()}:${speculationKey.toLowerCase()}`;
  }

  /**
   * Compute the next nonce per the SDK's default strategy:
   *   max(currentFloor, lastUsedForKey + 1, unixSeconds)
   *
   * `unixSeconds` is included so the first call in a fresh process
   * picks a sensible value even with no prior history. Subsequent
   * calls within the same process advance via the counter, which
   * prevents same-second hash collisions on otherwise-identical
   * submits.
   */
  next(maker: string, speculationKey: string, currentFloor: bigint, nowSec: bigint): bigint {
    const k = NonceCounter.keyFor(maker, speculationKey);
    const last = this.lastUsed.get(k) ?? 0n;
    const next = max3(currentFloor, last + 1n, nowSec);
    this.lastUsed.set(k, next);
    return next;
  }

  /** Externally bump the counter when an explicit `nonce` was used. */
  observe(maker: string, speculationKey: string, used: bigint): void {
    const k = NonceCounter.keyFor(maker, speculationKey);
    const last = this.lastUsed.get(k) ?? 0n;
    if (used > last) this.lastUsed.set(k, used);
  }

  /**
   * Read the current per-instance high-water nonce for one
   * (maker, speculationKey). Returns `undefined` when this process has
   * never allocated a nonce for the pair. Used by
   * `cancelAllOnSpeculation` to fold in-process activity into the
   * default `newMinNonce` calculation without forcing the caller to
   * thread the counter explicitly.
   */
  peek(maker: string, speculationKey: string): bigint | undefined {
    return this.lastUsed.get(NonceCounter.keyFor(maker, speculationKey));
  }
}

function max3(a: bigint, b: bigint, c: bigint): bigint {
  let m = a;
  if (b > m) m = b;
  if (c > m) m = c;
  return m;
}
