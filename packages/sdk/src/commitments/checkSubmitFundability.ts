/**
 * `commitments.checkSubmitFundability({ preview })` — an advisory, read-only
 * preflight answering "can the maker actually back what they're about to sign?"
 * before signing + POSTing a new commitment. The maker-side mirror of
 * `checkCommitmentFillability` (the taker-side fill preflight).
 *
 * Why it exists: a maker can sign + POST a perfectly valid commitment they
 * cannot fund — `PositionModule.recordFill` pulls the maker's risk from their
 * wallet at MATCH time, not at submit. Worse, a maker who already has open
 * commitments can quietly OVER-commit: the submit flow's approve loop only ever
 * raises the maker's PositionModule allowance to cover the NEW commitment in
 * isolation (and never reads the maker's USDC balance at all), so a wallet that
 * can't back the maker's whole open book still posts more "liquidity" that will
 * revert at fill time. This check closes that gap.
 *
 * THE AGGREGATE MODEL — VISIBLE BOOK ONLY. The maker is on the hook for every
 * one of their still-matchable commitments — each fill independently pulls its
 * own remaining maker risk from the same wallet via the same PositionModule
 * allowance — so the requirement is the SUM, not the new commitment alone:
 *   - balance requirement            = existing open risk + new risk + lazy fees
 *   - PositionModule allowance req    = existing open risk + new risk
 *   - TreasuryModule allowance req    = lazy creation fees
 * where `existing open risk` = Σ remaining maker risk over the maker's
 * API-VISIBLE open + partially-filled commitments. Comparing the new commitment
 * in isolation would UNDER-state what the wallet must hold — but note the
 * visible-book sum ITSELF under-states true exposure whenever the maker holds
 * book-hidden (`book_visible=false`) but still-on-chain-matchable rows (see the
 * Scope note): the public list filters those out, so this verdict is
 * `scope: 'visible-book-only'`, never a whole-book guarantee.
 *
 * LAZY CREATION FEES. The first match of a not-yet-created `(contestId, scorer,
 * lineTicks)` speculation key pulls the maker's half of the creation fee from
 * the maker (→ TreasuryModule). The NEW commitment's fee is known exactly (the
 * preview's `submitAction` / Treasury approval row). But the maker's EXISTING
 * never-matched (`stored 'open'`) commitments MIGHT each owe one too — their
 * speculation may or may not be created yet, and the list endpoint doesn't say
 * which. Rather than do a per-speculation lookup per row (which wouldn't scale),
 * this treats the maximum possible existing lazy fee — one maker share per
 * distinct not-yet-disambiguated `open` speculation key — as an UPPER bound:
 *   - funding covers the upper bound          → `fundable` (even worst-case fees fit)
 *   - a definite shortfall vs the lower bound → `not-fundable`
 *   - funding straddles the band              → `unknown` (`EXISTING_LAZY_FEE_UNDETERMINED`)
 * — never a false `fundable`. (`partially_filled` rows are excluded: they've
 * matched, so their speculation definitely exists and owes no creation fee. The
 * new commitment's own key is excluded — its fee is already in the lower bound.)
 *
 * Scope note — VISIBLE BOOK ONLY, not hidden or locally-tracked latent.
 * "Existing open risk" is the maker's open + partially-filled book AS THE PUBLIC
 * API RETURNS IT, which filters `book_visible=true`. It does NOT include the
 * maker's book-hidden rows (`book_visible=false` but still on-chain-matchable
 * until expiry / nonce-floor / on-chain cancel — e.g. rows left live by the
 * default off-chain `commitments cancel`), and it does NOT model latent payloads
 * a market-maker tracks in local state. Those rows do not appear in the sum and
 * do NOT degrade the verdict to `unknown` — they are simply outside scope, which
 * the result states via `scope: 'visible-book-only'`. A maker who needs hidden
 * exposure counted reads it from the owner-auth own-state surface
 * (`client.ownState.snapshot`); the MM's per-tick funding guard owns the
 * latent-payload case (see ospex-market-maker DESIGN §6). For a maker submitting
 * via the SDK/CLI whose whole book is public, the API book is everything they're
 * on the hook for.
 *
 * OPT-IN WHOLE-BOOK MODE (`bookScope: 'whole-book'`). A maker who DOES keep
 * book-hidden rows (e.g. a market-maker that off-chain-cancels as its routine
 * quote-pull) can ask for a true whole-book verdict. In this mode the existing
 * book is sourced from the owner-authenticated own-state snapshot — the maker's
 * ENTIRE live book (visible + hidden, unredacted) from ONE consistent snapshot,
 * not the public list plus a hidden add-on (one source ⇒ no timing skew, no
 * double-count, no privacy leak). It requires a signer whose address matches
 * `preview.raw.maker` (it mints one EIP-712 stream-auth token for the read; it
 * still signs no transaction and allocates no nonce). On full success the result
 * is `scope: 'whole-book'`. If the signer is missing/mismatched or the own-state
 * read can't fully drain, the verdict NEVER falsely reports `fundable`: a definite
 * visible/new-commitment shortfall still returns `not-fundable`, otherwise it
 * degrades to `unknown` (`HIDDEN_EXPOSURE_UNKNOWN`) with `scope:
 * 'visible-book-only'`. The default (no `bookScope`, or `'visible-book-only'`)
 * stays signer-free and visible-book-only. The `coverage` field always reports
 * exactly what was included (visible / hidden / source) so an agent can tell
 * "hidden excluded by default" from "hidden attempted but unavailable."
 *
 * It is ADVISORY: "fundable now, based on the latest reads" — never a guarantee.
 * Mirrors the `ensure*` family: a discriminated `outcome`, fields present only
 * when meaningful, and never a fabricated value — `not-fundable` and `unknown`
 * are outcomes, NOT thrown errors.
 *
 * Read-only: pass a `preview` already built by `prepareSubmit`. This signs
 * nothing and allocates no nonce — the intended flow is `prepareSubmit` →
 * `checkSubmitFundability` → (if fundable / forced) `submitPrepared`, all on the
 * one preview. Requires an `rpcUrl` — throws `OspexConfigError` otherwise.
 */

