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
import { OspexValidationError } from '../errors.js';
import type {
  OwnerCommitment,
  OwnerPosition,
  OwnerStateSnapshot,
  PositionLifecycle,
  PositionStatusEvent,
} from '../types/ownState.js';
import type { CommitmentStatus, StoredCommitmentStatus } from '../types/commitment.js';
import type { MarketType } from '../types/odds.js';
import type { ChainId } from '../types/protocol.js';
import type { Hex, Signer } from '../types/signer.js';

const COMMITMENT_STATUSES: ReadonlySet<CommitmentStatus> = new Set([
  'open',
  'partially_filled',
  'filled',
  'cancelled',
  'expired',
] as CommitmentStatus[]);

const POSITION_LIFECYCLES: ReadonlySet<PositionLifecycle> = new Set([
  'active',
  'pendingSettle',
  'claimable',
  'claimed',
  'settledLost',
  'void',
]);

/**
 * Owner snapshot positions are NARROWER than {@link PositionLifecycle}:
 * the snapshot helper drops zero-payout terminal rows, so `settledLost` /
 * `void` only appear on `positionStatus` SSE events, never in the
 * `positions[]` array. Validating against this narrower set rejects a
 * wire body that mis-labels a terminal-lost position as `'settledLost'`
 * in the snapshot — which would be a server contract violation.
 */
const OWNER_POSITION_STATUSES: ReadonlySet<'active' | 'pendingSettle' | 'claimable' | 'claimed'> =
  new Set(['active', 'pendingSettle', 'claimable', 'claimed'] as const);

const MARKET_TYPES: ReadonlySet<MarketType> = new Set([
  'moneyline',
  'spread',
  'total',
] as MarketType[]);

const PENDING_SETTLE_PREDICTED_WIN_SIDES: ReadonlySet<string> = new Set([
  'away',
  'home',
  'over',
  'under',
  'push',
]);

const POSITION_RESULTS: ReadonlySet<string> = new Set(['won', 'push', 'void']);

function requireString(
  obj: Record<string, unknown>,
  field: string,
  message: string,
): string {
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new OspexValidationError(message, { field });
  }
  return v;
}

function requireBoolean(
  obj: Record<string, unknown>,
  field: string,
  message: string,
): boolean {
  const v = obj[field];
  if (typeof v !== 'boolean') {
    throw new OspexValidationError(message, { field });
  }
  return v;
}

function requirePositionType(
  obj: Record<string, unknown>,
  field: string,
  message: string,
): 0 | 1 {
  const v = obj[field];
  if (v !== 0 && v !== 1) {
    throw new OspexValidationError(message, { field });
  }
  return v;
}

function requireNumber(
  obj: Record<string, unknown>,
  field: string,
  message: string,
): number {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new OspexValidationError(message, { field });
  }
  return v;
}

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
 *
 * **Validates the required identity fields** (commitmentHash, maker,
 * nonce, riskAmount{,filled,remaining}, status, createdAt) — throws
 * {@link OspexValidationError} on a malformed wire body (e.g. `{}` or a
 * partial body missing required fields). Pre-v0.5.2-round-4 this was a
 * structural pass-through that silently produced an OwnerCommitment of
 * mostly-undefined fields; the SSE subscribe path's `frameAborted`
 * discipline now relies on this throw to abort the connection on
 * malformed wire bodies. Nullable fields (`contestId`, `scorer`,
 * `lineTicks`, `positionType`, `oddsTick`, `marketType`, `expiry`,
 * `speculationKey`, `signature`) pass through whatever the body carries
 * — validation only catches the truly-required-for-identity fields.
 */
