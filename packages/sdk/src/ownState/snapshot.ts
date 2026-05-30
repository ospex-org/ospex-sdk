/**
 * `client.ownState.snapshot()` — one-shot REST consumer of
 * `GET /v1/own-state/snapshot?cursor=`.
 *
 * Pipeline:
 *   1. Mint a fresh stream-auth bearer (one mint per call — token caching
 *      is a higher-layer concern owned by PR3c's subscribe loop; one-shot
 *      callers pay the mint cost up front).
 *   2. GET the snapshot with `Authorization: Bearer <token>`.
 *   3. Decode the wire body into the public {@link OwnerStateSnapshot},
 *      including the wire→{@link OwnerCommitment} mapper that derives
 *      `visibility` from `bookVisible` and computes the `isLive`
 *      predicate at decode time (mirrors `toCommitment` in `api/commitments.ts`).
 *
 * Errors mirror `commitments.list/get`:
 *   - `OspexAPIError` for HTTP 4xx/5xx (apiCode preserved);
 *   - `OspexValidationError` for bad inputs (malformed address / cursor);
 *   - `OspexSigningError` propagated from the signer if EIP-712 fails.
 *
 * Pagination: this is NOT recursive — one snapshot call = one page. The
 * caller drives the loop:
 *
 *   let cursor = undefined;
 *   do {
 *     const s = await client.ownState.snapshot({ cursor });
 *     ...consume s.commitments, s.positions...
 *     cursor = s.cursor;
 *   } while (s.truncated);
 *
 * `getCommitment.ts` pages internally up to `MAX_SNAPSHOT_PAGES`.
 */

import { OwnStateApi } from '../api/ownState.js';
import type { ApiClient } from '../api/client.js';
import type { OwnerCommitmentBody, OwnerPositionBody, OwnerStateSnapshotBody } from '../api/types.js';
import { mintStreamToken } from './auth.js';
import type { OwnerCommitment, OwnerPosition, OwnerStateSnapshot } from '../types/ownState.js';
import type { StoredCommitmentStatus } from '../types/commitment.js';
import type { ChainId } from '../types/protocol.js';
import type { Hex, Signer } from '../types/signer.js';

export interface LoadOwnStateSnapshotArgs {
  api: ApiClient;
  signer: Signer;
  address: Hex;
  chainId: ChainId;
  matchingModule: Hex;
  /** Opaque cursor from a prior snapshot response. Omit on the first call. */
  cursor?: string;
}

/**
 * Mint a token + fetch + decode one snapshot page. Caller decides whether
 * to keep paging based on `result.truncated`.
 */
export async function loadOwnStateSnapshot(
  args: LoadOwnStateSnapshotArgs,
): Promise<OwnerStateSnapshot> {
  const { token } = await mintStreamToken({
    api: args.api,
    signer: args.signer,
    address: args.address,
    chainId: args.chainId,
    matchingModule: args.matchingModule,
  });
  const ownStateApi = new OwnStateApi(args.api);
  const wire = await ownStateApi.snapshot(
    token,
    args.cursor !== undefined ? { cursor: args.cursor } : {},
  );
  return decodeSnapshot(wire);
}

/**
 * Decode the wire body into the public surface. Exported so PR3c's SSE
 * consumer can reuse it for the inline `event: snapshot` frame on
 * cold-connect (the wire body shape is identical).
 */
export function decodeSnapshot(body: OwnerStateSnapshotBody): OwnerStateSnapshot {
  return {
    cursor: body.cursor,
    commitments: body.commitments.map(toOwnerCommitment),
    positions: body.positions.map(toOwnerPosition),
    truncated: body.truncated,
    positionsTruncated: body.positionsTruncated,
  };
}

/**
 * Wire → public {@link OwnerCommitment} mapper. Owner-auth always carries
 * the full payload; the only branch is `visibility` derived from
 * `bookVisible` (`true` / `undefined` → `'visible'`; `false` → `'hidden'`).
 *
 * `isLive` is computed at decode time — same predicate as
 * `PublicVisibleCommitment.isLive` so a maker can reuse the same
 * matchability check regardless of which type the row came back as.
 */
export function toOwnerCommitment(body: OwnerCommitmentBody): OwnerCommitment {
  const visibility: 'visible' | 'hidden' = body.bookVisible === false ? 'hidden' : 'visible';
  return {
    ownerAuthorized: true,
    visibility,
    redacted: false,
    commitmentHash: body.commitmentHash,
    maker: body.maker,
    contestId: body.contestId,
    scorer: body.scorer,
    lineTicks: body.lineTicks,
    positionType: body.positionType,
    oddsTick: body.oddsTick,
    marketType: body.marketType,
    riskAmount: body.riskAmount,
    filledRiskAmount: body.filledRiskAmount,
    remainingRiskAmount: body.remainingRiskAmount,
    nonce: body.nonce,
    expiry: body.expiry,
    speculationKey: body.speculationKey,
    signature: body.signature,
    status: body.status,
    // Older core-api builds (predating effective-status) omit `storedStatus`;
    // fall back to `status` (which equals the raw value on those builds).
    storedStatus: body.storedStatus ?? (body.status as StoredCommitmentStatus),
    source: body.source,
    network: body.network,
    nonceInvalidated: body.nonceInvalidated,
    isLive: computeOwnerIsLive(body),
    createdAt: body.createdAt,
  };
}

/**
 * Mirrors the `MatchingModule.matchCommitment` precondition set the same
 * way `api/commitments.ts:computeIsLive` does for public visible bodies:
 *   1. raw stored status is `open` or `partially_filled`;
 *   2. not nonce-invalidated;
 *   3. remainingRiskAmount > 0;
 *   4. expiry is in the future.
 * Hidden bodies (`visibility === 'hidden'`) still report `isLive` honestly —
 * they remain matchable on chain until they reach a terminal state.
 */
function computeOwnerIsLive(body: OwnerCommitmentBody): boolean {
  const lifecycle = body.storedStatus ?? body.status;
  if (lifecycle !== 'open' && lifecycle !== 'partially_filled') return false;
  if (body.nonceInvalidated) return false;
  if (BigInt(body.remainingRiskAmount) <= 0n) return false;
  if (body.expiry === null) return false;
  const expiryMs = Date.parse(body.expiry);
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return false;
  return true;
}

function toOwnerPosition(body: OwnerPositionBody): OwnerPosition {
  // The wire body is already a discriminated union by `status` matching the
  // public type, so this is a structural pass-through. Switch is exhaustive;
  // the default never hits if the server adheres to the wire contract.
  switch (body.status) {
    case 'active':
      return { ...body };
    case 'pendingSettle':
      return { ...body };
    case 'claimable':
      return { ...body };
    case 'claimed':
      return { ...body };
  }
}
