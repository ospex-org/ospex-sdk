/**
 * `client.ownState.snapshot()` — one-shot REST consumer of
 * `GET /v1/own-state/snapshot?cursor=`.
 *
 * Pipeline:
 *   1. Mint a fresh stream-auth bearer (one mint per call — token caching
 *      is a higher-layer concern owned by the subscribe loop; one-shot
 *      callers pay the mint cost up front).
 *   2. GET the snapshot with `Authorization: Bearer <token>`.
 *   3. Decode the wire body into the public {@link OwnerStateSnapshot},
 *      including the wire→{@link OwnerCommitment} mapper that derives
 *      `visibility` from `bookVisible` and computes the `isLive`
 *      predicate at decode time (mirrors `toCommitment` in `api/commitments.ts`).
 *
 * Structural validation is declarative: every wire body is parsed against a
 * zod schema in `schemas.ts` and a structural failure surfaces as
 * {@link OspexValidationError} (via `parseWire`), so a malformed body throws
 * at the decode boundary rather than producing a mostly-`undefined` object.
 * The SSE subscribe path relies on this throw to abort the connection
 * (`frameAborted` discipline) so the cursor never advances past an undecoded
 * frame.
 *
 * Errors mirror `commitments.list/get`:
 *   - `OspexAPIError` for HTTP 4xx/5xx (apiCode preserved);
 *   - `OspexValidationError` for bad inputs / malformed wire bodies;
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
import { mintStreamToken } from './auth.js';
import { isOwnerCommitmentLiveAt } from './liveness.js';
import { parseWire, resolveStoredStatus } from '../wireSchema.js';
import {
  OwnerCommitmentBodySchema,
  OwnerStateSnapshotBodySchema,
  PositionStatusEventSchema,
  type OwnerCommitmentBodyParsed,
  type SignedCommitmentPayloadWireParsed,
} from './schemas.js';
import type {
  OwnerCommitment,
  OwnerStateSnapshot,
  PositionStatusEvent,
} from '../types/ownState.js';
import type {
  SignedCommitmentPayload,
  StoredCommitmentStatus,
} from '../types/commitment.js';
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
 * Decode the wire body into the public surface. Exported so the SSE
 * consumer can reuse it for the inline `event: snapshot` frame on
 * cold-connect (the wire body shape is identical).
 *
 * Validates the composite shape AND every leaf in ONE parse against
 * {@link OwnerStateSnapshotBodySchema}: top-level (`cursor` non-empty string;
 * `commitments` / `positions` arrays; `truncated` / `positionsTruncated`
 * booleans) plus each inner commitment and position. A malformed body —
 * `{cursor: 123}`, `{truncated: "false"}`, `{positions: [{}]}` — throws
 * {@link OspexValidationError} at the decode boundary, before any
 * cursor-promotion / paging branch could act on a wrong-typed value. The
 * snapshot's `positions[]` enum is narrower than {@link PositionLifecycle}
 * (terminal `settledLost` / `void` are dropped per spec §6.1), so a position
 * mis-labelled with a terminal status is rejected by the discriminated union.
 */