export function toOwnerCommitment(body: OwnerCommitmentBody): OwnerCommitment {
  if (typeof body !== 'object' || body === null) {
    throw new OspexValidationError('OwnerCommitment body must be a non-null object', { field: 'body' });
  }
  const b = body as unknown as Record<string, unknown>;
  const commitmentHash = requireString(
    b,
    'commitmentHash',
    'OwnerCommitment body is missing or has invalid `commitmentHash`',
  );
  const maker = requireString(
    b,
    'maker',
    'OwnerCommitment body is missing or has invalid `maker`',
  );
  const nonce = requireString(
    b,
    'nonce',
    'OwnerCommitment body is missing or has invalid `nonce`',
  );
  const riskAmount = requireString(
    b,
    'riskAmount',
    'OwnerCommitment body is missing or has invalid `riskAmount`',
  );
  const filledRiskAmount = requireString(
    b,
    'filledRiskAmount',
    'OwnerCommitment body is missing or has invalid `filledRiskAmount`',
  );
  const remainingRiskAmount = requireString(
    b,
    'remainingRiskAmount',
    'OwnerCommitment body is missing or has invalid `remainingRiskAmount`',
  );
  const statusRaw = b.status;
  if (typeof statusRaw !== 'string' || !COMMITMENT_STATUSES.has(statusRaw as CommitmentStatus)) {
    throw new OspexValidationError(
      'OwnerCommitment body is missing or has invalid `status`',
      { field: 'status' },
    );
  }
  const status = statusRaw as CommitmentStatus;
  requireBoolean(
    b,
    'nonceInvalidated',
    'OwnerCommitment body is missing or has invalid `nonceInvalidated`',
  );
  const createdAt = requireString(
    b,
    'createdAt',
    'OwnerCommitment body is missing or has invalid `createdAt`',
  );

  const visibility: 'visible' | 'hidden' = body.bookVisible === false ? 'hidden' : 'visible';
  return {
    ownerAuthorized: true,
    visibility,
    redacted: false,
    commitmentHash,
    maker,
    contestId: body.contestId,
    scorer: body.scorer,
    lineTicks: body.lineTicks,
    positionType: body.positionType,
    oddsTick: body.oddsTick,
    marketType: body.marketType,
    riskAmount,
    filledRiskAmount,
    remainingRiskAmount,
    nonce,
    expiry: body.expiry,
    speculationKey: body.speculationKey,
    signature: body.signature,
    status,
    // Older core-api builds (predating effective-status) omit `storedStatus`;
    // fall back to `status` (which equals the raw value on those builds).
    storedStatus: body.storedStatus ?? (status as StoredCommitmentStatus),
    source: body.source,
    network: body.network,
    nonceInvalidated: body.nonceInvalidated,
    isLive: computeOwnerIsLive(body),
    createdAt,
  };
}

/**
 * Wire → public {@link PositionStatusEvent} mapper for SSE
 * `event: positionStatus` frames. Validates the required dedup-key fields
 * (address, speculationId, positionType, status, sourceUpdatedAt) and the
 * `status` enum. Throws {@link OspexValidationError} on a malformed wire
 * body — the SSE subscribe path catches and triggers `frameAborted`
 * teardown so cursor never advances past an undecoded frame.
 *
 * Pre-v0.5.2-round-4 there was no decoder for this surface: the SSE path
 * cast `wire as PositionStatusEvent` after only `safeParseJson`, so a
 * valid-JSON but structurally-malformed body (e.g. `{}`) was delivered to
 * `onPositionStatus` as `{}` and the cursor advanced past it — Hermes
 * Phase 3 PR0a round-3 review flagged this as a structural decode hole.
 */
