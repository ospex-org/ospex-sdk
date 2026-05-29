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
 * THE AGGREGATE (whole-book) MODEL. The maker is on the hook for EVERY one of
 * their still-matchable commitments — each fill independently pulls its own
 * remaining maker risk from the same wallet via the same PositionModule
 * allowance. So the requirement is the SUM, not the new commitment alone:
 *   - balance requirement            = existing open risk + new risk + lazy fees
 *   - PositionModule allowance req    = existing open risk + new risk
 *   - TreasuryModule allowance req    = lazy creation fees
 * where `existing open risk` = Σ remaining maker risk over the maker's
 * API-visible open + partially-filled commitments. Comparing the new commitment
 * in isolation would UNDER-state what the wallet must hold — the one error a
 * funding guard must never make.
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
 * Scope note — VISIBLE, not locally-tracked latent. "Existing open risk" is the
 * maker's open + partially-filled book as the API returns it. It does NOT model
 * book-hidden latent payloads a market-maker tracks in local state (off-chain
 * cancelled but still on-chain-matchable); the MM's per-tick funding guard owns
 * that — see ospex-market-maker DESIGN §6. For a maker submitting via the
 * SDK/CLI, the API book is everything they're on the hook for.
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
import type { CommitmentsContext } from './context.js';
import type { SubmitPreview } from '../types/preview.js';
import type { Hex } from '../types/signer.js';

/** One page of the maker's open-book scan — the Supabase row cap (`list` paginates above it). */
const EXISTING_RISK_PAGE = 1000;

export interface CheckSubmitFundabilityArgs {
  /**
   * A submit preview from `commitments.prepareSubmit(args)`. The check reads it
   * for the maker, the new commitment's risk + speculation key, and the
   * lazy-creation-fee debit — it signs nothing and allocates no nonce, so the
   * same preview flows on to `submitPrepared` unchanged.
   */
  preview: SubmitPreview;
}

export type SubmitFundabilityOutcome =
  /** Maker can back their whole open book plus this new commitment — including the worst-case existing lazy fees — at `checkedAtBlock`. */
  | 'fundable'
  /** A definite funding shortfall was found from a successful read. */
  | 'not-fundable'
  /** A required read failed, OR funding straddles the undeterminable existing-lazy-fee band — the verdict can't be asserted either way. */
  | 'unknown';

export type SubmitFundabilityReasonCode =
  | 'MAKER_USDC_BALANCE_INSUFFICIENT'
  | 'MAKER_POSITION_ALLOWANCE_INSUFFICIENT'
  | 'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT'
  /** Funding covers the definite requirement but might not cover the maximum
   * possible creation fees of the maker's existing never-matched commitments
   * (whose speculations may or may not be created yet) — can't tell without a
   * per-speculation lookup, so the verdict is `unknown` rather than a risky `fundable`. */
  | 'EXISTING_LAZY_FEE_UNDETERMINED'
  /** A chain read or the open-book list failed — advisory, never a false not-fundable. */
  | 'FUNDABILITY_UNKNOWN';

export interface SubmitFundabilityReason {
  code: SubmitFundabilityReasonCode;
  /** The ERC-20 token (USDC) the requirement is denominated in. Funding reasons only. */
  token?: Hex;
  /** The spender the allowance requirement targets (PositionModule / TreasuryModule). Allowance reasons only. */
  spender?: Hex;
  /** Aggregate required amount (wei6) — the whole-book sum, not the new commitment alone. (For `EXISTING_LAZY_FEE_UNDETERMINED`, the maximum undeterminable existing lazy fee.) */
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
}