export function decodeSnapshot(body: unknown): OwnerStateSnapshot {
  const parsed = parseWire(OwnerStateSnapshotBodySchema, body);
  return {
    cursor: parsed.cursor,
    commitments: parsed.commitments.map(toOwnerCommitmentFromParsed),
    positions: parsed.positions,
    truncated: parsed.truncated,
    positionsTruncated: parsed.positionsTruncated,
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
 *
 * Validates the wire body against {@link OwnerCommitmentBodySchema} (required
 * identity fields are non-empty strings, `status` is a valid enum, etc.) and
 * throws {@link OspexValidationError} on a malformed body. Used directly by
 * the SSE `commitment` frame path; the snapshot path goes through
 * {@link decodeSnapshot} which validates commitments inline.
 */
export function toOwnerCommitment(body: unknown): OwnerCommitment {
  return toOwnerCommitmentFromParsed(parseWire(OwnerCommitmentBodySchema, body));
}

/** Apply the wire→public transform to an already-validated commitment body. */
function toOwnerCommitmentFromParsed(body: OwnerCommitmentBodyParsed): OwnerCommitment {
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
    // `resolveStoredStatus` falls back to `status` (the raw value on those
    // builds) and REFUSES the one combination the fallback cannot express:
    // an effective `expired` with no stored value. This was a cast until the
    // #207 review found the same shape on the public commitment path, where
    // it published `storedStatus: 'expired'` into a four-value field.
    storedStatus: resolveStoredStatus(body),
    source: body.source,
    network: body.network,
    nonceInvalidated: body.nonceInvalidated,
    isLive: computeOwnerIsLive(body),
    createdAt: body.createdAt,
    // PR0b enrichment — pass-through, plus the signed-payload coercion.
    speculationId: body.speculationId,
    sport: body.sport,
    awayTeam: body.awayTeam,
    homeTeam: body.homeTeam,
    updatedAtUnixSec: body.updatedAtUnixSec,
    signedPayload: body.signedPayload === null ? null : coerceSignedPayload(body.signedPayload),
  };
}

/**
 * Coerce the validated signed-payload WIRE body (bigint struct fields as
 * decimal strings) into the SDK's {@link SignedCommitmentPayload} (bigint).
 * The `UINT256_STRING` schema guard guarantees the `BigInt(...)` calls can't
 * throw. Hex fields are cast — they're validated as non-empty strings and
 * `Hex` is a nominal brand; `cancelOnchainSigned` re-derives + asserts the
 * hash before any on-chain action, so a malformed hex never causes an
 * unguarded cancel.
 */
function coerceSignedPayload(wire: SignedCommitmentPayloadWireParsed): SignedCommitmentPayload {
  return {
    commitmentHash: wire.commitmentHash as Hex,
    commitment: {
      maker: wire.commitment.maker as Hex,
      contestId: BigInt(wire.commitment.contestId),
      scorer: wire.commitment.scorer as Hex,
      lineTicks: wire.commitment.lineTicks,
      positionType: wire.commitment.positionType,
      oddsTick: wire.commitment.oddsTick,
      riskAmount: BigInt(wire.commitment.riskAmount),
      nonce: BigInt(wire.commitment.nonce),
      expiry: BigInt(wire.commitment.expiry),
    },
    signature: wire.signature as Hex,
  };
}

/**
 * Wire → public {@link PositionStatusEvent} mapper for SSE
 * `event: positionStatus` frames. Validates the required dedup-key fields
 * (address, speculationId, positionType, status, sourceUpdatedAt) + the
 * `status` enum, and the optional `from` / `result` / `claimableAmount`
 * when present, against {@link PositionStatusEventSchema}. Throws
 * {@link OspexValidationError} on a malformed body — the SSE subscribe path
 * catches and triggers `frameAborted` teardown so cursor never advances past
 * an undecoded frame.
 */
export function decodePositionStatusEvent(body: unknown): PositionStatusEvent {
  const p = parseWire(PositionStatusEventSchema, body);
  // Map the validated body into the public shape. The optional fields are
  // added only when present so the result satisfies `exactOptionalPropertyTypes`
  // (an absent key, never an explicit `undefined` value).
  const out: PositionStatusEvent = {
    address: p.address,
    speculationId: p.speculationId,
    positionType: p.positionType,
    status: p.status,
    sourceUpdatedAt: p.sourceUpdatedAt,
  };
  if (p.from !== undefined) out.from = p.from;
  if (p.result !== undefined) out.result = p.result;
  if (p.claimableAmount !== undefined) out.claimableAmount = p.claimableAmount;
  return out;
}

/**
 * Stamp `OwnerCommitment.isLive` at decode time. Delegates to the single
 * shared predicate {@link isOwnerCommitmentLiveAt} (resolving the raw
 * lifecycle via the `storedStatus ?? status` fallback for older API builds),
 * evaluated against the current clock — so the decoder and every re-deriving
 * consumer (e.g. the `ospex own-state watch` CLI) share ONE definition and
 * cannot drift. See `ownState/liveness.ts` for the exact contract (null /
 * unparseable / non-future expiry all read as not-live).
 */
function computeOwnerIsLive(body: OwnerCommitmentBodyParsed): boolean {
  return isOwnerCommitmentLiveAt(
    {
      storedStatus: resolveStoredStatus(body),
      remainingRiskAmount: body.remainingRiskAmount,
      expiry: body.expiry,
      nonceInvalidated: body.nonceInvalidated,
    },
    Date.now(),
  );
}
