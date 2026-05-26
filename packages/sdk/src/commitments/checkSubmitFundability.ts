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
 *   - balance requirement            = existing open risk + new risk + lazy fee
 *   - PositionModule allowance req    = existing open risk + new risk
 *   - TreasuryModule allowance req    = lazy creation fee (lazy submits only)
 * where `existing open risk` = Σ remaining maker risk over the maker's
 * API-visible open + partially-filled commitments. Comparing the new commitment
 * in isolation would UNDER-state what the wallet must hold — the one error a
 * funding guard must never make.
 *
 * Scope note — VISIBLE, not latent. "Existing open risk" is the maker's
 * API-visible open + partially-filled book. It does NOT include book-hidden
 * latent payloads (a commitment pulled off the relay via an off-chain cancel
 * whose signed payload is still matchable on chain): the API doesn't surface
 * those by maker, and a non-automated SDK/CLI maker doesn't generally create
 * that latent set. The market-maker's per-tick funding guard is the tool that
 * accounts for latent exposure from its own local state — see the
 * ospex-market-maker DESIGN §6. For a maker submitting via the SDK/CLI, visible
 * ≈ everything they're on the hook for.
 *
 * It is ADVISORY: "fundable now, based on the latest reads" — never a guarantee.
 * Balances/allowances (and the maker's open book) can change between this read
 * and a fill. Mirrors the `ensure*` family: a discriminated `outcome`, fields
 * present only when meaningful, and never a fabricated value — `not-fundable`
 * and `unknown` are outcomes, NOT thrown errors.
 *
 * Read-only: pass a `preview` already built by `prepareSubmit`. This signs
 * nothing and allocates no nonce — the intended flow is `prepareSubmit` →
 * `checkSubmitFundability` → (if fundable / forced) `submitPrepared`, all on the
 * one preview. Requires an `rpcUrl` — throws `OspexConfigError` otherwise.
 */

import type { PublicClient } from 'viem';
import { readAllowance } from './allowance.js';
import { erc20Abi } from '../contracts/abi/erc20.js';
import { CommitmentsApi } from '../api/commitments.js';
import type { CommitmentsContext } from './context.js';
import type { SubmitPreview } from '../types/preview.js';
import type { Hex } from '../types/signer.js';

/** One page of the maker's open-book scan — the Supabase row cap (`list` paginates above it). */
const EXISTING_RISK_PAGE = 1000;

export interface CheckSubmitFundabilityArgs {
  /**
   * A submit preview from `commitments.prepareSubmit(args)`. The check reads it
   * for the maker, the new commitment's risk, and the lazy-creation-fee debit —
   * it signs nothing and allocates no nonce, so the same preview flows on to
   * `submitPrepared` unchanged.
   */
  preview: SubmitPreview;
}

export type SubmitFundabilityOutcome =
  /** Maker can back their whole open book plus this new commitment at `checkedAtBlock`. */
  | 'fundable'
  /** A definite funding shortfall was found from a successful read. */
  | 'not-fundable'
  /** A required read (chain or the maker's open-book list) failed and nothing
   * else was definitively short — the verdict can't be asserted either way. */
  | 'unknown';

export type SubmitFundabilityReasonCode =
  | 'MAKER_USDC_BALANCE_INSUFFICIENT'
  | 'MAKER_POSITION_ALLOWANCE_INSUFFICIENT'
  | 'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT'
  /** A chain read or the open-book list failed — advisory, never a false not-fundable. */
  | 'FUNDABILITY_UNKNOWN';

export interface SubmitFundabilityReason {
  code: SubmitFundabilityReasonCode;
  /** The ERC-20 token (USDC) the requirement is denominated in. Funding reasons only. */
  token?: Hex;
  /** The spender the allowance requirement targets (PositionModule / TreasuryModule). Allowance reasons only. */
  spender?: Hex;
  /** Aggregate required amount (wei6) — the whole-book sum, not the new commitment alone. Funding reasons only. */
  requiredWei6?: bigint;
  /** Current on-chain amount (wei6) that was read. Funding reasons only. */
  actualWei6?: bigint;
}

export interface SubmitFundabilityRequirement {
  /** This submit's maker risk (PositionModule pull at match). */
  newCommitmentRiskWei6: bigint;
  /** Σ remaining maker risk (`riskAmount − filled`) over the maker's API-visible open + partially-filled commitments. */
  existingOpenRiskWei6: bigint;
  /** Count of those existing open / partially-filled commitments. */
  existingOpenCommitmentCount: number;
  /** Maker's share of the lazy speculation-creation fee (→ TreasuryModule); `0n` when this submit isn't lazy. */
  lazyCreationFeeWei6: bigint;
  /** True iff this submit would lazily create the speculation on first match. */
  lazyCreation: boolean;
  /** Aggregate USDC the maker's wallet must hold: existing + new + lazy fee. */
  balanceRequiredWei6: bigint;
  /** Aggregate maker→PositionModule allowance needed: existing + new. */
  positionAllowanceRequiredWei6: bigint;
  /** Aggregate maker→TreasuryModule allowance needed: the lazy fee (`0n` when not lazy). */
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
   * the maker's existing open risk was fetched — absent when that fetch failed
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

  // The new commitment's maker debits come straight off the preview's approval
  // rows (built by `buildSubmitPreview`): the PositionModule 'commitment-risk'
  // row is always present; the TreasuryModule 'lazy-creation-fee' row is present
  // only when this submit would lazily create the speculation on first match.
  const positionRow = preview.approvals.find((a) => a.purpose === 'commitment-risk');
  const treasuryRow = preview.approvals.find((a) => a.purpose === 'lazy-creation-fee');
  const newCommitmentRiskWei6 = positionRow
    ? BigInt(positionRow.required)
    : BigInt(preview.economics.riskWei6);
  const lazyCreation = preview.submitAction === 'trade-and-create-speculation';
  const lazyCreationFeeWei6 = treasuryRow !== undefined ? BigInt(treasuryRow.required) : 0n;

  // All reads in parallel: the maker's existing open risk (API), USDC balance,
  // the maker→PositionModule allowance, the maker→TreasuryModule allowance (only
  // when a lazy fee actually applies), and the block number. Every read degrades
  // to null on failure so a flaky read never produces a false `fundable`.
  const [existing, balance, positionAllowance, treasuryAllowance, block] = await Promise.all([
    tryFetchExistingOpenRisk(ctx, maker),
    tryReadUsdcBalance(publicClient, usdc, maker),
    tryReadAllowance(publicClient, usdc, maker, positionModule),
    lazyCreationFeeWei6 > 0n
      ? tryReadAllowance(publicClient, usdc, maker, treasuryModule)
      : Promise.resolve(0n),
    tryReadBlockNumber(publicClient),
  ]);
  const checkedAtBlock = block ?? undefined;

  // The maker's existing open risk is load-bearing for the aggregate — without
  // it we'd be under-counting the book, so a failed fetch is `unknown`, never a
  // (possibly false) `fundable` or a misleading `not-fundable`.
  if (existing === null) {
    return result({
      maker,
      outcome: 'unknown',
      reasons: [{ code: 'FUNDABILITY_UNKNOWN' }],
      checkedAtBlock,
    });
  }

  const balanceRequiredWei6 = existing.riskWei6 + newCommitmentRiskWei6 + lazyCreationFeeWei6;
  const positionAllowanceRequiredWei6 = existing.riskWei6 + newCommitmentRiskWei6;
  const treasuryAllowanceRequiredWei6 = lazyCreationFeeWei6;
  const requirement: SubmitFundabilityRequirement = {
    newCommitmentRiskWei6,
    existingOpenRiskWei6: existing.riskWei6,
    existingOpenCommitmentCount: existing.count,
    lazyCreationFeeWei6,
    lazyCreation,
    balanceRequiredWei6,
    positionAllowanceRequiredWei6,
    treasuryAllowanceRequiredWei6,
  };

  const reasons: SubmitFundabilityReason[] = [];
  let anyReadFailed = false;

  if (balance === null) {
    anyReadFailed = true;
  } else if (balance < balanceRequiredWei6) {
    reasons.push({
      code: 'MAKER_USDC_BALANCE_INSUFFICIENT',
      token: usdc,
      requiredWei6: balanceRequiredWei6,
      actualWei6: balance,
    });
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

  // TreasuryModule allowance only matters when this submit carries a lazy fee.
  if (treasuryAllowanceRequiredWei6 > 0n) {
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
    }
  }

  if (reasons.length > 0) {
    // A definite shortfall from a successful read proves the book can't be
    // backed — even if some other read also failed.
    return result({ maker, outcome: 'not-fundable', reasons, requirement, checkedAtBlock });
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
  return result({ maker, outcome: 'fundable', reasons: [], requirement, checkedAtBlock });
}

// ── Helpers ────────────────────────────────────────────────────────────

function result(args: {
  maker: Hex;
  outcome: SubmitFundabilityOutcome;
  reasons: SubmitFundabilityReason[];
  requirement?: SubmitFundabilityRequirement;
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
 * commitments (the book they're already on the hook for), with their count.
 * Paginates the list endpoint so a maker with a full page of open commitments
 * isn't under-counted. Returns `null` on ANY list failure — the aggregate can't
 * be computed without it, so the caller degrades to `unknown` rather than risk a
 * false `fundable` from an under-counted book.
 */
async function tryFetchExistingOpenRisk(
  ctx: CommitmentsContext,
  maker: Hex,
): Promise<{ riskWei6: bigint; count: number } | null> {
  const api = new CommitmentsApi(ctx.api);
  let riskWei6 = 0n;
  let count = 0;
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
        const remaining = BigInt(r.remainingRiskAmount);
        if (remaining > 0n) {
          riskWei6 += remaining;
          count += 1;
        }
      }
      if (rows.length < EXISTING_RISK_PAGE) break;
      offset += EXISTING_RISK_PAGE;
    }
    return { riskWei6, count };
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
