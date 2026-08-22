/**
 * `commitments.getFilledRisk({ hashes, blockNumber? })` — read
 * `MatchingModule.s_filledRisk` for a batch of commitment hashes
 * directly from the contract. The contract is the canonical authority;
 * the Supabase mirror (`commitments.filled_risk_amount`, and the
 * own-state stream derived from it) is a derivative that may lag the
 * chain by ~15s.
 *
 * Returns `0n` for a hash with no fill — the storage default, and a real
 * value rather than a sentinel. A hash that does not correspond to any
 * commitment reads `0n` too: `s_filledRisk` is a mapping, so "no fill"
 * and "no such commitment" are the same storage slot and this read
 * cannot tell them apart. Every failure path throws `OspexChainError`
 * instead, so `0n` never stands in for "the read did not happen".
 *
 * ## Why this exists
 *
 * A maker's remaining obligation on one commitment is
 * `riskAmount - s_filledRisk[hash]` — `MatchingModule.matchCommitment`
 * computes exactly that, and its NatSpec tells off-chain callers to read
 * `s_filledRisk` and size against it. A funding guard that compares
 * chain-read wallet balance / allowance against a filled figure taken
 * from the indexer is comparing two different instants: a landed match
 * lowers the balance immediately and the mirrored filled figure ~15s
 * later, so the guard briefly believes it must back risk that is already
 * matched. The shortfall equals the fill size exactly.
 *
 * ## Block coherence
 *
 * `atBlock` is the block the values were read at, not a label recorded
 * beside them. Pass `blockNumber` to pin the batch; omit it and the SDK
 * resolves the current block first — one uncached `eth_blockNumber` per
 * call, deliberately, because viem caches that read per client for
 * `cacheTime` (4s by default) and a polling caller would otherwise be
 * pinned to a head several seconds old — and pins to that. Either way
 * every value in `filledRisk` describes the same block, and `atBlock`
 * names it.
 *
 * To compare filled risk against funding at that same block, thread
 * `atBlock` into the funding reads — both accept the same optional
 * `blockNumber`:
 *
 * ```ts
 * const { atBlock, filledRisk } = await client.commitments.getFilledRisk({ hashes });
 * const balances  = await client.balances.read({ owner, blockNumber: atBlock });
 * const approvals = await client.approvals.read({ owner, blockNumber: atBlock });
 * ```
 *
 * A pinned read can fail on a load-balanced endpoint whose node has not
 * yet reached `atBlock` (`header not found`). That surfaces as
 * `OspexChainError` — the read refuses rather than answering from a
 * different block. Callers that would rather have an unpinned answer
 * than an error can omit `blockNumber` on the funding reads, in which
 * case the residual window is one round trip rather than an indexer lag,
 * and the ordering above is the one to keep: read filled risk first,
 * funding second. A fill landing between them lowers funding and leaves
 * the filled figure stale-low, which overstates the maker's remaining
 * obligation — the same direction as the bug this read exists to fix,
 * but bounded by a round trip instead of ~15s. Reading funding first
 * biases the other way. Pinning removes the choice.
 *
 * ## Batching
 *
 * The hashes go out as ONE viem `multicall` operation, which viem may
 * split into SEVERAL Multicall3 aggregates — not necessarily one. Both
 * configured chains carry Multicall3 at the address viem's own chain
 * definitions supply, so no address plumbing is needed and no per-hash
 * round trip happens. viem chunks at its default 1024-byte calldata
 * limit — 36 bytes per `s_filledRisk(bytes32)` call, so roughly 28
 * hashes per `eth_call` at viem 2.55; a 60-hash read measured as three
 * `eth_call`s (28 + 28 + 4). Every chunk carries the same pinned
 * `blockNumber`, so a split cannot cost coherence — that guarantee, not
 * the call count, is what the caller depends on. Pinned by
 * `readFilledRiskAtBlock`, covered by the chunk-coherence case in
 * `tests/commitments-getFilledRisk.test.ts`.
 */

import { OspexChainError, OspexValidationError } from '../errors.js';
import { readFilledRiskAtBlock } from './filledRisk.js';
import type { CommitmentsContext } from './context.js';
import type { Hex } from '../types/signer.js';

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface GetFilledRiskArgs {
  /**
   * Commitment hashes to read. Non-empty; each a 0x-prefixed 32-byte
   * hex string. Duplicates are refused (case-insensitively) rather than
   * collapsed, so the returned mapping has exactly one entry per input.
   */
  hashes: readonly Hex[];
  /**
   * Pin every read to this block. Omit to have the SDK resolve the
   * current block first and pin to that — `atBlock` is exact either way.
   */
  blockNumber?: bigint;
}

export interface FilledRiskSnapshot {
  /**
   * The block every value in `filledRisk` was read at. Pass it to
   * `client.balances.read` / `client.approvals.read` to compare filled
   * risk against funding at one instant.
   */
  atBlock: bigint;
  /**
   * `s_filledRisk[hash]` in 6-decimal USDC units, keyed by the hash
   * strings that were passed in — **verbatim**, not case-normalised, so
   * `filledRisk.get(h)` is defined for every `h` in `args.hashes` and
   * `filledRisk.size === args.hashes.length`.
   */
  filledRisk: Map<Hex, bigint>;
}

export async function getFilledRisk(
  ctx: CommitmentsContext,
  args: GetFilledRiskArgs,
): Promise<FilledRiskSnapshot> {
  const hashes = args.hashes;
  if (!Array.isArray(hashes as unknown) || hashes.length === 0) {
    throw new OspexValidationError(
      'hashes must be a non-empty array of 0x-prefixed 32-byte commitment hashes.',
      { field: 'hashes' },
    );
  }
  const seen = new Set<string>();
  for (const hash of hashes) {
    if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
      throw new OspexValidationError(
        'every entry in hashes must be a 0x-prefixed 32-byte commitment hash.',
        { field: 'hashes' },
      );
    }
    const seenKey = hash.toLowerCase();
    if (seen.has(seenKey)) {
      throw new OspexValidationError(
        `hashes contains ${hash} more than once. The result is one entry per hash, so a ` +
          'duplicate would collapse silently — de-duplicate before calling.',
        { field: 'hashes' },
      );
    }
    seen.add(seenKey);
  }
  if (args.blockNumber !== undefined && args.blockNumber < 0n) {
    throw new OspexValidationError('blockNumber must be non-negative.', { field: 'blockNumber' });
  }

  const publicClient = ctx.requireChainClient();
  const { matchingModule } = ctx.getAddresses();
  const { atBlock, values } = await readFilledRiskAtBlock(
    publicClient,
    matchingModule,
    hashes,
    args.blockNumber,
  );

  const filledRisk = new Map<Hex, bigint>();
  for (let i = 0; i < hashes.length; i += 1) {
    const hash = hashes[i];
    const value = values[i];
    if (hash === undefined || value === undefined) {
      // Unreachable: readFilledRiskAtBlock already refused a length
      // mismatch. Kept as a typed refusal rather than a `!` so a future
      // change there cannot silently produce a short mapping.
      throw new OspexChainError(
        `Filled-risk read returned ${values.length} value(s) for ${hashes.length} hash(es).`,
      );
    }
    filledRisk.set(hash, value);
  }

  return { atBlock, filledRisk };
}
