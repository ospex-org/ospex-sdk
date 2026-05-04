/**
 * `commitments.cancelAllOnSpeculation(args)` — convenience wrapper
 * around `raiseMinNonce` that picks a safe default `newMinNonce` when
 * the caller doesn't specify one.
 *
 * Default newMinNonce = max(onChainFloor, lastInProcess, supabaseMaxStored) + 1.
 * Three candidates are blended for belt-and-suspenders coverage:
 *   1. on-chain `s_minNonces[maker][specKey]` — canonical authority,
 *      always available, but doesn't account for as-yet-unraised
 *      commitments the maker just signed.
 *   2. SDK's per-instance `lastInProcess` — picks up nonces this
 *      process just allocated for new commitments via `submit`. May be
 *      unset on a fresh process.
 *   3. Supabase max-stored nonce — projects all known commitments for
 *      this maker × speculation. Lags the chain by 5–20s on average,
 *      but covers the case where the SDK process restarted between
 *      `submit` and `cancelAllOnSpeculation`.
 *
 * Taking the max of the three avoids the failure mode where one source
 * is stale and the chosen `newMinNonce` doesn't actually invalidate the
 * commitments the caller wants gone.
 *
 * `invalidatedCount` is the number of rows that will flip
 * `nonce_invalidated=true` post-tx — computed up-front by filtering
 * Supabase rows on `nonce < newMinNonce`. Indexer lag means the actual
 * post-tx count may be slightly higher (commitments not yet projected),
 * but never lower for already-on-chain rows.
 */

import type { Hash, TransactionReceipt } from 'viem';
import { OspexValidationError } from '../errors.js';
import { deriveSpeculationKey } from '../chain/eip712.js';
import { readNonceFloor } from './nonce.js';
import { raiseMinNonce } from './raiseMinNonce.js';
import { validateLineTicks } from './validation.js';
import type { CommitmentsContext } from './context.js';
import type { CommitmentBody, CommitmentsListBody } from '../api/types.js';
import type { Hex } from '../types/signer.js';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface CancelAllOnSpeculationArgs {
  contestId: bigint;
  scorer: Hex;
  lineTicks: number;
  /**
   * Override the computed default. Must be strictly greater than the
   * on-chain floor (the contract reverts with `NonceMustIncrease`
   * otherwise).
   */
  newMinNonce?: bigint;
}

export interface CancelAllOnSpeculationResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  /** Rows that will flip `nonce_invalidated=true` — counted before the tx is sent. */
  invalidatedCount: number;
  newMinNonce: bigint;
}

const PAGE_LIMIT = 1000;
// Hard ceiling on pagination depth. 50 × 1000 = 50,000 rows for one
// (maker, contestId, scorer) tuple is already extreme; any caller above
// that should be coordinating nonces externally and passing an explicit
// `newMinNonce`.
const MAX_PAGES = 50;

export async function cancelAllOnSpeculation(
  ctx: CommitmentsContext,
  args: CancelAllOnSpeculationArgs,
): Promise<CancelAllOnSpeculationResult> {
  if (args.contestId < 0n) {
    throw new OspexValidationError('contestId must be non-negative.', { field: 'contestId' });
  }
  if (!ADDRESS_PATTERN.test(args.scorer)) {
    throw new OspexValidationError('scorer must be a 0x-prefixed 20-byte address.', { field: 'scorer' });
  }
  validateLineTicks(args.lineTicks);

  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const { matchingModule } = ctx.getAddresses();
  const maker = (await signer.getAddress()).toLowerCase() as Hex;
  const scorer = args.scorer.toLowerCase() as Hex;
  const speculationKey = deriveSpeculationKey(args.contestId, scorer, args.lineTicks);

  // Pull EVERY one of this maker's commitments on this (contestId,
  // scorer) tuple. We need the complete nonce history to pick a safe
  // default floor, AND a complete count of affected rows. The list
  // endpoint caps at limit=1000, so paginate until hasMore=false.
  // (`speculation_key` filtering happens client-side because the API
  // takes contestId + scorer + speculationId as filters but not
  // lineTicks directly.)
  const allRows: CommitmentBody[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await ctx.api.request<CommitmentsListBody>('/v1/commitments', {
      query: {
        maker,
        contestId: args.contestId.toString(),
        scorer,
        // 'expired' isn't a server-side status filter; expiry is
        // governed by includeExpired (which gates a `expiry > now()`
        // clause).
        status: 'open,partially_filled,filled,cancelled',
        includeInvalidated: true,
        includeExpired: true,
        limit: PAGE_LIMIT,
        offset,
      },
    });
    allRows.push(...body.commitments);
    // Defensive: stop if the server returned an empty page (hasMore
    // shouldn't be true with empty commitments, but if it ever is we
    // need to break to avoid an infinite loop).
    if (body.commitments.length === 0) break;
    if (!body.pagination.hasMore) break;
    offset += body.commitments.length;
    if (page === MAX_PAGES - 1) {
      throw new OspexValidationError(
        `Maker has more than ${MAX_PAGES * PAGE_LIMIT} commitments matching ` +
          `(maker, contestId=${args.contestId}, scorer); cannot safely auto-compute newMinNonce. ` +
          'Pass an explicit newMinNonce to bypass.',
        { field: 'newMinNonce' },
      );
    }
  }
  const speculationKeyLower = speculationKey.toLowerCase();
  const matching = allRows.filter(
    (c) => (c.speculationKey ?? '').toLowerCase() === speculationKeyLower,
  );

  let newMinNonce: bigint;
  if (args.newMinNonce !== undefined) {
    if (args.newMinNonce <= 0n) {
      throw new OspexValidationError('newMinNonce must be positive.', { field: 'newMinNonce' });
    }
    newMinNonce = args.newMinNonce;
  } else {
    const onChainFloor = await readNonceFloor(
      publicClient,
      matchingModule,
      maker,
      speculationKey,
    );
    const lastInProcess = ctx.nonceCounter.peek(maker, speculationKey) ?? 0n;
    const supabaseMaxStored = matching.reduce<bigint>((max, c) => {
      const n = BigInt(c.nonce);
      return n > max ? n : max;
    }, 0n);
    const candidates = [onChainFloor, lastInProcess, supabaseMaxStored];
    const peakRef = candidates.reduce<bigint>((m, v) => (v > m ? v : m), 0n);
    newMinNonce = peakRef + 1n;
  }

  // Count what's actually going to flip — only currently-matchable rows
  // below the new floor. Filled / cancelled rows aren't surface-level
  // affected (they're already terminal); cancelled is a separate status.
  const invalidatedCount = matching.reduce<number>((count, c) => {
    if (c.nonceInvalidated) return count;
    if (c.status !== 'open' && c.status !== 'partially_filled') return count;
    if (BigInt(c.nonce) >= newMinNonce) return count;
    return count + 1;
  }, 0);

  const { txHash, receipt } = await raiseMinNonce(ctx, {
    contestId: args.contestId,
    scorer,
    lineTicks: args.lineTicks,
    newMinNonce,
  });

  return { txHash, receipt, invalidatedCount, newMinNonce };
}