import type { PublicClient } from 'viem';
import { readAllowance } from './allowance.js';
import { erc20Abi } from '../contracts/abi/erc20.js';
import { SPECULATION_CREATION_FEE_MAKER_SHARE_WEI6 } from '../contracts/constants.js';
import { CommitmentsApi } from '../api/commitments.js';
import { OwnStateApi } from '../api/ownState.js';
import { mintStreamToken } from '../ownState/auth.js';
import { decodeSnapshot } from '../ownState/snapshot.js';
import type { CommitmentsContext } from './context.js';
import type { SubmitPreview } from '../types/preview.js';
import type { Hex, Signer } from '../types/signer.js';

/** One page of the maker's open-book scan — the Supabase row cap (`list` paginates above it). */
const EXISTING_RISK_PAGE = 1000;

/**
 * Defensive page cap for the whole-book own-state drain. Matches the same bound
 * used by the other own-state drainers (`ownState/getCommitment.ts`,
 * `ownState/subscribe.ts`); the server serves up to 5000 commitments/page, so 50
 * pages is far beyond any real single-maker book. If the snapshot is STILL
 * truncated after this many pages, the whole-book fetch returns `null` (→ verdict
 * degrades to `unknown`) rather than a partial, under-counted sum.
 */
const MAX_SNAPSHOT_PAGES = 50;

export interface CheckSubmitFundabilityArgs {
  /**
   * A submit preview from `commitments.prepareSubmit(args)`. The check reads it
   * for the maker, the new commitment's risk + speculation key, and the
   * lazy-creation-fee debit — it signs nothing and allocates no nonce, so the
   * same preview flows on to `submitPrepared` unchanged.
   */
  preview: SubmitPreview;
  /**
   * Which slice of the maker's existing book to aggregate. Default
   * `'visible-book-only'`: sums the public (book_visible=true) list, signer-free
   * — book-hidden rows are out of scope (see the file header). `'whole-book'`
   * opts into the owner-authenticated own-state path that ALSO counts the maker's
   * book-hidden but still-on-chain-matchable rows; it requires a signer matching
   * `preview.raw.maker` (mints one EIP-712 stream-auth token, signs no tx). The
   * RESULT's `scope` reports what was actually achieved — it stays
   * `'visible-book-only'` if the own-state read was unavailable (then the verdict
   * degrades to `unknown` rather than a possibly-optimistic `fundable`).
   */
  bookScope?: SubmitFundabilityScope;
}

export type SubmitFundabilityOutcome =
  /** Maker can back their whole open book plus this new commitment — including the worst-case existing lazy fees — at `checkedAtBlock`. */
  | 'fundable'
  /** A definite funding shortfall was found from a successful read. */
  | 'not-fundable'
  /** A required read failed, OR funding straddles the undeterminable existing-lazy-fee band — the verdict can't be asserted either way. */
  | 'unknown';

