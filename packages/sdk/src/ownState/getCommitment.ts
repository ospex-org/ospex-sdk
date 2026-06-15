/**
 * `client.ownState.getCommitment(hash)` — owner-authenticated SNAPSHOT-SCOPE
 * recovery helper.
 *
 * Implementation: pages the owner-auth snapshot, searching each page's
 * `commitments[]` for the requested hash; returns the {@link OwnerCommitment}
 * the first time it matches, OR `null` once a page with `truncated:false`
 * has been scanned without finding it.
 *
 * Locked semantics (per review):
 *
 *   - {@link OwnerCommitment} ⇒ row is in the maker's owner-auth snapshot scope.
 *   - `null`                  ⇒ the snapshot DRAINED (a page returned
 *                                `truncated:false`) without containing the
 *                                hash. The hash is outside active +
 *                                recently-terminal scope — NOT necessarily
 *                                "doesn't exist anywhere". For arbitrary
 *                                owner-auth-by-hash over full history, a
 *                                dedicated `/v1/own-state/commitments/:hash`
 *                                endpoint is the right primitive (TBD).
 *   - `OspexOwnStateError({reason: 'scan_limit_exceeded'})` ⇒ the helper's
 *                                defensive page bound was reached and the
 *                                last response was still `truncated:true`.
 *                                The result is UNKNOWN — callers MUST NOT
 *                                treat this as `null` (snapshot drained).
 *                                Drive the recovery via `snapshot()` directly
 *                                or wait for the dedicated endpoint.
 *
 * This helper is intended for low-frequency RECOVERY cases — e.g. an MM
 * needing to recover the signed payload for a commitment it knows it owns
 * but lost from local state. For the common-path subscribe loop, PR3c's
 * SSE consumer delivers commitments directly through the snapshot event.
 *
 * Mints exactly ONE bearer token regardless of how many pages it consumes;
 * the M3 token TTL (~15 min) easily covers a multi-page scan.
 */

import { OspexOwnStateError, OspexValidationError } from '../errors.js';
import { OwnStateApi } from '../api/ownState.js';
import type { ApiClient } from '../api/client.js';
import { mintStreamToken } from './auth.js';
import { decodeSnapshot } from './snapshot.js';
import type { OwnerCommitment } from '../types/ownState.js';
import type { ChainId } from '../types/protocol.js';
import type { Hex, Signer } from '../types/signer.js';

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Page cap — a defensive bound on the recovery scan. The server's per-page
 * size is `OWN_STATE_SNAPSHOT_MAX_COMMITMENTS = 5000`, so 50 pages = 250k
 * commitments — well beyond any realistic single-maker book and the
 * server's own `SNAPSHOT_MAX_COMMITMENTS` configurability. Reaching this
 * bound with the server STILL reporting `truncated:true` is not a
 * silent-"not found" verdict; we throw `OspexOwnStateError({reason:
 * 'scan_limit_exceeded'})` so callers can't mistake a bounded scan for an
 * authoritative drain.
 */
const MAX_SNAPSHOT_PAGES = 50;

export interface GetOwnerCommitmentArgs {
  api: ApiClient;
  signer: Signer;
  address: Hex;
  chainId: ChainId;
  matchingModule: Hex;
  hash: Hex;
}

/**
 * Returns the maker's owner-auth commitment for `hash`, OR `null` when
 * the snapshot DRAINED (a page returned `truncated:false`) without
 * containing the hash — see the file header for the locked semantics.
 *
 * Throws:
 *   - {@link OspexValidationError} on a malformed hash (pre-network);
 *   - {@link OspexOwnStateError}({reason: 'scan_limit_exceeded'}) when the
 *     defensive page bound is reached and the last response was still
 *     `truncated:true` (result is UNKNOWN — NOT equivalent to `null`);
 *   - {@link OspexAPIError} on auth / cursor / 5xx from the server;
 *   - propagates signer errors from `mintStreamToken`.
 */
export async function getOwnerCommitment(
  args: GetOwnerCommitmentArgs,
): Promise<OwnerCommitment | null> {
  if (typeof args.hash !== 'string' || !HASH_PATTERN.test(args.hash)) {
    throw new OspexValidationError(
      'ownState.getCommitment hash must be a 0x-prefixed 32-byte hex string.',
      { field: 'hash' },
    );
  }
  const target = args.hash.toLowerCase();

  const { token } = await mintStreamToken({
    api: args.api,
    signer: args.signer,
    address: args.address,
    chainId: args.chainId,
    matchingModule: args.matchingModule,
  });
  const ownStateApi = new OwnStateApi(args.api);

  let cursor: string | undefined;
  for (let page = 0; page < MAX_SNAPSHOT_PAGES; page += 1) {
    const wire = await ownStateApi.snapshot(
      token,
      cursor !== undefined ? { cursor } : {},
    );
    // Route through decodeSnapshot so the page's full structural shape
    // (top-level fields + every commitment + every position) is validated
    // before any field is trusted: a malformed page fails closed with
    // OspexValidationError rather than a raw TypeError on `.toLowerCase()`
    // or a silently-wrong `truncated` / `cursor`. (review-round-7
    // finding — this helper previously read `wire.commitments` raw,
    // bypassing decodeSnapshot's validation.)
    const decoded = decodeSnapshot(wire);
    const match = decoded.commitments.find(
      (c) => c.commitmentHash.toLowerCase() === target,
    );
    if (match !== undefined) return match;
    if (!decoded.truncated) return null;
    cursor = decoded.cursor;
  }
  // Page cap reached AND server still reports `truncated:true`. This is
  // UNKNOWN — a bounded helper hit its bound without seeing a page that
  // would prove drain. Returning `null` here would silently re-classify
  // an unknown verdict as "outside snapshot scope", which an MM cancel
  // path could trust as "no live exposure to recover" and act on. Throw
  // a typed error instead so the caller has to make a deliberate choice
  // (drive `snapshot()` manually, raise the bound, wait for the
  // dedicated by-hash endpoint).
  throw new OspexOwnStateError(
    `ownState.getCommitment exceeded the defensive page bound (${MAX_SNAPSHOT_PAGES} pages) ` +
      'while the server was still returning truncated:true. The result is UNKNOWN — NOT ' +
      'equivalent to null. Drive the recovery via client.ownState.snapshot({address, cursor}) ' +
      'directly, or wait for the dedicated /v1/own-state/commitments/:hash endpoint.',
    { reason: 'scan_limit_exceeded', pagesScanned: MAX_SNAPSHOT_PAGES },
  );
}
