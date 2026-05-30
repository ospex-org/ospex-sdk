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
import type { MarketType } from './odds.js';

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
