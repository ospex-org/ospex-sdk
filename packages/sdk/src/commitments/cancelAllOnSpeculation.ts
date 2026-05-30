/**
 * `commitments.cancelAllOnSpeculation(args)` — wrapper around `raiseMinNonce`
 * that broadcasts the on-chain nonce-floor raise AND returns a visible-rows
 * preview count so the caller can confirm the floor before/after the tx.
 *
 * **`newMinNonce` is REQUIRED.** The function does not auto-compute a default
 * because no anonymous read surface can prove the floor is hidden-safe: the
 * core-api public list filters `book_visible=true` upstream (own-state SSE
 * plan §M2), so a maker's hidden-but-still-on-chain-matchable commitments at
 * higher nonces are invisible to the SDK from anonymous reads. Any
 * "convenience default" computed from those reads would silently leave such
 * commitments live — exactly the latent-exposure failure mode this primitive
 * exists to defend against. M5/PR3b ships the owner-auth `client.ownState.
 * snapshot({address, cursor?})` surface that CAN enumerate the maker's full
 * book (visible + hidden + recently-terminal), so a caller can externally
 * derive a hidden-safe floor; the SDK still requires the floor as an
 * explicit argument here to keep the failure mode loud. Source it from a
 * process-local nonce ledger, a private store of all signed commitments,
 * `commitments.getNonceFloor` + a delta covering off-book signatures, or
 * an owner-auth snapshot scan over the (contestId, scorer, lineTicks)
 * triple's max nonce + 1. **`snapshot()` returns ONE PAGE — to compute a
 * hidden-safe floor over the full book, callers MUST loop while
 * `snapshot.truncated === true`, passing `snapshot.cursor` back on each
 * call.** Computing `max(nonce) + 1` from only the first snapshot page
 * can leave higher-nonce hidden commitments live and is the same failure
 * mode the explicit-argument contract here is meant to prevent.
 *
 * What the function still provides on top of `raiseMinNonce`:
 *   - Argument validation (positive `newMinNonce`, address-shaped scorer,
 *     valid lineTicks, non-negative contestId).
 *   - An `invalidatedCount` preview computed by paging the maker's
 *     visible book on `(contestId, scorer)`, filtering to the speculation
 *     key, and counting rows currently matchable (status open /
 *     partially_filled, not nonce-invalidated) whose `nonce < newMinNonce`.
 *     This count is VISIBLE-ROWS-ONLY by construction; hidden rows are not
 *     counted (they don't appear in the list at all), but the on-chain
 *     `raiseMinNonce` itself DOES invalidate any matching commitment whose
 *     nonce < floor, hidden or not — the count is a preview of what the
 *     indexer will project, not a measurement of total chain effect.
 *
 * `invalidatedCount` is computed up-front by filtering Supabase rows on
 * `nonce < newMinNonce`. Indexer lag means the actual post-tx count may be
 * slightly higher (commitments not yet projected), but never lower for
 * already-on-chain visible rows.
 */

import type { Hash, TransactionReceipt } from 'viem';
import { OspexValidationError } from '../errors.js';
import { deriveSpeculationKey } from '../chain/eip712.js';
import { raiseMinNonce } from './raiseMinNonce.js';
import { validateLineTicks } from './validation.js';
import type { CommitmentsContext } from './context.js';
import type { CommitmentBody, CommitmentsListBody, CommitmentWireBody } from '../api/types.js';
import type { Hex } from '../types/signer.js';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface CancelAllOnSpeculationArgs {
  contestId: bigint;
  scorer: Hex;
  lineTicks: number;
  /**
   * Required. The on-chain floor to raise to — every commitment whose
   * `nonce < newMinNonce` for `(maker, speculationKey)` becomes
   * unmatchable post-tx (`MatchingModule__NonceTooLow` on subsequent
   * `matchCommitment` attempts). Must be strictly greater than the
   * current on-chain floor (`s_minNonces[maker][specKey]`); the contract
   * reverts with `NonceMustIncrease` otherwise. Must be positive.
   *
   * The function does NOT auto-compute this value. See the file-level
   * jsdoc for the reason — anonymous reads cannot enumerate the maker's
   * hidden book, so no SDK-computed default can prove the floor is
   * hidden-safe. M5/PR3b ships `client.ownState.snapshot({address, cursor?})`
   * which can enumerate the maker's hidden book; callers using
   * book-hide can now scan that surface for a hidden-safe floor before
   * calling this function. **`snapshot()` returns one page — callers
   * MUST drain every page (loop while `truncated:true`) before
   * computing `max(nonce) + 1`; a single-page read can leave
   * higher-nonce hidden commitments live.**
   */
  newMinNonce: bigint;
}

export interface CancelAllOnSpeculationResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  /**
   * Number of VISIBLE rows that will flip `nonce_invalidated=true` once
   * the indexer projects this tx — counted before the tx is sent. Hidden
   * commitments are not counted (they don't surface on anonymous reads),
   * but on-chain `raiseMinNonce` still invalidates them if their nonce
   * is below `newMinNonce` — the count understates the actual chain
   * effect, never overstates it.
   */
  invalidatedCount: number;
  newMinNonce: bigint;
}

