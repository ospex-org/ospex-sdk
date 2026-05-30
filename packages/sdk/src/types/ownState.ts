/**
 * Public types for `client.ownState.*` — owner-authenticated maker view
 * (own-state SSE plan v4 §6.1 + spec §M5 type-split locks).
 *
 * Discriminated from the anonymous-public {@link Commitment} union by the
 * `ownerAuthorized: true` tag. PublicVisibleCommitment / PublicHiddenCommitment
 * are what a third-party caller observes; {@link OwnerCommitment} is the
 * MAKER's view, delivered through `Authorization: Bearer <stream-token>` — full
 * payload regardless of `book_visible`, so a maker can recover the
 * matchable struct for a row they took off the public book.
 *
 * `OwnerStateSnapshot` is the wire body returned by
 * `client.ownState.snapshot()` (and inline on cold-connect of the M4b
 * composite SSE stream landing in PR3c). Pagination: when
 * `truncated:true`, pass `cursor` back to `snapshot({cursor})` until
 * `truncated:false`. `positionsTruncated:true` means the actionable
 * population hit the 200-row cap; there is NO snapshot paging mechanism
 * for positions — `client.positions.*` covers full history out-of-band.
 */

import type { CommitmentStatus, StoredCommitmentStatus } from './commitment.js';
import type { Fill } from './fill.js';
import type { MarketType } from './odds.js';
import type { Hex } from './signer.js';

/**
 * Owner-authenticated commitment — full matchable payload regardless of
 * `book_visible`. Delivered ONLY through `client.ownState.*` (snapshot /
 * subscribe / getCommitment). Anonymous public reads of the same row would
 * return {@link PublicVisibleCommitment} or {@link PublicHiddenCommitment}.
 *
 * Discriminate from the public union via `ownerAuthorized === true`. The
 * `visibility` field reports whether the maker still keeps this commitment
 * on the public book (`visible`) or has hidden it via off-chain DELETE
 * (`hidden`) — in either case the SIGNED payload is present, since this
 * type is only constructable from an owner-auth response.
 */
export interface OwnerCommitment {
  /**
   * Discriminator — only `true` here. A `Commitment` (anonymous) is
   * NEVER tagged as owner-authorized; narrow on this field to distinguish
   * the two universes at type level.
   */
  ownerAuthorized: true;
  /** Whether the maker keeps this commitment on the public anonymous book. */
  visibility: 'visible' | 'hidden';
  /** Always `false` — owner-auth bodies are unredacted. */
  redacted: false;
  commitmentHash: string;
  maker: string;
  contestId: string | null;
  scorer: string | null;
  lineTicks: number | null;
  positionType: 0 | 1 | null;
  oddsTick: number | null;
  marketType: MarketType | null;
  riskAmount: string;
  filledRiskAmount: string;
  remainingRiskAmount: string;
  nonce: string;
  /** ISO-8601 string. Null on legacy rows that predate the expiry column. */
  expiry: string | null;
  speculationKey: string | null;
  signature: string | null;
  /** EFFECTIVE lifecycle status — folds in time-expiry and nonce invalidation. */
  status: CommitmentStatus;
  /** Raw indexer status before effective-status derivation. */
  storedStatus: StoredCommitmentStatus;
  source: string;
  network: string;
  nonceInvalidated: boolean;
  /**
   * Derived: the row's raw on-chain lifecycle is `'open'` or
   * `'partially_filled'`, not `nonceInvalidated`, has `remainingRiskAmount > 0`,
   * and `expiry` is in the future. Mirrors the same predicate as
   * {@link PublicVisibleCommitment.isLive}. The maker uses this to decide
   * whether to authoritatively `cancelOnchain` a hidden commitment or let
   * it expire passively.
   */
  isLive: boolean;
  createdAt: string;
}

interface OwnerPositionBase {
  /** `${speculationId}_${user}_${positionType}` — R4 identity. */
  positionId: string;
  speculationId: string;
  /** 0 = upper (away/over), 1 = lower (home/under). */
  positionType: 0 | 1;
  /** The maker's side — `away` when `upper`, `home` when `lower`. */
  team: string;
  opponent: string;
  market: MarketType;
  /** Implied: `1 + (profitAmount / riskAmount)`. Null on legacy rows. */
  oddsDecimal: number | null;
  riskAmountUSDC: number;
  profitAmountUSDC: number;
}

/**
 * Owner-authenticated position row. Discriminated by `status`:
 *
 *   - `active`        — risk > 0, contest not yet scored;
 *   - `pendingSettle` — contest scored, speculation NOT yet settled;
 *                       carries the predicted winner + estimated payout;
 *   - `claimable`     — speculation settled, payout > 0, not yet claimed;
 *   - `claimed`       — `claimed=true`, terminal; carries `claimedAt`.
 *
 * Terminal `settledLost` / `void` rows DO NOT appear in the snapshot's
 * `positions` array (the categorization helper drops zero-payout terminal
 * rows). The composite SSE stream's `positionStatus` events deliver those
 * transitions explicitly (PR3c).
 */