/**
 * The book the verdict was actually computed over.
 *
 * - `'visible-book-only'` — the aggregate summed only the maker's API-visible
 *   open book (public list, `book_visible=true`). Book-hidden but
 *   still-on-chain-matchable rows are NOT included (read hidden exposure from the
 *   owner-auth own-state surface). This is the default, and also the fallback
 *   scope when `bookScope: 'whole-book'` was requested but the own-state read was
 *   unavailable — distinguish the two via `coverage.hidden`
 *   (`'excluded'` vs `'unknown'`).
 * - `'whole-book'` — the aggregate summed the maker's ENTIRE live book (visible +
 *   hidden, unredacted) from a fully-drained owner-auth own-state snapshot. Only
 *   reported on a complete, successful own-state read in `bookScope: 'whole-book'`
 *   mode.
 *
 * Used both as the `bookScope` REQUEST on the args and the ACHIEVED scope on the
 * result; they can differ (request whole-book, achieve visible-book-only on
 * own-state failure) — `coverage` records the gap.
 */
export type SubmitFundabilityScope = 'visible-book-only' | 'whole-book';

export type SubmitFundabilityReasonCode =
  | 'MAKER_USDC_BALANCE_INSUFFICIENT'
  | 'MAKER_POSITION_ALLOWANCE_INSUFFICIENT'
  | 'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT'
  /** Funding covers the definite requirement but might not cover the maximum
   * possible creation fees of the maker's existing never-matched commitments
   * (whose speculations may or may not be created yet) — can't tell without a
   * per-speculation lookup, so the verdict is `unknown` rather than a risky `fundable`. */
  | 'EXISTING_LAZY_FEE_UNDETERMINED'
  /** `bookScope: 'whole-book'` was requested but the maker's hidden exposure
   * could not be sourced from own-state (no signer / signer ≠ maker / token mint
   * or snapshot read failed / the snapshot could not be fully drained). The
   * verdict degrades to `unknown` rather than report a `fundable` that omits
   * hidden exposure — never a false `fundable`. (`coverage.hidden` is `'unknown'`
   * here.) */
  | 'HIDDEN_EXPOSURE_UNKNOWN'
  /** A chain read or the open-book list failed — advisory, never a false not-fundable. */
  | 'FUNDABILITY_UNKNOWN';

export interface SubmitFundabilityReason {
  code: SubmitFundabilityReasonCode;
  /** The ERC-20 token (USDC) the requirement is denominated in. Funding reasons only. */
  token?: Hex;
  /** The spender the allowance requirement targets (PositionModule / TreasuryModule). Allowance reasons only. */
  spender?: Hex;
  /** Aggregate required amount (wei6) — the whole-visible-book sum, not the new commitment alone (hidden rows are out of scope; see `scope`). (For `EXISTING_LAZY_FEE_UNDETERMINED`, the maximum undeterminable existing lazy fee.) */
  requiredWei6?: bigint;
  /** Current on-chain amount (wei6) that was read. Funding shortfall reasons only. */
  actualWei6?: bigint;
}

export interface SubmitFundabilityRequirement {
  /** This submit's maker risk (PositionModule pull at match). */
  newCommitmentRiskWei6: bigint;
  /** Σ remaining maker risk (`riskAmount − filled`) over the maker's API-visible open + partially-filled commitments. */
  existingOpenRiskWei6: bigint;
  /** Count of those existing open / partially-filled commitments. */
  existingOpenCommitmentCount: number;
  /** Maker's share of THIS submit's lazy creation fee (→ TreasuryModule); `0n` when this submit isn't lazy. */
  lazyCreationFeeWei6: bigint;
  /** True iff this submit would lazily create the speculation on first match. */
  lazyCreation: boolean;
  /** Distinct not-yet-disambiguated `open` speculation keys among the maker's existing commitments — each MIGHT owe one creation-fee share at match. */
  existingMaybeLazyKeyCount: number;
  /** Maximum additional creation fee those existing keys could owe (`makerShare × existingMaybeLazyKeyCount`). The upper-bound slack between `fundable` and `unknown`. */
  existingLazyFeeMaxWei6: bigint;
  /** Aggregate USDC the maker's wallet must hold (lower bound): existing + new + this submit's lazy fee. The upper bound adds `existingLazyFeeMaxWei6`. */
  balanceRequiredWei6: bigint;
  /** Aggregate maker→PositionModule allowance needed (exact — fees don't touch PositionModule): existing + new. */
  positionAllowanceRequiredWei6: bigint;
  /** Aggregate maker→TreasuryModule allowance needed (lower bound): this submit's lazy fee. The upper bound adds `existingLazyFeeMaxWei6`. */
  treasuryAllowanceRequiredWei6: bigint;
  /** Visible (book_visible=true) portion of `existingOpenRiskWei6`. Present only on a `whole-book` (`scope: 'whole-book'`) verdict, where visible + hidden are summed separately from one own-state snapshot. */
  existingVisibleOpenRiskWei6?: bigint;
  /** Count of the visible open / partially-filled commitments. Present only on a `whole-book` verdict. */
  existingVisibleOpenCommitmentCount?: number;
  /** Book-hidden (book_visible=false) but still-on-chain-matchable portion of `existingOpenRiskWei6` — the exposure the default visible-book-only check cannot see. Present only on a `whole-book` verdict. */
  existingHiddenOpenRiskWei6?: bigint;
  /** Count of the hidden open / partially-filled commitments. Present only on a `whole-book` verdict. */
  existingHiddenOpenCommitmentCount?: number;
}

