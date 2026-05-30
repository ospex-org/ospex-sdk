import { OspexValidationError } from '../errors.js';
import type { Commitment, PublicVisibleCommitment } from '../types/commitment.js';

/**
 * Narrow a public {@link Commitment} to {@link PublicVisibleCommitment} or throw
 * a structured {@link OspexValidationError} with `field: 'commitment'`. Used at
 * the entry of every SDK path that needs the matchable payload — `prepareMatch`,
 * `matchFromPreview`'s re-fetch, `cancelOnchain({ hash })`, the taker/you
 * preview helpers. A hidden body has no `signature` / `nonce` / `oddsTick` /
 * `riskAmount`, so refusing here is strictly cheaper than letting downstream
 * code dereference a `null` and produce a less obvious error.
 *
 * The error message points the caller at the owner-auth own-state surface
 * (`client.ownState.snapshot({address, cursor?})` returns ONE page —
 * callers needing the full book drain via cursor loop while truncated:true;
 * or `client.ownState.getCommitment({address, hash})` for a single-row
 * SNAPSHOT-SCOPE lookup that returns `OwnerCommitment | null` — null when
 * the snapshot drained without finding the hash; an arbitrary by-hash
 * owner-auth endpoint is future work). Third parties cannot recover the
 * matchable payload by any combination of public endpoints (own-state SSE
 * plan §2.3, locked).
 *
 * @param commitment The decoded public commitment row.
 * @param opts.purpose Verb describing the action attempted, woven into the
 *   thrown message (e.g. `'match'`, `'cancel on chain'`). Defaults to
 *   `'use the matchable payload of'`.
 */
export function requireVisibleCommitment(
  commitment: Commitment,
  opts: { purpose?: string } = {},
): PublicVisibleCommitment {
  if (commitment.redacted === false) return commitment;
  const verb = opts.purpose ?? 'use the matchable payload of';
  throw new OspexValidationError(
    `Cannot ${verb} commitment ${commitment.commitmentHash}: the maker pulled it ` +
      'off the public order book (book_visible=false) and the matchable payload ' +
      '(signature / nonce / risk / odds) is redacted from anonymous reads. ' +
      'Makers recover the full payload via owner-auth `client.ownState.snapshot({address, cursor?})` ' +
      '(returns ONE page — drain via cursor loop while truncated:true), or ' +
      '`client.ownState.getCommitment({address, hash})` for a single-row snapshot-scope lookup; ' +
      'third-party callers cannot match against a hidden commitment.',
    { field: 'commitment' },
  );
}
