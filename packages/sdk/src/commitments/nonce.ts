/**
 * Reads the maker's current nonce floor for a given speculation
 * directly from MatchingModule.s_minNonces — the canonical authority.
 * The Supabase mirror (`maker_nonce_floors`) is a derivative the
 * indexer maintains; the contract is always the source of truth.
 */

import type { PublicClient } from 'viem';
import { matchingModuleAbi } from '../contracts/abi/index.js';
import { OspexChainError } from '../errors.js';
import type { Hex } from '../types/signer.js';

export async function readNonceFloor(
  publicClient: PublicClient,
  matchingModule: Hex,
  maker: Hex,
  speculationKey: Hex,
): Promise<bigint> {
  try {
    const result = (await publicClient.readContract({
      address: matchingModule,
      abi: matchingModuleAbi,
      functionName: 's_minNonces',
      args: [maker, speculationKey],
    })) as bigint;
    return result;
  } catch (err) {
    throw new OspexChainError('Failed to read nonce floor from MatchingModule.', { cause: err });
  }
}