const PAGE_LIMIT = 1000;
// Hard ceiling on pagination depth. 50 × 1000 = 50,000 rows for one
// (maker, contestId, scorer) tuple is already extreme; any caller above
// that should be coordinating outside this preview entirely.
const MAX_PAGES = 50;

export async function cancelAllOnSpeculation(
  ctx: CommitmentsContext,
  args: CancelAllOnSpeculationArgs,
): Promise<CancelAllOnSpeculationResult> {
  // Validate ARGS BEFORE any chain or API access — keep the rejection
  // above any side effects (sibling of `requireVisibleCommitment` ordering
  // in `cancelOnchain` + the redaction short-circuit in `checkFillability`).
  // `newMinNonce` undefined → typed error pointing operators at the reason
  // we removed the auto-default, so a stale caller learns about it instead
  // of silently hitting the contract's `NonceMustIncrease` revert with a
  // default value derived from a non-hidden-safe list.
  if (args.newMinNonce === undefined) {
    throw new OspexValidationError(
      'cancelAllOnSpeculation requires an explicit newMinNonce. The SDK cannot auto-compute ' +
        'a hidden-safe default from anonymous reads (the public commitments list filters ' +
        'book_visible=true upstream, so cross-process book-hidden commitments at higher nonces ' +
        'are invisible here). Supply the floor from a process-local nonce ledger you trust, ' +
        "from owner-auth own-state recovery (`client.ownState.snapshot({address, cursor?})` " +
        "enumerates the maker's full book — caller MUST drain every page while truncated:true " +
        'before computing max nonce; a single-page read can leave higher-nonce hidden ' +
        'commitments live), or via `commitments.getNonceFloor` for a one-off chain read of ' +
        'the current floor.',
      { field: 'newMinNonce' },
    );
  }
  if (args.newMinNonce <= 0n) {
    throw new OspexValidationError('newMinNonce must be positive.', { field: 'newMinNonce' });
  }
  if (args.contestId < 0n) {
    throw new OspexValidationError('contestId must be non-negative.', { field: 'contestId' });
  }
  if (!ADDRESS_PATTERN.test(args.scorer)) {
    throw new OspexValidationError('scorer must be a 0x-prefixed 20-byte address.', { field: 'scorer' });
  }
  validateLineTicks(args.lineTicks);

  const signer = ctx.requireSigner();
  const maker = (await signer.getAddress()).toLowerCase() as Hex;
  const scorer = args.scorer.toLowerCase() as Hex;
  const speculationKey = deriveSpeculationKey(args.contestId, scorer, args.lineTicks);

  // Pull EVERY one of this maker's visible commitments on this (contestId,
  // scorer) tuple — for the `invalidatedCount` preview only. The on-chain
  // raise itself doesn't need this list. The list endpoint caps at
  // limit=1000, so paginate until hasMore=false. (`speculation_key`
  // filtering happens client-side because the API takes contestId + scorer
  // + speculationId as filters but not lineTicks directly.)
  const allRows: CommitmentWireBody[] = [];
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
          `(maker, contestId=${args.contestId}, scorer); cannot compute invalidatedCount preview. ` +
          'The on-chain raise itself does not need this list — call raiseMinNonce directly.',
        { field: 'contestId' },
      );
    }
  }

  // The public list is filtered to `book_visible=true` upstream (core-api
  // M2), so in practice `allRows` carries only visible bodies. The narrow
  // below stays as belt-and-braces against a future recovery-overlap
  // response or server bug that leaks a hidden body — those rows have no
  // `speculationKey`, and reading it would crash the `matching` filter.
  const visibleRows = allRows.filter((c): c is CommitmentBody => c.redacted !== true);

  const speculationKeyLower = speculationKey.toLowerCase();
  const matching = visibleRows.filter(
    (c) => (c.speculationKey ?? '').toLowerCase() === speculationKeyLower,
  );

  // Count what's actually going to flip on the visible side — only
  // currently-matchable rows below the new floor. Filled / cancelled rows
  // aren't surface-level affected (they're already terminal). Hidden rows
  // can't be counted (not in `allRows`); on-chain they're still invalidated
  // if nonce < newMinNonce, but this count is a VISIBLE-only preview.
  const invalidatedCount = matching.reduce<number>((count, c) => {
    if (c.nonceInvalidated) return count;
    if (c.status !== 'open' && c.status !== 'partially_filled') return count;
    if (BigInt(c.nonce) >= args.newMinNonce) return count;
    return count + 1;
  }, 0);

  const { txHash, receipt } = await raiseMinNonce(ctx, {
    contestId: args.contestId,
    scorer,
    lineTicks: args.lineTicks,
    newMinNonce: args.newMinNonce,
  });

  return { txHash, receipt, invalidatedCount, newMinNonce: args.newMinNonce };
}
