/**
 * Reads `MatchingModule.s_filledRisk[commitmentHash]` for a batch of
 * commitment hashes — the canonical authority for how much of a
 * commitment's risk is already matched. The Supabase mirror
 * (`commitments.filled_risk_amount`, and the own-state stream derived
 * from it) is a derivative the indexer maintains and may lag the chain.
 *
 * Split out from `getFilledRisk.ts` for the same reason `nonce.ts` is
 * split out from `getNonceFloor.ts`: the raw read owns the RPC failure
 * mapping, the caller owns argument validation.
 *
 * Batched through Multicall3 via viem's `multicall`, pinned to one
 * block. `allowFailure: false` is deliberate — with `allowFailure: true`
 * a per-call revert comes back as `{ status: 'failure' }` and the
 * natural read of `result` is `undefined`, one coercion away from `0n`.
 * A `0n` filled risk means "nothing matched yet", which understates
 * nothing and overstates a maker's remaining obligation; the SDK never
 * lets a failed read wear that value. Every failure — a reverting call,
 * a chain without Multicall3, a node that has not reached the pinned
 * block — surfaces as `OspexChainError`.
 */

import type { Abi, PublicClient } from 'viem';
import { matchingModuleAbi } from '../contracts/abi/index.js';
import { OspexChainError } from '../errors.js';
import type { Hex } from '../types/signer.js';

/**
 * A JSON-imported ABI is typed as a broad structural union, not viem's
 * `Abi` (CLAUDE.md, "Build & dependency gotchas"). `readContract` takes
 * that shape through its own generic; `multicall`'s `contracts` requires
 * `Abi`, so the artifact is narrowed once here rather than at each entry.
 */
const MATCHING_MODULE_ABI = matchingModuleAbi as unknown as Abi;

export interface FilledRiskRead {
  /** The block every value below was read at. */
  atBlock: bigint;
  /** One value per input hash, in input order. */
  values: bigint[];
}

/**
 * Resolve the block (when the caller did not pin one) and read every
 * hash at it.
 *
 * When `blockNumber` is undefined this costs one extra round trip
 * (`eth_blockNumber`) before the aggregate. That is the price of
 * `atBlock` being the block the values were actually read at rather
 * than a label raced alongside them — see the `getFilledRisk` docblock.
 *
 * `cacheTime: 0` is load-bearing, not a default spelled out. `OspexClient`
 * memoises its viem client, and viem's `getBlockNumber` caches per client
 * for `cacheTime` — which defaults to `pollingInterval`, 4_000 ms. Left at
 * the default, a caller polling this read on one client (which is what a
 * funding guard does) would be handed a head up to 4s old on every call
 * after the first: the aggregate would still be coherent, but a fill that
 * landed in those seconds would be invisible, leaving filled risk
 * stale-low and the maker's remaining obligation OVERSTATED — the same
 * direction as the bug this read exists to remove. Measured on viem 2.55:
 * two `getFilledRisk` calls on one `OspexClient` shared a single
 * `eth_blockNumber` before this argument, and issue one each after it.
 */
export async function readFilledRiskAtBlock(
  publicClient: PublicClient,
  matchingModule: Hex,
  hashes: readonly Hex[],
  blockNumber: bigint | undefined,
): Promise<FilledRiskRead> {
  let atBlock: bigint;
  if (blockNumber !== undefined) {
    atBlock = blockNumber;
  } else {
    try {
      atBlock = await publicClient.getBlockNumber({ cacheTime: 0 });
    } catch (err) {
      throw new OspexChainError('Failed to resolve the current block number for a filled-risk read.', {
        cause: err,
      });
    }
  }

  let raw: unknown;
  try {
    raw = await publicClient.multicall({
      contracts: hashes.map((hash) => ({
        address: matchingModule,
        abi: MATCHING_MODULE_ABI,
        functionName: 's_filledRisk',
        args: [hash],
      })),
      allowFailure: false,
      blockNumber: atBlock,
    });
  } catch (err) {
    throw new OspexChainError('Failed to read filled risk from MatchingModule.', { cause: err });
  }

  // The ABI is a JSON artifact typed as a generic `Abi[]`, so viem cannot
  // narrow the result element type (see CLAUDE.md, "Build & dependency
  // gotchas"). Check the shape rather than casting through it: a short
  // array would silently mis-pair hashes with values in the caller's zip,
  // and a non-bigint element would reach a consumer's arithmetic.
  if (!Array.isArray(raw) || raw.length !== hashes.length) {
    throw new OspexChainError(
      `MatchingModule returned ${Array.isArray(raw) ? raw.length : 'a non-array'} filled-risk ` +
        `value(s) for ${hashes.length} hash(es).`,
    );
  }
  const values: bigint[] = [];
  for (const value of raw) {
    if (typeof value !== 'bigint') {
      throw new OspexChainError(
        `MatchingModule returned a ${typeof value} where a uint256 filled-risk value was expected.`,
      );
    }
    values.push(value);
  }

  return { atBlock, values };
}
