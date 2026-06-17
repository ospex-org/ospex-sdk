import type { OspexCommitmentMessage } from '../chain/eip712.js';
import type { MarketType } from './odds.js';
import type { Hex } from './signer.js';

/**
 * The canonical signed commitment payload — the three pieces a third party
 * needs to act on a commitment without re-fetching it: the EIP-712 hash
 * the maker signed against, the 9-field commitment struct that hashes
 * back to it, and the maker's signature over that struct.
 *
 * `cancelOnchainSigned(payload)` is the SDK's low-level write primitive
 * built on this shape — it bypasses the API fetch entirely, making it
 * the natural surface for makers and market-makers who hold their own
 * signed payloads in local state (e.g. after off-chain book-hide → they
 * can still authoritatively cancel on chain without round-tripping a
 * redacted public read). `cancelOnchain({ signedCommitment })` is the
 * convenience overload that delegates to it; `cancelOnchain({ hash })`
 * fetches via the public commitments API, and `cancelOnchain({ commitment })`
 * reuses an already-fetched public row — both reconstruct the equivalent
 * payload bound to the requested hash. On a book-hidden row those two
 * branches refuse unless `recoverHidden: true` is passed, which recovers the
 * payload from the owner-auth own-state surface before cancelling.
 *
 * Although `MatchingModule.cancelCommitment` only consumes `commitment`
 * on chain (the contract recomputes the hash from the struct and uses
 * that to set `s_cancelledCommitments`), this type carries `signature`
 * too: it captures the full authenticated unit (same shape the maker
 * originally signed and POSTed) and lets the SDK assert
 * `hashCommitment(commitment) === commitmentHash` before signing the
 * cancel — so a row that drifted from the signed payload (e.g. a
 * truncated expiry) can never cause an unguarded cancel on the wrong
 * `s_cancelledCommitments` slot.
 */
export interface SignedCommitmentPayload {
  commitmentHash: Hex;
  commitment: OspexCommitmentMessage;
  signature: Hex;
}

/**
 * Raw lifecycle status as stored by the indexer / submission relay. These are
 * the only values the `GET /v1/commitments?status=` filter accepts — `'expired'`
 * is never stored (the server returns 400 for it).
 */
export type StoredCommitmentStatus =
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled';

/**
 * Effective lifecycle status: the stored statuses plus the time-driven
 * `'expired'` transition the API derives. This is what `Commitment.status`
 * reports; the raw value is on `Commitment.storedStatus`.
 */
export type CommitmentStatus = StoredCommitmentStatus | 'expired';

/**
 * Advisory maker-funding headline for a commitment (Layer-D orderbook advisory):
 * `fully_backed` / `overcommitted` from a fresh snapshot, `unknown` when the
 * maker has no snapshot, `stale` when the snapshot aged past the API's freshness
 * threshold. Advisory + point-in-time — never authoritative.
 */
export type MakerFundingStatus = 'fully_backed' | 'overcommitted' | 'unknown' | 'stale';

/**
 * Advisory maker-funding fillability for a commitment, surfaced by the core API
 * when a list is fetched with {@link CommitmentsListOptions.includeFillability}.
 * Derived from the indexer's ~30s `maker_funding` snapshot (the maker's USDC
 * balance + PositionModule allowance vs. their visible committed book risk).
 *
 * It answers "is this visible liquidity actually backed right now?" without a
 * per-fill on-chain read. It is **advisory + point-in-time** and is NEVER folded
 * into {@link PublicVisibleCommitment.status}. The `…BackedNow` booleans assert
 * CURRENT backed-ness, so they are `null` when the verdict is `unknown` (no
 * snapshot) or `stale` (too old to assert) — the numeric fields are last-known
 * facts as-of `checkedAtBlock`. A maker can be `orderIndividuallyBackedNow`
 * (covers THIS order) yet not `makerBookBackedNow` (can't cover their whole
 * visible book) — `makerFundingStatus: 'overcommitted'` — which is the "fake
 * liquidity" this flags. For a definitive single-fill check, use
 * `commitments.checkCommitmentFillability`.
 */
export interface CommitmentFillability {
  /** Always true — a point-in-time advisory, never a guarantee. */
  advisory: true;
  makerFundingStatus: MakerFundingStatus;
  /** backing ≥ THIS order's remaining maker risk. `null` when unknown/stale. */
  orderIndividuallyBackedNow: boolean | null;
  /** backing ≥ the maker's whole VISIBLE committed book risk. `null` when unknown/stale. */
  makerBookBackedNow: boolean | null;
  /** min(USDC balance, USDC→PositionModule allowance), wei6 string. `null` when unknown. */
  makerBackingWei6: string | null;
  /** Σ remaining maker risk over the maker's visible matchable book, wei6 string. `null` when unknown. */
  makerVisibleCommittedWei6: string | null;
  /** backing / visibleCommitted, in basis points. `null` when unknown. */
  makerCoverageRatioBps: number | null;
  /** Chain block the balance/allowance were read at, as a string. `null` when unknown. */
  checkedAtBlock: string | null;
  /**
   * True only when a snapshot exists but its age exceeds the API's freshness
   * threshold (paired with `makerFundingStatus: 'stale'`). A *missing* snapshot
   * is reported as `makerFundingStatus: 'unknown'` with `stale: false` — so use
   * `makerFundingStatus` as the primary discriminator, not `stale`.
   */
  stale: boolean;
}