export type OwnerPosition =
  | (OwnerPositionBase & { status: 'active' })
  | (OwnerPositionBase & {
      status: 'pendingSettle';
      result: 'won' | 'push' | 'void';
      predictedWinSide: 'away' | 'home' | 'over' | 'under' | 'push';
      estimatedPayoutUSDC: number;
      estimatedPayoutWei6: string;
    })
  | (OwnerPositionBase & {
      status: 'claimable';
      result: 'won' | 'push' | 'void';
      estimatedPayoutUSDC: number;
      estimatedPayoutWei6: string;
    })
  | (OwnerPositionBase & {
      status: 'claimed';
      /** ISO-8601 string. Null when the indexer didn't capture a claim
       *  timestamp (legacy data — newer rows always carry it). */
      claimedAt: string | null;
    });

/**
 * One PAGE of the owner-authenticated state snapshot. Wire body for
 * `GET /v1/own-state/snapshot?cursor=` and the inline `snapshot` event
 * emitted on cold-connect of the M4b composite SSE stream (PR3c).
 *
 * **`client.ownState.snapshot({address, cursor?})` returns ONE page.**
 * To consume the full commitment set, the caller MUST loop while
 * `truncated === true`, passing the returned `cursor` back on each call:
 *
 *   let cursor: string | undefined;
 *   const all: OwnerCommitment[] = [];
 *   for (;;) {
 *     const page = await client.ownState.snapshot({ address, cursor });
 *     all.push(...page.commitments);
 *     if (!page.truncated) break;
 *     cursor = page.cursor;
 *   }
 *
 * This matters for nonce-floor / cancel-all derivation: computing
 * `max(nonce) + 1` from only the FIRST page can leave higher-nonce hidden
 * commitments live. Drain to `truncated:false` first.
 *
 * Pagination contract (spec §6.2):
 *
 *   - `truncated:true`  — commitments saturated the per-page bound; pass
 *                         `cursor` back to drain. The SDK reducer dedupes
 *                         per commitmentHash; ordering across pages is by
 *                         (row_updated_at, id).
 *   - `positionsTruncated:true` — actionable population hit the 200-row
 *                         cap. No paging exists for this within the
 *                         snapshot endpoint; use `client.positions.*` for
 *                         operator-side full history. The PR3c stream
 *                         emits `event: degraded` for this case and the
 *                         MM enters quote-hold.
 *
 * The `cursor` field is OPAQUE — never decoded by callers. It round-trips
 * through both REST paging and the SSE `Last-Event-ID` reconnect.
 */
export interface OwnerStateSnapshot {
  cursor: string;
  commitments: OwnerCommitment[];
  positions: OwnerPosition[];
  truncated: boolean;
  positionsTruncated: boolean;
}

/**
 * Canonical position-status enum for {@link PositionStatusEvent}. Wider
 * than the {@link OwnerPosition} discriminator: includes terminal-lost
 * (`settledLost`) and voided (`void`) states the snapshot intentionally
 * drops (zero-payout rows) but the SSE stream emits as first-class
 * transitions so consumers close local lifecycle cleanly.
 *
 * Forward-rank for the SDK reducer's backwards-transition guard (spec
 * §2.5.1):
 *
 *   active        → 1
 *   pendingSettle → 2
 *   claimable     → 3
 *   claimed | settledLost | void → 4   (terminal — equally far forward)
 */
export type PositionLifecycle =
  | 'active'
  | 'pendingSettle'
  | 'claimable'
  | 'claimed'
  | 'settledLost'
  | 'void';

/**
 * Position-status event body delivered on `event: positionStatus` (spec
 * §2.1.3). Each event represents a transition for one `(address,
 * speculationId, positionType)` triple.
 *
 * Dedup key per spec §2.1.2 — `(address, speculationId, positionType,
 * status, sourceUpdatedAt)`. Cursors can re-emit on overlap replay, so
 * consumer reducers MUST dedup by this semantic key, not by SSE cursor.
 *
 * `status` (== `to`) is CANONICAL — reducers act on it. `from` is
 * advisory only — the server may not know the client's local prior; use
 * a locally-tracked prior status if the reducer needs precise
 * from-to telemetry.
 */
export interface PositionStatusEvent {
  /** Wallet that owns the position. Lower-case hex. */
  address: string;
  speculationId: string;
  positionType: 0 | 1;
  /** Canonical lifecycle state at the transition. */
  status: PositionLifecycle;
  /**
   * Server's advisory prior state. Omitted when the server has no
   * authoritative prior (e.g. fresh visibility on stream connect).
   * Reducers should rely on locally-tracked state, not this field.
   */
  from?: PositionLifecycle;
  /**
   * Categorical result, set on `pendingSettle` / `claimable` / `settledLost`
   * / `void`. Omitted on `active`.
   */
  result?: 'won' | 'lost' | 'push' | 'void';
  /**
   * Wei6 claimable amount when the position has a non-zero payout
   * (`pendingSettle` won/push, `claimable`, `void`). Absent on `active`,
   * `claimed`, and zero-payout terminal states.
   */
  claimableAmount?: string;
  /**
   * `max(positions.row_updated_at, speculations.row_updated_at,
   * contests.row_updated_at)` — microsecond-precise ISO timestamp.
   * Half of the dedup key.
   */
  sourceUpdatedAt: string;
}