/**
 * What the verdict's aggregate actually covered. Always present, so an agent can
 * tell "hidden excluded by default" (`hidden: 'excluded'`) from "hidden attempted
 * but unavailable" (`hidden: 'unknown'`, the own-state read failed) from "hidden
 * fully included" (`hidden: 'included'`) — never relying on the `scope` string alone.
 */
export interface SubmitFundabilityCoverage {
  /** `'included'` when the visible book was read successfully; `'unknown'` when that read failed. */
  visible: 'included' | 'unknown';
  /**
   * `'excluded'` — default visible-book-only mode; hidden rows were never
   * attempted. `'included'` — `whole-book` mode drained own-state and summed the
   * maker's hidden rows. `'unknown'` — `whole-book` was requested but the
   * own-state read was unavailable, so hidden exposure could not be counted.
   */
  hidden: 'excluded' | 'included' | 'unknown';
  /** Where the existing-book aggregate was sourced: the anonymous public list, the owner-auth own-state snapshot, or a mix (own-state attempted, visible fell back to the public list). */
  source: 'public-commitments' | 'own-state' | 'mixed';
}

export interface CheckSubmitFundabilityResult {
  /** The maker the verdict is for (`preview.raw.maker`, lowercased). */
  maker: Hex;
  /** Convenience flag — `outcome === 'fundable'`. */
  fundableNow: boolean;
  outcome: SubmitFundabilityOutcome;
  /**
   * The book scope the verdict was actually computed over — `'visible-book-only'`
   * (default, or a `whole-book` request that fell back on own-state failure) or
   * `'whole-book'` (own-state fully drained). See `coverage` for the precise
   * visible/hidden breakdown behind this label.
   */
  scope: SubmitFundabilityScope;
  /**
   * Exactly what the aggregate covered (visible / hidden / source) — always
   * present. Lets an agent distinguish "hidden excluded by default" from "hidden
   * attempted but unavailable" without inferring from `scope` alone.
   */
  coverage: SubmitFundabilityCoverage;
  /** Always true — a point-in-time advisory, never a guarantee. */
  advisory: true;
  /** Block at which balances/allowances were read. Absent only when the block read failed. */
  checkedAtBlock?: bigint;
  /**
   * The whole-visible-book requirement the verdict was computed against (hidden
   * rows are out of scope; see `scope`). Present once the maker's existing open
   * book was fetched — absent when that fetch failed (→ `unknown`), since the
   * aggregate can't be computed without it.
   */
  requirement?: SubmitFundabilityRequirement;
  reasons: SubmitFundabilityReason[];
}