/**
 * A commitment that is publicly visible — the maker has not off-chain-cancelled
 * (`book_visible=true`). The full matchable payload is surfaced: a public
 * anonymous caller has every field `MatchingModule.matchCommitment` needs.
 *
 * Discriminate from {@link PublicHiddenCommitment} via `visibility === 'visible'`
 * or `redacted === false`. Either narrows correctly.
 *
 * All on-chain numeric values that may exceed `Number.MAX_SAFE_INTEGER` are
 * strings (`riskAmount`, `nonce`, etc.) and remain stringified when handed to
 * the caller — it's their choice whether to parse them as BigInt.
 */
export interface PublicVisibleCommitment {
  /** Discriminator — `'visible'` indicates the maker keeps this commitment on the public book. */
  visibility: 'visible';
  /** Discriminator — `false` indicates the matchable payload is present in full. */
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
  /** ISO-8601 string. Null when not present (legacy rows). */
  expiry: string | null;
  speculationKey: string | null;
  signature: string | null;
  /**
   * EFFECTIVE lifecycle status. The core API folds time-expiry and nonce
   * invalidation into this value: an `open`/`partially_filled` row past its
   * expiry reads `'expired'`, and a nonce-invalidated one reads `'cancelled'`.
   * Use {@link PublicVisibleCommitment.storedStatus} for the raw indexed value.
   */
  status: CommitmentStatus;
  /**
   * Raw status as stored by the indexer / submission relay
   * (`open | partially_filled | filled | cancelled`), before effective-status
   * derivation. Falls back to {@link PublicVisibleCommitment.status} when read
   * from an older core-api build that doesn't return it.
   */
  storedStatus: StoredCommitmentStatus;
  source: string;
  network: string;
  nonceInvalidated: boolean;
  /**
   * Derived: the raw on-chain lifecycle ({@link PublicVisibleCommitment.storedStatus})
   * is `'open'` or `'partially_filled'`, the row isn't `nonceInvalidated`,
   * `remainingRiskAmount > 0`, and the expiry is in the future. The canonical
   * "is this commitment still matchable on chain?" predicate — mirrors every
   * precondition `matchCommitment` enforces.
   *
   * Computed at API decode time, so the expiry comparison is a snapshot — a
   * commitment held in memory across its expiry won't silently flip to `false`
   * without re-fetching.
   */
  isLive: boolean;
  /** ISO-8601 string. */
  createdAt: string;
  /**
   * Advisory maker-funding fillability. Present ONLY when the list was fetched
   * with {@link CommitmentsListOptions.includeFillability} (the CLI's
   * `commitments list --with-fillability`). Advisory + point-in-time — see
   * {@link CommitmentFillability}. Absent on single-row / non-opt-in reads.
   */
  fillability?: CommitmentFillability;
}

/**
 * A commitment whose off-chain visibility was revoked by the maker
 * (`book_visible=false`) — typically via an off-chain `DELETE /v1/commitments/:hash`
 * with a signed `CancelCommitment` action. The on-chain signature is still
 * valid until the row reaches a terminal state (expiry, nonce-floor raise, or
 * on-chain `cancelCommitment`); the public REST/SSE surface refuses to leak
 * the signed payload so no anonymous taker can resurrect a fill against an
 * order the maker took off-book.
 *
 * The field set is the locked PUBLIC HIDDEN ALLOW-LIST (own-state SSE plan §2.3).
 * Anything in `MatchingModule.matchCommitment`'s struct — signature, nonce,
 * riskAmount, oddsTick, scorer, lineTicks, the on-chain `speculationKey` — is
 * NEVER present here.
 *
 * A maker recovering their own full payload authenticates via the
 * owner-auth own-state surface (M5/PR3b+):
 *   - `client.ownState.snapshot({ address, cursor? })` returns ONE page.
 *     To enumerate every commitment in snapshot scope (active + recently-
 *     terminal-since-cursor, with full payload regardless of `book_visible`),
 *     callers MUST loop while `snapshot.truncated === true`, passing back
 *     `snapshot.cursor` on each call.
 *   - `client.ownState.getCommitment({ address, hash })` pages internally
 *     for one hash and returns `OwnerCommitment | null`; `null` only means
 *     the snapshot drained without finding it (NOT "doesn't exist"). Page-
 *     cap exhaustion throws `OspexOwnStateError({ reason: 'scan_limit_exceeded' })`.
 * For hashes outside that scope (e.g. a commitment whose only terminal
 * transition is a long-past passive expiry), a dedicated
 * `/v1/own-state/commitments/:hash` endpoint is the right primitive — TBD,
 * not in M5. Third parties cannot recover the payload by any combination
 * of public endpoints regardless.
 *
 * Discriminate from {@link PublicVisibleCommitment} via `visibility === 'hidden'`
 * or `redacted === true`. Either narrows correctly.
 *
 * `isLive` is intentionally absent: re-deriving the public predicate would
 * require fields outside the allow-list (`remainingRiskAmount`, `oddsTick`).
 * Anonymous callers must treat any hidden row as not-matchable from this
 * payload alone.
 */