export function decodePositionStatusEvent(body: unknown): PositionStatusEvent {
  if (typeof body !== 'object' || body === null) {
    throw new OspexValidationError(
      'PositionStatusEvent body must be a non-null object',
      { field: 'body' },
    );
  }
  const b = body as Record<string, unknown>;
  const address = requireString(
    b,
    'address',
    'PositionStatusEvent body is missing or has invalid `address`',
  );
  const speculationId = requireString(
    b,
    'speculationId',
    'PositionStatusEvent body is missing or has invalid `speculationId`',
  );
  const positionType = requirePositionType(
    b,
    'positionType',
    'PositionStatusEvent body is missing or has invalid `positionType`',
  );
  const statusRaw = b.status;
  if (typeof statusRaw !== 'string' || !POSITION_LIFECYCLES.has(statusRaw as PositionLifecycle)) {
    throw new OspexValidationError(
      'PositionStatusEvent body is missing or has invalid `status`',
      { field: 'status' },
    );
  }
  const status = statusRaw as PositionLifecycle;
  const sourceUpdatedAt = requireString(
    b,
    'sourceUpdatedAt',
    'PositionStatusEvent body is missing or has invalid `sourceUpdatedAt`',
  );
  const out: PositionStatusEvent = {
    address,
    speculationId,
    positionType,
    status,
    sourceUpdatedAt,
  };
  // Optional fields — pass through if present, validate if so.
  if (b.from !== undefined) {
    if (typeof b.from !== 'string' || !POSITION_LIFECYCLES.has(b.from as PositionLifecycle)) {
      throw new OspexValidationError(
        'PositionStatusEvent `from` is present but has invalid value',
        { field: 'from' },
      );
    }
    out.from = b.from as PositionLifecycle;
  }
  if (b.result !== undefined) {
    if (b.result !== 'won' && b.result !== 'lost' && b.result !== 'push' && b.result !== 'void') {
      throw new OspexValidationError(
        'PositionStatusEvent `result` is present but has invalid value',
        { field: 'result' },
      );
    }
    out.result = b.result;
  }
  if (b.claimableAmount !== undefined) {
    if (typeof b.claimableAmount !== 'string' || b.claimableAmount.length === 0) {
      throw new OspexValidationError(
        'PositionStatusEvent `claimableAmount` is present but has invalid value',
        { field: 'claimableAmount' },
      );
    }
    out.claimableAmount = b.claimableAmount;
  }
  return out;
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

/**
 * Wire → public {@link OwnerPosition} mapper. Validates the discriminating
 * `status` (must be one of the snapshot's narrower set — terminal lost /
 * void rows never appear here per spec §6.1), the common identity fields,
 * AND the status-specific fields per discriminator. Throws
 * {@link OspexValidationError} on a malformed wire body.
 *
 * Pre-v0.5.2-round-5 this was a non-exhaustive switch with no validation
 * — a missing or unknown `status` fell through ALL `case` returns and the
 * function returned `undefined` despite being typed `OwnerPosition`.
 * `decodeSnapshot({positions: [{}]})` therefore silently produced
 * `positions: [undefined]` — Hermes Phase 3 PR0a round-4 review flagged
 * this as a sibling structural-decode hole of the `positionStatus` /
 * `commitment` / `fill` pass-throughs fixed in round 4.
 */
function toOwnerPosition(body: OwnerPositionBody): OwnerPosition {
  if (typeof body !== 'object' || body === null) {
    throw new OspexValidationError(
      'OwnerPosition body must be a non-null object',
      { field: 'body' },
    );
  }
  const b = body as unknown as Record<string, unknown>;
  const statusRaw = b.status;
  if (
    typeof statusRaw !== 'string' ||
    !OWNER_POSITION_STATUSES.has(statusRaw as 'active' | 'pendingSettle' | 'claimable' | 'claimed')
  ) {
    throw new OspexValidationError(
      'OwnerPosition body is missing or has invalid `status`',
      { field: 'status' },
    );
  }
  const status = statusRaw as 'active' | 'pendingSettle' | 'claimable' | 'claimed';

  // Common identity / dedup fields — every status carries these.
  const positionId = requireString(
    b,
    'positionId',
    'OwnerPosition body is missing or has invalid `positionId`',
  );
  const speculationId = requireString(
    b,
    'speculationId',
    'OwnerPosition body is missing or has invalid `speculationId`',
  );
  const positionType = requirePositionType(
    b,
    'positionType',
    'OwnerPosition body is missing or has invalid `positionType`',
  );
  const team = requireString(
    b,
    'team',
    'OwnerPosition body is missing or has invalid `team`',
  );
  const opponent = requireString(
    b,
    'opponent',
    'OwnerPosition body is missing or has invalid `opponent`',
  );
  const marketRaw = b.market;
  if (typeof marketRaw !== 'string' || !MARKET_TYPES.has(marketRaw as MarketType)) {
    throw new OspexValidationError(
      'OwnerPosition body is missing or has invalid `market`',
      { field: 'market' },
    );
  }
  const market = marketRaw as MarketType;
  // `oddsDecimal` is nullable per the type — validate ONLY if present-and-not-null.
  let oddsDecimal: number | null;
  if (b.oddsDecimal === null) {
    oddsDecimal = null;
  } else {
    oddsDecimal = requireNumber(
      b,
      'oddsDecimal',
      'OwnerPosition body has invalid `oddsDecimal`',
    );
  }
  const riskAmountUSDC = requireNumber(
    b,
    'riskAmountUSDC',
    'OwnerPosition body is missing or has invalid `riskAmountUSDC`',
  );
  const profitAmountUSDC = requireNumber(
    b,
    'profitAmountUSDC',
    'OwnerPosition body is missing or has invalid `profitAmountUSDC`',
  );

  const baseFields = {
    positionId,
    speculationId,
    positionType,
    team,
    opponent,
    market,
    oddsDecimal,
    riskAmountUSDC,
    profitAmountUSDC,
  };

  // Status-specific fields. Each discriminator brings its own required
  // payout / claimedAt metadata; validate them rather than relying on the
  // server contract alone (a malformed body that says `status: 'pendingSettle'`
  // but is missing `result` / `estimatedPayoutWei6` would otherwise produce
  // a `pendingSettle` row with mostly-undefined fields).
  switch (status) {
    case 'active':
      return { ...baseFields, status: 'active' };
    case 'pendingSettle': {
      const resultRaw = b.result;
      if (typeof resultRaw !== 'string' || !POSITION_RESULTS.has(resultRaw)) {
        throw new OspexValidationError(
          'OwnerPosition (pendingSettle) body is missing or has invalid `result`',
          { field: 'result' },
        );
      }
      const predictedWinSideRaw = b.predictedWinSide;
      if (
        typeof predictedWinSideRaw !== 'string' ||
        !PENDING_SETTLE_PREDICTED_WIN_SIDES.has(predictedWinSideRaw)
      ) {
        throw new OspexValidationError(
          'OwnerPosition (pendingSettle) body is missing or has invalid `predictedWinSide`',
          { field: 'predictedWinSide' },
        );
      }
      const estimatedPayoutUSDC = requireNumber(
        b,
        'estimatedPayoutUSDC',
        'OwnerPosition (pendingSettle) body is missing or has invalid `estimatedPayoutUSDC`',
      );
      const estimatedPayoutWei6 = requireString(
        b,
        'estimatedPayoutWei6',
        'OwnerPosition (pendingSettle) body is missing or has invalid `estimatedPayoutWei6`',
      );
      return {
        ...baseFields,
        status: 'pendingSettle',
        result: resultRaw as 'won' | 'push' | 'void',
        predictedWinSide: predictedWinSideRaw as 'away' | 'home' | 'over' | 'under' | 'push',
        estimatedPayoutUSDC,
        estimatedPayoutWei6,
      };
    }
    case 'claimable': {
      const resultRaw = b.result;
      if (typeof resultRaw !== 'string' || !POSITION_RESULTS.has(resultRaw)) {
        throw new OspexValidationError(
          'OwnerPosition (claimable) body is missing or has invalid `result`',
          { field: 'result' },
        );
      }
      const estimatedPayoutUSDC = requireNumber(
        b,
        'estimatedPayoutUSDC',
        'OwnerPosition (claimable) body is missing or has invalid `estimatedPayoutUSDC`',
      );
      const estimatedPayoutWei6 = requireString(
        b,
        'estimatedPayoutWei6',
        'OwnerPosition (claimable) body is missing or has invalid `estimatedPayoutWei6`',
      );
      return {
        ...baseFields,
        status: 'claimable',
        result: resultRaw as 'won' | 'push' | 'void',
        estimatedPayoutUSDC,
        estimatedPayoutWei6,
      };
    }
    case 'claimed': {
      // `claimedAt` is nullable per the type — allow null OR a non-empty string.
      let claimedAt: string | null;
      if (b.claimedAt === null) {
        claimedAt = null;
      } else if (typeof b.claimedAt === 'string' && b.claimedAt.length > 0) {
        claimedAt = b.claimedAt;
      } else {
        throw new OspexValidationError(
          'OwnerPosition (claimed) body has invalid `claimedAt` (must be string or null)',
          { field: 'claimedAt' },
        );
      }
      return { ...baseFields, status: 'claimed', claimedAt };
    }
  }
}
