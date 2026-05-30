/**
 * `client.ownState.getCommitment(hash)` — owner-authenticated SNAPSHOT-SCOPE
 * recovery helper.
 *
 * Implementation: pages the owner-auth snapshot, searching each page's
 * `commitments[]` for the requested hash; returns the {@link OwnerCommitment}
 * the first time it matches OR `null` once the snapshot fully drains
 * (`truncated:false`) without finding it.
 *
 * Important framing (per Hermes review):
 *
 *   `null` MEANS "not in the maker's own-state snapshot scope" — NOT
 *   "doesn't exist anywhere on the protocol". The snapshot scope is
 *   active commitments (open + partially_filled, not nonce-invalidated,
 *   not past expiry) PLUS recently-terminal-since-last-cursor. A
 *   commitment that terminalized BEFORE the snapshot's recovery floor
 *   (no cursor → "now"; with cursor → the prior cursor) will not appear,
 *   and this function returns `null` for it even though it's a real
 *   commitment historically. For arbitrary owner-auth-by-hash lookup
 *   over the full history, a dedicated `/v1/own-state/commitments/:hash`
 *   endpoint is the right primitive (TBD; not in this PR).
 *
 * This helper is intended for low-frequency RECOVERY cases — e.g. an MM
 * needing to recover the signed payload for a commitment it knows it owns
 * but lost from local state. For the common-path subscribe loop, PR3c's
 * SSE consumer delivers commitments directly through the snapshot event.
 *
 * Mints exactly ONE bearer token regardless of how many pages it consumes;
 * the M3 token TTL (~15 min) easily covers a multi-page scan.
 */

import { OspexValidationError } from '../errors.js';
import { OwnStateApi } from '../api/ownState.js';
import type { ApiClient } from '../api/client.js';
import { mintStreamToken } from './auth.js';
import { toOwnerCommitment } from './snapshot.js';
import type { OwnerCommitment } from '../types/ownState.js';
import type { ChainId } from '../types/protocol.js';
import type { Hex, Signer } from '../types/signer.js';

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Page cap — a defensive bound on the recovery scan. The server's per-page
 * size is `OWN_STATE_SNAPSHOT_MAX_COMMITMENTS = 5000`, so 50 pages = 250k
 * commitments — well beyond any realistic single-maker book and the
 * server's own `SNAPSHOT_MAX_COMMITMENTS` configurability. A scan that
 * legitimately needs more pages indicates the hash isn't in the snapshot
 * scope and the dedicated endpoint is the right answer.
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
 * the hash is outside the maker's own-state snapshot scope (see file
 * header for what that means).
 *
 * Throws:
 *   - {@link OspexValidationError} on a malformed hash (pre-network);
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
    for (const body of wire.commitments) {
      if (body.commitmentHash.toLowerCase() === target) {
        return toOwnerCommitment(body);
      }
    }
    if (!wire.truncated) return null;
    cursor = wire.cursor;
  }
  // Page cap reached without finding the hash AND server still says
  // truncated. Treat as out-of-snapshot-scope; the dedicated endpoint
  // is the right answer for genuinely deep lookups.
  return null;
}