export interface PublicHiddenCommitment {
  /** Discriminator — `'hidden'` indicates the maker pulled this commitment off the public book. */
  visibility: 'hidden';
  /** Discriminator — `true` indicates the matchable payload is suppressed. */
  redacted: true;
  /** Discriminator — `false` indicates anonymous callers cannot recover the signed payload via this endpoint. */
  payloadAvailable: false;
  commitmentHash: string;
  maker: string;
  contestId: string | null;
  positionType: 0 | 1 | null;
  /**
   * EFFECTIVE lifecycle status, derived server-side. For a hidden row this is
   * usually the terminal projection (`cancelled` / `expired`) but the API may
   * report intermediate stored states when those apply.
   */
  status: CommitmentStatus;
  /** Raw indexer/relay status before effective-status derivation. */
  storedStatus: StoredCommitmentStatus;
  /** Maker-side USDC already filled, wei6 decimal string. */
  filledRiskAmount: string;
  /** ISO-8601 string. Null only on legacy rows that never carried an expiry. */
  expiry: string | null;
  /** Always `false` on a hidden body — the field is redundant with the discriminator but mirrors the wire. */
  bookVisible: false;
  nonceInvalidated: boolean;
}

/**
 * A commitment as observed through any public, anonymous read surface
 * (`GET /v1/commitments[/:hash]`, `GET /v1/stream/commitments`, any embedded
 * orderbook). Discriminate via `visibility` (`'visible' | 'hidden'`) or
 * `redacted` (`false | true`); a third-party caller never sees a hidden row's
 * matchable payload.
 *
 * For the maker's own view of their full book — including hidden but still
 * on-chain-matchable rows — authenticate via `client.ownState.*` (M5/PR3b+)
 * and read `OwnerCommitment` instead. The maker-authenticated body always
 * carries the full payload regardless of `book_visible`.
 */
export type Commitment = PublicVisibleCommitment | PublicHiddenCommitment;

export interface CommitmentsListOptions {
  maker?: string;
  scorer?: string;
  contestId?: string | number;
  /**
   * Filter to commitments matching this speculation. Resolves to a
   * `speculation_key` server-side (single lookup), then `.eq()`-filters
   * commitments — faster than passing `contestId + scorer` and matching
   * on `lineTicks` client-side.
   */
  speculationId?: string | number;
  /**
   * Comma-separated status list (or array) filtering the API's **stored**
   * status column. `'expired'` is NOT accepted here — it is an effective-only
   * status the API never stores (the server returns 400). To surface
   * time-expired rows, pass `includeExpired: true` and read the effective
   * `Commitment.status`. Defaults API-side to `'open,partially_filled'`.
   */
  status?: StoredCommitmentStatus | StoredCommitmentStatus[] | string;
  includeInvalidated?: boolean;
  includeExpired?: boolean;
  /**
   * Opt-in to advisory maker-funding fillability: each returned commitment gets
   * a {@link PublicVisibleCommitment.fillability} object derived from the
   * indexer's ~30s `maker_funding` snapshot. Advisory + point-in-time, never a
   * guarantee, never folded into `status`. Defaults to false (fillability
   * omitted). The flag has no effect on hidden rows (they carry no fillability
   * field at all per the public allow-list).
   */
  includeFillability?: boolean;
  limit?: number;
  offset?: number;
}

/** Predicate narrowing a {@link Commitment} to {@link PublicVisibleCommitment}. */
export function isVisibleCommitment(c: Commitment): c is PublicVisibleCommitment {
  return c.redacted === false;
}

/** Predicate narrowing a {@link Commitment} to {@link PublicHiddenCommitment}. */
export function isHiddenCommitment(c: Commitment): c is PublicHiddenCommitment {
  return c.redacted === true;
}