export interface CheckSubmitFundabilityResult {
  /** The maker the verdict is for (`preview.raw.maker`, lowercased). */
  maker: Hex;
  /** Convenience flag — `outcome === 'fundable'`. */
  fundableNow: boolean;
  outcome: SubmitFundabilityOutcome;
  /** Always true — a point-in-time advisory, never a guarantee. */
  advisory: true;
  /** Block at which balances/allowances were read. Absent only when the block read failed. */
  checkedAtBlock?: bigint;
  /**
   * The whole-book requirement the verdict was computed against. Present once
   * the maker's existing open book was fetched — absent when that fetch failed
   * (→ `unknown`), since the aggregate can't be computed without it.
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

  // All reads in parallel. Treasury allowance is read whenever the chain has a
  // creation fee — it bounds BOTH this submit's lazy fee AND the existing
  // maybe-lazy fees (computed from the list below). Every read degrades to null
  // on failure so a flaky read never produces a false `fundable`.
  const [existing, balance, positionAllowance, treasuryAllowance, block] = await Promise.all([
    tryFetchExistingOpenRisk(ctx, maker, newKey),
    tryReadUsdcBalance(publicClient, usdc, maker),
    tryReadAllowance(publicClient, usdc, maker, positionModule),
    makerCreationFeeShareWei6 > 0n
      ? tryReadAllowance(publicClient, usdc, maker, treasuryModule)
      : Promise.resolve(0n),
    tryReadBlockNumber(publicClient),
  ]);
  const checkedAtBlock = block ?? undefined;

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
        };

  // A definite shortfall from a successful read is proof the book can't be
  // backed — even on a list failure (the new-commitment lower bound) or when
  // another read failed.
  if (reasons.length > 0) {
    return result({ maker, outcome: 'not-fundable', reasons, requirement, checkedAtBlock });
  }
  // No definite shortfall. Without the existing book we can't form the aggregate
  // (it could be arbitrarily large) → unknown.
  if (existing === null) {
    return result({
      maker,
      outcome: 'unknown',
      reasons: [{ code: 'FUNDABILITY_UNKNOWN' }],
      checkedAtBlock,
    });
  }
  if (anyReadFailed) {
    return result({
      maker,
      outcome: 'unknown',
      reasons: [{ code: 'FUNDABILITY_UNKNOWN' }],
      requirement,
      checkedAtBlock,
    });
  }
  if (lazyFeeUncertain) {
    return result({
      maker,
      outcome: 'unknown',
      reasons: [{ code: 'EXISTING_LAZY_FEE_UNDETERMINED', token: usdc, requiredWei6: existingLazyFeeMaxWei6 }],
      requirement,
      checkedAtBlock,
    });
  }
  return result({ maker, outcome: 'fundable', reasons: [], requirement, checkedAtBlock });
}

// ── Helpers ────────────────────────────────────────────────────────────

function result(args: {
  maker: Hex;
  outcome: SubmitFundabilityOutcome;
  reasons: SubmitFundabilityReason[];
  // `| undefined` (not just `?`) so callers can pass the maybe-undefined `requirement`
  // directly under `exactOptionalPropertyTypes`; the body assigns it only when present.
  requirement?: SubmitFundabilityRequirement | undefined;
  checkedAtBlock?: bigint | undefined;
}): CheckSubmitFundabilityResult {
  const out: CheckSubmitFundabilityResult = {
    maker: args.maker,
    fundableNow: args.outcome === 'fundable',
    outcome: args.outcome,
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
 * commitments isn't under-counted. Returns `null` on ANY list failure — the
 * aggregate can't be computed without it, so the caller degrades to `unknown`.
 */
async function tryFetchExistingOpenRisk(
  ctx: CommitmentsContext,
  maker: Hex,
  newKey: string,
): Promise<{ riskWei6: bigint; count: number; maybeLazyKeyCount: number } | null> {
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
        // Hidden bodies redact `remainingRiskAmount` + `speculationKey` per the
        // public allow-list (own-state SSE plan §2.3), so we cannot account for
        // them in either the existing-risk sum or the maybe-lazy-key set.
        // Skipping would silently UNDER-count the maker's open exposure — the
        // one error a funding guard must never make. Degrade to `unknown`
        // (caller surfaces `EXISTING_OPEN_RISK_UNDETERMINED`) so the verdict is
        // honest. The maker recovers a definite verdict by re-running with the
        // owner-auth own-state surface (M5/PR3 `client.ownState.list*`), which
        // delivers the full payload for their own hidden rows.
        if (r.redacted === true) return null;
        const remaining = BigInt(r.remainingRiskAmount);
        if (remaining > 0n) {
          riskWei6 += remaining;
          count += 1;
        }
        // Only a never-matched (`stored 'open'`) commitment can owe a creation
        // fee — a `partially_filled` one has matched, so its speculation exists.
        if (r.storedStatus === 'open' && r.speculationKey !== null) {
          const key = r.speculationKey.toLowerCase();
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