export async function checkSubmitFundability(
  ctx: CommitmentsContext,
  args: CheckSubmitFundabilityArgs,
): Promise<CheckSubmitFundabilityResult> {
  // Fundability is fundamentally a chain-read feature — surface a missing-rpcUrl
  // config error immediately (consistent with the `ensure*` primitives + A1).
  const publicClient = ctx.requireChainClient();
  const addresses = ctx.getAddresses();
  const usdc = (addresses.usdc as string).toLowerCase() as Hex;
  const positionModule = (addresses.positionModule as string).toLowerCase() as Hex;
  const treasuryModule = (addresses.treasuryModule as string).toLowerCase() as Hex;

  const { preview } = args;
  const maker = preview.raw.maker.toLowerCase() as Hex;
  const newKey = preview.raw.speculationKey.toLowerCase();
  const wantWholeBook = (args.bookScope ?? 'visible-book-only') === 'whole-book';

  // The new commitment's maker risk comes off the preview's PositionModule
  // 'commitment-risk' approval row; its lazy creation fee (if any) is the
  // per-chain maker share — `submitAction` flags whether this submit is lazy.
  const positionRow = preview.approvals.find((a) => a.purpose === 'commitment-risk');
  const newCommitmentRiskWei6 = positionRow
    ? BigInt(positionRow.required)
    : BigInt(preview.economics.riskWei6);
  const makerCreationFeeShareWei6 = SPECULATION_CREATION_FEE_MAKER_SHARE_WEI6[ctx.getChainId()] ?? 0n;
  const lazyCreation = preview.submitAction === 'trade-and-create-speculation';
  const newLazyFeeWei6 = lazyCreation ? makerCreationFeeShareWei6 : 0n;

  // All reads in parallel. The existing-book source depends on bookScope:
  // whole-book drains the owner-auth own-state snapshot (visible + hidden);
  // the default reads the public visible-book list. Treasury allowance is read
  // whenever the chain has a creation fee — it bounds BOTH this submit's lazy fee
  // AND the existing maybe-lazy fees. Every read degrades to null on failure so a
  // flaky read never produces a false `fundable`.
  const [primaryExisting, balance, positionAllowance, treasuryAllowance, block] = await Promise.all([
    wantWholeBook
      ? tryFetchWholeBookFromOwnState(ctx, maker, newKey)
      : tryFetchExistingOpenRisk(ctx, maker, newKey),
    tryReadUsdcBalance(publicClient, usdc, maker),
    tryReadAllowance(publicClient, usdc, maker, positionModule),
    makerCreationFeeShareWei6 > 0n
      ? tryReadAllowance(publicClient, usdc, maker, treasuryModule)
      : Promise.resolve(0n),
    tryReadBlockNumber(publicClient),
  ]);
  const checkedAtBlock = block ?? undefined;

  // Resolve the existing-book result, the ACHIEVED scope, and coverage. On a
  // whole-book request the own-state read is the single source (one consistent
  // snapshot of visible + hidden — no list/own-state skew or double-count). If it
  // is unavailable we fall back to the public visible list ONLY to still catch a
  // definite shortfall; the verdict then degrades to `unknown` (never a `fundable`
  // that silently omits hidden exposure).
  let existing = primaryExisting;
  let scope: SubmitFundabilityScope = 'visible-book-only';
  let coverage: SubmitFundabilityCoverage;
  let hiddenUnavailable = false;
  if (!wantWholeBook) {
    coverage = {
      visible: existing === null ? 'unknown' : 'included',
      hidden: 'excluded',
      source: 'public-commitments',
    };
  } else if (existing !== null) {
    scope = 'whole-book';
    coverage = { visible: 'included', hidden: 'included', source: 'own-state' };
  } else {
    existing = await tryFetchExistingOpenRisk(ctx, maker, newKey);
    hiddenUnavailable = true;
    coverage = {
      visible: existing === null ? 'unknown' : 'included',
      hidden: 'unknown',
      source: 'mixed',
    };
  }

  // When the existing-book fetch failed, `existingRiskWei6` is 0 — the
  // requirements below become the new-commitment-only LOWER bound, so a
  // shortfall against them is still a definite not-fundable. We just can't form
  // the full aggregate, so we don't return a `requirement` or assert `fundable`.
  const existingRiskWei6 = existing?.riskWei6 ?? 0n;
  const existingMaybeLazyKeyCount = existing?.maybeLazyKeyCount ?? 0;
  const existingLazyFeeMaxWei6 = makerCreationFeeShareWei6 * BigInt(existingMaybeLazyKeyCount);

  const balanceRequiredWei6 = existingRiskWei6 + newCommitmentRiskWei6 + newLazyFeeWei6;
  const positionAllowanceRequiredWei6 = existingRiskWei6 + newCommitmentRiskWei6;
  const treasuryAllowanceRequiredWei6 = newLazyFeeWei6;

  const reasons: SubmitFundabilityReason[] = [];
  let anyReadFailed = false;
  // Funding clears the definite (lower-bound) requirement but might not clear
  // the upper bound that includes the existing maybe-lazy fees — flips the
  // verdict to `unknown` rather than a risky `fundable`.
  let lazyFeeUncertain = false;

  if (balance === null) {
    anyReadFailed = true;
  } else if (balance < balanceRequiredWei6) {
    reasons.push({
      code: 'MAKER_USDC_BALANCE_INSUFFICIENT',
      token: usdc,
      requiredWei6: balanceRequiredWei6,
      actualWei6: balance,
    });
  } else if (balance < balanceRequiredWei6 + existingLazyFeeMaxWei6) {
    lazyFeeUncertain = true;
  }

  if (positionAllowance === null) {
    anyReadFailed = true;
  } else if (positionAllowance < positionAllowanceRequiredWei6) {
    reasons.push({
      code: 'MAKER_POSITION_ALLOWANCE_INSUFFICIENT',
      token: usdc,
      spender: positionModule,
      requiredWei6: positionAllowanceRequiredWei6,
      actualWei6: positionAllowance,
    });
  }

  // TreasuryModule allowance only matters on a fee chain.
  if (makerCreationFeeShareWei6 > 0n) {
    if (treasuryAllowance === null) {
      anyReadFailed = true;
    } else if (treasuryAllowance < treasuryAllowanceRequiredWei6) {
      reasons.push({
        code: 'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT',
        token: usdc,
        spender: treasuryModule,
        requiredWei6: treasuryAllowanceRequiredWei6,
        actualWei6: treasuryAllowance,
      });
    } else if (treasuryAllowance < treasuryAllowanceRequiredWei6 + existingLazyFeeMaxWei6) {
      lazyFeeUncertain = true;
    }
  }

  // The requirement is a true aggregate only when the existing book was fetched;
  // on a list failure it'd be a misleading lower bound, so omit it.
  const requirement: SubmitFundabilityRequirement | undefined =
    existing === null
      ? undefined
      : {
          newCommitmentRiskWei6,
          existingOpenRiskWei6: existingRiskWei6,
          existingOpenCommitmentCount: existing.count,
          lazyCreationFeeWei6: newLazyFeeWei6,
          lazyCreation,
          existingMaybeLazyKeyCount,
          existingLazyFeeMaxWei6,
          balanceRequiredWei6,
          positionAllowanceRequiredWei6,
          treasuryAllowanceRequiredWei6,
          // Visible/hidden breakdown is only meaningful on a whole-book verdict,
          // where own-state summed the two slices separately.
          ...(existing.breakdown !== undefined
            ? {
                existingVisibleOpenRiskWei6: existing.breakdown.visibleRiskWei6,
                existingVisibleOpenCommitmentCount: existing.breakdown.visibleCount,
                existingHiddenOpenRiskWei6: existing.breakdown.hiddenRiskWei6,
                existingHiddenOpenCommitmentCount: existing.breakdown.hiddenCount,
              }
            : {}),
        };

  // A definite shortfall from a successful read is proof the book can't be
  // backed — even on a list failure (the new-commitment lower bound), an
  // unavailable own-state read, or when another read failed.
  if (reasons.length > 0) {
    return result({ maker, outcome: 'not-fundable', reasons, requirement, scope, coverage, checkedAtBlock });
  }
  // `whole-book` was requested but the maker's hidden exposure couldn't be sourced
  // (no/mismatched signer, or the own-state read couldn't fully drain). No definite
  // shortfall was found, but a `fundable` here would silently omit hidden exposure —
  // degrade to `unknown` instead. `coverage.hidden` is `'unknown'`.
  if (hiddenUnavailable) {
    return result({
      maker,
      outcome: 'unknown',
      reasons: [{ code: 'HIDDEN_EXPOSURE_UNKNOWN' }],
      requirement,
      scope,
      coverage,
      checkedAtBlock,
    });
  }
  // No definite shortfall. Without the existing book we can't form the aggregate
  // (it could be arbitrarily large) → unknown.
  if (existing === null) {
    return result({
      maker,
      outcome: 'unknown',
      reasons: [{ code: 'FUNDABILITY_UNKNOWN' }],
      scope,
      coverage,
      checkedAtBlock,
    });
  }
  if (anyReadFailed) {
    return result({
      maker,
      outcome: 'unknown',
      reasons: [{ code: 'FUNDABILITY_UNKNOWN' }],
      requirement,
      scope,
      coverage,
      checkedAtBlock,
    });
  }
  if (lazyFeeUncertain) {
    return result({
      maker,
      outcome: 'unknown',
      reasons: [{ code: 'EXISTING_LAZY_FEE_UNDETERMINED', token: usdc, requiredWei6: existingLazyFeeMaxWei6 }],
      requirement,
      scope,
      coverage,
      checkedAtBlock,
    });
  }
  return result({ maker, outcome: 'fundable', reasons: [], requirement, scope, coverage, checkedAtBlock });
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * The maker's existing open-book aggregate, however sourced. `riskWei6` is Σ
 * remaining maker risk; `maybeLazyKeyCount` is the number of distinct
 * not-yet-disambiguated `open` speculation keys (each MIGHT owe a creation-fee
 * share). `breakdown` is present ONLY when sourced from own-state (whole-book
 * mode), splitting the aggregate into its visible and hidden halves.
 */
interface ExistingBook {
  riskWei6: bigint;
  count: number;
  maybeLazyKeyCount: number;
  breakdown?: {
    visibleRiskWei6: bigint;
    visibleCount: number;
    hiddenRiskWei6: bigint;
    hiddenCount: number;
  };
}

function result(args: {
  maker: Hex;
  outcome: SubmitFundabilityOutcome;
  reasons: SubmitFundabilityReason[];
  scope: SubmitFundabilityScope;
  coverage: SubmitFundabilityCoverage;
  // `| undefined` (not just `?`) so callers can pass the maybe-undefined `requirement`
  // directly under `exactOptionalPropertyTypes`; the body assigns it only when present.
  requirement?: SubmitFundabilityRequirement | undefined;
  checkedAtBlock?: bigint | undefined;
}): CheckSubmitFundabilityResult {
  const out: CheckSubmitFundabilityResult = {
    maker: args.maker,
    fundableNow: args.outcome === 'fundable',
    outcome: args.outcome,
    scope: args.scope,
    coverage: args.coverage,
    advisory: true,
    reasons: args.reasons,
  };
  if (args.checkedAtBlock !== undefined) out.checkedAtBlock = args.checkedAtBlock;
  if (args.requirement !== undefined) out.requirement = args.requirement;
  return out;
}

/**
 * Σ remaining maker risk over the maker's API-visible open + partially-filled
 * commitments (the book they're already on the hook for), their count, and the
 * number of distinct not-yet-disambiguated `open` speculation keys (each of
 * which MIGHT owe a maker creation-fee share — see the file header). Excludes
 * the new commitment's own key (`newKey`): its fee is already in the lower bound
 * (lazy) or its speculation is created (existing mode), so existing commitments
 * on it owe nothing extra. Paginates so a maker with a full page of open
 * commitments isn't under-counted within the visible book. Book-hidden rows are
 * filtered out by the public list and any stray redacted row is skipped, so this
 * sum is visible-book-only (see the file header). Returns `null` on ANY list
 * failure — the aggregate can't be computed without it, so the caller degrades
 * to `unknown`.
 */
async function tryFetchExistingOpenRisk(
  ctx: CommitmentsContext,
  maker: Hex,
  newKey: string,
): Promise<ExistingBook | null> {
  const api = new CommitmentsApi(ctx.api);
  let riskWei6 = 0n;
  let count = 0;
  const maybeLazyKeys = new Set<string>();
  let offset = 0;
  try {
    for (;;) {
      const rows = await api.list({
        maker,
        status: ['open', 'partially_filled'],
        limit: EXISTING_RISK_PAGE,
        offset,
      });
      for (const r of rows) {
        // VISIBLE-BOOK-ONLY scope. The public commitments list filters
        // `book_visible=true` server-side, so a maker's book-hidden
        // (`book_visible=false`) but still-on-chain-matchable rows — e.g. left
        // live by the default off-chain `commitments cancel` — never appear in
        // this list at all. They are simply absent from the sum; the verdict is
        // NOT degraded to `unknown` for them (claiming otherwise would promise a
        // protection this anonymous read cannot deliver). A redacted row can
        // only reach this scan via the `?since=` recovery mode (which it does
        // not use) or core-api's defense-in-depth projection — either way it is
        // a hidden row and out of scope, so skip it, consistent with the
        // `scope: 'visible-book-only'` the result carries. The maker accounts for
        // hidden exposure via the owner-auth own-state surface
        // (`client.ownState.snapshot({ address, cursor? })`, draining while
        // `truncated`), which returns the full unredacted payload for their own
        // hidden rows; a market-maker's per-tick funding guard tracks the same
        // book-hidden latent exposure locally.
        if (r.redacted === true) continue;
        const remaining = BigInt(r.remainingRiskAmount);
        if (remaining > 0n) {
          riskWei6 += remaining;
          count += 1;
        }
        // Only a never-matched (`stored 'open'`) commitment can owe a creation
        // fee — a `partially_filled` one has matched, so its speculation exists.
        // A live open row with no speculationKey can't be disambiguated, so count
        // it as its OWN maybe-lazy key (upper bound) rather than drop it — dropping
        // would under-count the worst-case fee and could yield a false `fundable`.
        // (Mirrors the whole-book own-state path's `nokey:` fail-safe.)
        if (r.storedStatus === 'open') {
          const key =
            r.speculationKey === null
              ? `nokey:${r.commitmentHash.toLowerCase()}`
              : r.speculationKey.toLowerCase();
          if (key !== newKey) maybeLazyKeys.add(key);
        }
      }
      if (rows.length < EXISTING_RISK_PAGE) break;
      offset += EXISTING_RISK_PAGE;
    }
    return { riskWei6, count, maybeLazyKeyCount: maybeLazyKeys.size };
  } catch {
    return null;
  }
}

/**
 * Whole-book existing risk for `bookScope: 'whole-book'`: the maker's ENTIRE live
 * book (visible + hidden, unredacted) summed from the owner-authenticated
 * own-state snapshot — one consistent source, so no public-list/own-state timing
 * skew or double-count. Mirrors `ownState/getCommitment.ts`'s drainer: require a
 * signer, mint ONE stream-auth token (the EIP-712 read challenge — no tx, no
 * nonce), then loop `OwnStateApi.snapshot(token, { cursor })` + `decodeSnapshot`
 * while `truncated`, accumulating over each page's live commitments.
 *
 * Returns `null` (→ caller degrades to `unknown`, never a false `fundable`) on ANY
 * inability to produce a COMPLETE aggregate: no configured signer, signer address
 * ≠ `maker` (we'd be reading the wrong book), token mint / snapshot read / decode
 * failure, or the snapshot still truncated after `MAX_SNAPSHOT_PAGES` (a partial
 * sum would under-count). Liveness uses the decode-stamped `OwnerCommitment.isLive`
 * (the shared owner liveness predicate); rows are de-duplicated by commitment hash
 * across pages. The new commitment's own speculation key is excluded from the
 * maybe-lazy set (its fee is already in the lower bound); a live `open` row with a
 * null `speculationKey` can't be disambiguated, so it is counted as its OWN
 * maybe-lazy key (upper bound) rather than ignored — never an optimistic verdict.
 */
async function tryFetchWholeBookFromOwnState(
  ctx: CommitmentsContext,
  maker: Hex,
  newKey: string,
): Promise<ExistingBook | null> {
  let signer: Signer;
  try {
    signer = ctx.requireSigner();
  } catch {
    // No signer configured — whole-book mode can't authenticate the own-state read.
    return null;
  }
  try {
    const signerAddr = (await signer.getAddress()).toLowerCase();
    if (signerAddr !== maker) return null; // wrong wallet → would read a different book
    const { matchingModule } = ctx.getAddresses();
    const { token } = await mintStreamToken({
      api: ctx.api,
      signer,
      address: maker,
      chainId: ctx.getChainId(),
      matchingModule,
    });
    const ownStateApi = new OwnStateApi(ctx.api);

    let riskWei6 = 0n;
    let count = 0;
    let visibleRiskWei6 = 0n;
    let visibleCount = 0;
    let hiddenRiskWei6 = 0n;
    let hiddenCount = 0;
    const maybeLazyKeys = new Set<string>();
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_SNAPSHOT_PAGES; page += 1) {
      const wire = await ownStateApi.snapshot(token, cursor !== undefined ? { cursor } : {});
      const decoded = decodeSnapshot(wire);
      for (const c of decoded.commitments) {
        const hash = c.commitmentHash.toLowerCase();
        if (seen.has(hash)) continue; // dedupe across pages
        seen.add(hash);
        if (!c.isLive) continue; // open/partially_filled, nonce-valid, remaining>0, future expiry
        const remaining = BigInt(c.remainingRiskAmount);
        if (remaining <= 0n) continue; // belt-and-braces — `isLive` already implies this
        riskWei6 += remaining;
        count += 1;
        if (c.visibility === 'hidden') {
          hiddenRiskWei6 += remaining;
          hiddenCount += 1;
        } else {
          visibleRiskWei6 += remaining;
          visibleCount += 1;
        }
        // Only a never-matched (`stored 'open'`) commitment can owe a creation fee.
        if (c.storedStatus === 'open') {
          const key = c.speculationKey === null ? `nokey:${hash}` : c.speculationKey.toLowerCase();
          if (key !== newKey) maybeLazyKeys.add(key);
        }
      }
      if (!decoded.truncated) {
        return {
          riskWei6,
          count,
          maybeLazyKeyCount: maybeLazyKeys.size,
          breakdown: { visibleRiskWei6, visibleCount, hiddenRiskWei6, hiddenCount },
        };
      }
      cursor = decoded.cursor;
    }
    // Page cap hit while the server still reports more — can't confirm a full
    // drain, so don't return a partial (under-counted) sum.
    return null;
  } catch {
    // Token mint / snapshot fetch / decode failure → unknown, never a false fundable.
    return null;
  }
}

// The three read wrappers below mirror `checkFillability.ts`'s (same null-on-error
// degradation). Kept local so this primitive is self-contained; a shared
// funding-reads module would be a fine future refactor if a third caller appears.

/** USDC `balanceOf`, returning `null` on any read error so a flaky read degrades
 * the verdict to `unknown` rather than a false `not-fundable`. */
async function tryReadUsdcBalance(
  publicClient: PublicClient,
  usdc: Hex,
  account: Hex,
): Promise<bigint | null> {
  try {
    return (await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    })) as bigint;
  } catch {
    return null;
  }
}

/** USDC `allowance(owner, spender)`, `null` on read error (see above). */
async function tryReadAllowance(
  publicClient: PublicClient,
  usdc: Hex,
  owner: Hex,
  spender: Hex,
): Promise<bigint | null> {
  try {
    return await readAllowance(publicClient, usdc, owner, spender);
  } catch {
    return null;
  }
}

/** Current block number, `null` on read error (just drops `checkedAtBlock`). */
async function tryReadBlockNumber(publicClient: PublicClient): Promise<bigint | null> {
  try {
    return await publicClient.getBlockNumber();
  } catch {
    return null;
  }
}