/**
 * Server-emitted resync reason on `event: resync`. The SDK surfaces
 * resync via `onStatus('resync')`; consumers don't typically branch
 * on the reason — it's informational for observability.
 */
export type OwnerStateResyncReason =
  | 'handoff_raced'
  | 'snapshot_failed'
  | 'catchup_failed'
  | 'backlog_too_large'
  | 'server_shutdown'
  | 'internal_error'
  | string;

/**
 * Server-emitted degraded reason on `event: degraded`. Currently the only
 * locked reason is `positionsTruncated`; future degradations (queue
 * overflow, transport stale) may extend it.
 */
export type OwnerStateDegradedReason = 'positionsTruncated' | string;

/**
 * Transport-level status delivered by `client.ownState.subscribe`'s
 * `onStatus` handler. Distinct from `PositionLifecycle` (the per-position
 * domain state); this is the connection's health.
 *
 *   connected    — stream is open and `ready` has fired; live deltas flowing.
 *   reconnecting — transient drop; SDK is backing off + retrying.
 *   degraded     — server signaled partial visibility (e.g. positionsTruncated)
 *                  OR the SDK has crossed its persistent-failure threshold
 *                  (3 consecutive failed reconnect attempts); transport keeps
 *                  retrying but consumers should enter quote-hold per spec §2.6
 *                  until the next `connected`.
 *   resync       — server told the SDK to drop its cursor and re-snapshot;
 *                  next connection is a cold-start.
 */
export type OwnerStateSubscribeStatus =
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'resync';

/**
 * Handler set for `client.ownState.subscribe`. Each handler is optional —
 * consumers wire only what they care about. The SDK NEVER calls a handler
 * after `unsubscribe()` has been invoked (per
 * [[feedback_async_lifecycle_invariant]] — every re-entry point re-checks
 * the closed flag before dispatch).
 */
export interface OwnerStateSubscribeHandlers {
  /**
   * Fires for every snapshot page delivered. The first page comes inline
   * from the SSE cold-connect; if `truncated:true`, subsequent pages come
   * from REST `/v1/own-state/snapshot?cursor=` and fire here too. Each
   * call's `truncated` flag tells you whether more pages are coming.
   * After the final untruncated page, `onReady` fires.
   */
  onSnapshot?: (snapshot: OwnerStateSnapshot) => void;
  /**
   * Fires AFTER the final untruncated snapshot page (cold-start) OR after
   * server catchup completes (resume reconnect). The signal "safe to
   * resume trading"; before this fires, callers should hold quoting per
   * spec §2.6.
   */
  onReady?: () => void;
  /**
   * Per-commitment lifecycle delta (insert / status change / fill /
   * cancel) for any commitment in the maker's book. Full owner-auth
   * payload regardless of `book_visible`.
   */
  onCommitment?: (commitment: OwnerCommitment) => void;
  /**
   * Per-fill append-only event, both maker-side and taker-side
   * (counterparty's wallet may be the maker's address). Dedup key per
   * spec §2.1.2 is `(txHash, logIndex)`.
   */
  onFill?: (fill: Fill) => void;
  /**
   * Per-position transition event. Wider enum than the snapshot's
   * `OwnerPosition.status` — includes terminal-lost (`settledLost`) and
   * voided (`void`) states so consumers close local lifecycle cleanly.
   * Dedup key per spec §2.1.2 is `(address, speculationId, positionType,
   * status, sourceUpdatedAt)`.
   */
  onPositionStatus?: (event: PositionStatusEvent) => void;
  /** Transport status changes — see {@link OwnerStateSubscribeStatus}. */
  onStatus?: (status: OwnerStateSubscribeStatus) => void;
  /**
   * Non-fatal transport errors. The SDK does NOT throw on a transient
   * drop — it surfaces the error here and continues reconnect/backoff
   * unless the failure is fatal (terminal `OspexStreamError` with
   * `reason: 'fatal'` — e.g. 400 INVALID_CURSOR on a server-changed
   * cursor format).
   */
  onError?: (error: import('../errors.js').OspexStreamError) => void;
}

/** Options for `client.ownState.subscribe`. */
export interface OwnStateSubscribeOptions {
  /**
   * Wallet address the subscription is scoped to. Server-side
   * verification asserts the bearer token's claims match; the signer
   * configured on `OspexClient` MUST own this address (otherwise
   * `mintStreamToken` recovers a different signer and the token mint
   * fails with `AUTH_SIGNATURE_INVALID`).
   */
  address: Hex;
}
