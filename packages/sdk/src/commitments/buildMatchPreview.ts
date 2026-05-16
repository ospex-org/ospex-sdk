/**
 * Pure preview-model builder for `commitments match`. Mirrors
 * `buildSubmitPreview` but for the taker side: the maker has already
 * signed; the taker submits a tx that references the maker's payload,
 * so this function computes the taker-perspective economics, the
 * counterparty odds, the spec-existence-aware approval rows, and any
 * warnings.
 *
 * No I/O. The orchestrator (`prepareMatch`) is responsible for
 * fetching the commitment, contest detail, treasury/position
 * allowances, and the speculation-mode discriminator, then calling
 * this with everything pre-fetched.
 *
 * Lot-size math mirrors `MatchingModule.sol:260-272`. Mirrored locally
 * (rather than imported from `match.ts`) so the pure builder stays
 * self-contained — `match.ts` calls this file too.
 */

import {
  tickToAmericanOdds,
  tickToDecimalOdds,
  ticksToDecimalLine,
  wei6ToDecimalUSDC,
} from './decimals.js';
import { OspexValidationError } from '../errors.js';
import type {
  BuildMatchPreviewArgs,
  LazyCreationFee,
  MatchPreview,
  MatchPreviewContest,
  MatchPreviewEconomics,
  MatchPreviewExpiry,
  MatchPreviewMarket,
  MatchPreviewOdds,
  MatchPreviewSide,
  MatchPreviewSpeculation,
  MatchPreviewWarning,
} from '../types/matchPreview.js';
import type {
  PreviewApproval,
  PreviewCounterparty,
  PreviewOutcome,
  PreviewYou,
  SideRole,
} from '../types/preview.js';
import type { Hex } from '../types/signer.js';
import type { MarketType } from '../types/odds.js';
import { buildPreviewOutcomes } from './outcomeView.js';
import {
  buildPreviewCounterparty,
  buildPreviewYou,
} from './perspectiveView.js';

const ODDS_SCALE = 100n;
const DEFAULT_EXPIRES_SOON_THRESHOLD_SEC = 5n * 60n;

export function buildMatchPreview(args: BuildMatchPreviewArgs): MatchPreview {
  const c = args.commitment;
  // Required fields — mirrors validation in `match.ts`. The orchestrator
  // re-runs the same checks; we duplicate here so the pure builder is
  // self-contained and unit-testable in isolation.
  const marketType = requireField(c.marketType, 'marketType', c.commitmentHash);
  const contestIdStr = requireField(c.contestId, 'contestId', c.commitmentHash);
  const lineTicks = requireField(c.lineTicks, 'lineTicks', c.commitmentHash);
  const positionType = requireField(c.positionType, 'positionType', c.commitmentHash);
  const oddsTick = requireField(c.oddsTick, 'oddsTick', c.commitmentHash);
  const expiryISO = requireField(c.expiry, 'expiry', c.commitmentHash);

  const oddsTickN = BigInt(oddsTick);
  if (oddsTickN <= ODDS_SCALE) {
    // Protocol min is 101 (decimal 1.01); below leads to division by
    // zero in the lot-size math.
    throw new OspexValidationError(
      `Commitment ${c.commitmentHash} has invalid oddsTick=${oddsTick}; protocol minimum is ${ODDS_SCALE + 1n}.`,
      { field: 'oddsTick' },
    );
  }

  const remainingMakerRiskWei6 = BigInt(c.remainingRiskAmount);
  if (remainingMakerRiskWei6 <= 0n) {
    throw new OspexValidationError(
      `Commitment ${c.commitmentHash} has no remaining capacity.`,
      { field: 'remainingRiskAmount' },
    );
  }

  // ── Taker desired risk ────────────────────────────────────────────
  // Default: bid for the entire remaining maker capacity. Mirrors
  // `match.ts:88-106` so the preview matches what the convenience
  // wrapper would have computed.
  const profitTicks = oddsTickN - ODDS_SCALE;
  let takerDesiredRiskWei6: bigint;
  if (args.takerDesiredRiskWei6 !== undefined) {
    if (args.takerDesiredRiskWei6 <= 0n) {
      throw new OspexValidationError('takerDesiredRiskWei6 must be positive.', {
        field: 'takerDesiredRiskWei6',
      });
    }
    takerDesiredRiskWei6 = args.takerDesiredRiskWei6;
  } else {
    takerDesiredRiskWei6 = (remainingMakerRiskWei6 * profitTicks) / ODDS_SCALE;
    if (takerDesiredRiskWei6 === 0n) {
      throw new OspexValidationError(
        `Computed taker risk for full remaining fill is zero (oddsTick=${oddsTick}, remaining=${remainingMakerRiskWei6}). Pass an explicit takerDesiredRiskWei6.`,
        { field: 'takerDesiredRiskWei6' },
      );
    }
  }

  // ── Lot-size rounding (mirrors MatchingModule.sol:260-272) ────────
  const rawFillMakerRisk =
    (takerDesiredRiskWei6 * ODDS_SCALE + profitTicks - 1n) / profitTicks;
  const fillMakerRiskWei6 = rawFillMakerRisk - (rawFillMakerRisk % ODDS_SCALE);
  if (fillMakerRiskWei6 === 0n || fillMakerRiskWei6 > remainingMakerRiskWei6) {
    throw new OspexValidationError(
      `Match would revert: fillMakerRisk=${fillMakerRiskWei6} not in (0, remaining=${remainingMakerRiskWei6}]. Choose a different takerDesiredRiskWei6.`,
      { field: 'takerDesiredRiskWei6' },
    );
  }
  let takerRiskWei6 = (fillMakerRiskWei6 * profitTicks) / ODDS_SCALE;
  if (takerRiskWei6 > takerDesiredRiskWei6) takerRiskWei6 = takerDesiredRiskWei6;

  // Profit/return for the taker. Zero-vig → profit equals fillMakerRisk.
  const takerProfitWei6 = fillMakerRiskWei6;
  const takerReturnWei6 = takerRiskWei6 + takerProfitWei6;

  // ── Sides + line displays ─────────────────────────────────────────
  const makerRole = roleFor(marketType, positionType);
  const takerRole = invertRole(makerRole);
  const makerLabel = labelFor(makerRole, args.awayTeam, args.homeTeam);
  const takerLabel = labelFor(takerRole, args.awayTeam, args.homeTeam);

  const makerSide: MatchPreviewSide = {
    positionType,
    resolvedLabel: makerLabel,
    role: makerRole,
  };
  const takerSide: MatchPreviewSide = {
    positionType: positionType === 0 ? 1 : 0,
    resolvedLabel: takerLabel,
    role: takerRole,
  };

  const makerLineDisplay = computeLineDisplay(
    marketType,
    lineTicks,
    makerRole,
    args.awayTeam,
    args.homeTeam,
  );
  const takerLineDisplay = computeLineDisplay(
    marketType,
    lineTicks,
    takerRole,
    args.awayTeam,
    args.homeTeam,
  );

  // ── Odds (maker + taker perspectives) ─────────────────────────────
  const takerOddsTick = inverseOddsTick(oddsTick);
  const odds: MatchPreviewOdds = {
    oddsTick,
    makerDecimal: tickToDecimalOdds(oddsTick),
    makerAmerican: tickToAmericanOdds(oddsTick),
    takerOddsTick,
    takerDecimal: tickToDecimalOdds(takerOddsTick),
    takerAmerican: tickToAmericanOdds(takerOddsTick),
  };

  // ── Self-match flag ────────────────────────────────────────────────
  const makerLower = c.maker.toLowerCase() as Hex;
  const takerLower = args.taker.toLowerCase() as Hex;
  const selfMatch = makerLower === takerLower;

  // ── Speculation discriminator + lazy fee block ────────────────────
  const speculation: MatchPreviewSpeculation =
    args.speculation.mode === 'existing'
      ? {
          mode: 'existing',
          speculationId: args.speculation.speculationId,
          speculationKey: args.speculationKey,
        }
      : {
          mode: 'lazy',
          speculationId: null,
          speculationKey: args.speculationKey,
          lazyCreation: buildLazyCreationFee(
            args.speculationCreationTotalFeeWei6,
            args.makerTreasuryAllowanceWei6,
            selfMatch,
          ),
        };

  // ── Approvals[] ───────────────────────────────────────────────────
  // PositionModule.recordFill performs TWO safeTransferFrom calls — one
  // for the maker side (`fillMakerRisk`) and one for the taker side
  // (`takerRisk`). For a non-self match those land on different wallets
  // and consume different ERC-20 allowances. For a SELF match both
  // calls hit the same wallet, so the wallet's PositionModule USDC
  // allowance has to cover the SUM. Mirrors the doubling already
  // applied to the lazy-creation-fee row's `takerShareWei6` below.
  const positionRequiredWei6 = selfMatch
    ? takerRiskWei6 + fillMakerRiskWei6
    : takerRiskWei6;
  const approvals: PreviewApproval[] = [
    {
      token: 'USDC',
      spender: args.positionModuleAddress,
      required: positionRequiredWei6.toString(),
      current: args.takerPositionAllowanceWei6.toString(),
      needsApproval: args.takerPositionAllowanceWei6 < positionRequiredWei6,
      purpose: 'commitment-risk',
    },
  ];
  if (
    args.speculation.mode === 'lazy' &&
    args.speculationCreationTotalFeeWei6 > 0n
  ) {
    // Taker's share = full fee on self-match (same wallet pays both
    // halves of TreasuryModule.processSplitFee); half fee otherwise.
    const takerShareWei6 = selfMatch
      ? args.speculationCreationTotalFeeWei6
      : args.speculationCreationTotalFeeWei6 / 2n;
    approvals.push({
      token: 'USDC',
      spender: args.treasuryModuleAddress,
      required: takerShareWei6.toString(),
      current: args.takerTreasuryAllowanceWei6.toString(),
      needsApproval: args.takerTreasuryAllowanceWei6 < takerShareWei6,
      purpose: 'lazy-creation-fee',
    });
  }

  // ── Expiry block + warnings ────────────────────────────────────────
  const nowSec = args.nowUnixSec ?? BigInt(Math.floor(Date.now() / 1000));
  const expirySec = parseExpiryToUnixSec(expiryISO);
  const expired = expirySec <= nowSec;
  const threshold = args.expiresSoonThresholdSec ?? DEFAULT_EXPIRES_SOON_THRESHOLD_SEC;
  const expiresSoonMinutes =
    !expired && expirySec - nowSec <= threshold
      ? Number((expirySec - nowSec) / 60n)
      : null;

  const expiry: MatchPreviewExpiry = {
    unixSec: expirySec.toString(),
    iso: new Date(Number(expirySec) * 1000).toISOString(),
    expired,
    expiresSoonMinutes,
  };

  const warnings: MatchPreviewWarning[] = [];
  if (selfMatch) warnings.push('self-match');
  if (expired) warnings.push('expired');
  else if (expiresSoonMinutes !== null) warnings.push('expires-soon');
  // Partial fill: fillMakerRisk strictly less than the maker's full remaining.
  if (fillMakerRiskWei6 < remainingMakerRiskWei6) warnings.push('partial-fill');
  if (c.nonceInvalidated) warnings.push('nonce-invalidated');
  if (
    !selfMatch &&
    args.speculation.mode === 'lazy' &&
    args.speculationCreationTotalFeeWei6 > 0n &&
    args.makerTreasuryAllowanceWei6 < args.speculationCreationTotalFeeWei6 / 2n
  ) {
    warnings.push('maker-treasury-allowance-insufficient');
  }

  // ── Contest block ─────────────────────────────────────────────────
  const contest: MatchPreviewContest = {
    contestId: contestIdStr,
    label: buildContestLabel(args.awayTeam, args.homeTeam, args.matchTime, args.sport),
    awayTeam: args.awayTeam,
    homeTeam: args.homeTeam,
    awayTeamId: args.awayTeamId,
    homeTeamId: args.homeTeamId,
    sport: args.sport,
    matchTime: args.matchTime,
  };

  const market: MatchPreviewMarket = {
    type: marketType,
    lineTicks,
    makerLineDisplay,
    takerLineDisplay,
  };

  const economics: MatchPreviewEconomics = {
    oddsTick,
    remainingMakerRiskWei6: remainingMakerRiskWei6.toString(),
    remainingMakerRiskUSDC: wei6ToDecimalUSDC(remainingMakerRiskWei6),
    takerDesiredRiskWei6: takerDesiredRiskWei6.toString(),
    takerDesiredRiskUSDC: wei6ToDecimalUSDC(takerDesiredRiskWei6),
    fillMakerRiskWei6: fillMakerRiskWei6.toString(),
    fillMakerRiskUSDC: wei6ToDecimalUSDC(fillMakerRiskWei6),
    takerRiskWei6: takerRiskWei6.toString(),
    takerRiskUSDC: wei6ToDecimalUSDC(takerRiskWei6),
    takerProfitOnWinUSDC: wei6ToDecimalUSDC(takerProfitWei6),
    takerReturnOnWinUSDC: wei6ToDecimalUSDC(takerReturnWei6),
  };

  // ── Agent-facing "you / counterparty / outcomes" view ─────────────
  // Mirrors the existing maker/taker fields but in first-person form.
  // The viewer is always the taker on a match preview; the maker is the
  // signed counterparty. Built additively under schemaVersion 1.
  const takerPositionType: 0 | 1 = positionType === 0 ? 1 : 0;
  const you: PreviewYou = buildPreviewYou({
    role: 'taker',
    address: takerLower,
    market: marketType,
    positionType: takerPositionType,
    lineTicks,
    oddsTick: takerOddsTick,
    riskWei6: takerRiskWei6,
    profitWei6: takerProfitWei6,
    awayTeam: args.awayTeam,
    homeTeam: args.homeTeam,
  });
  const counterparty: PreviewCounterparty = buildPreviewCounterparty({
    role: 'maker',
    address: makerLower,
    market: marketType,
    positionType,
    lineTicks,
    oddsTick,
    riskWei6: fillMakerRiskWei6,
    // Maker's profit on win = taker's risk (zero-vig protocol).
    profitWei6: takerRiskWei6,
    awayTeam: args.awayTeam,
    homeTeam: args.homeTeam,
  });
  const outcomes: PreviewOutcome[] = buildPreviewOutcomes({
    market: marketType,
    lineTicks,
    riskWei6: takerRiskWei6,
    profitWei6: takerProfitWei6,
    resolvedSide: {
      role: takerRole,
      resolvedLabel: takerLabel,
    },
    awayTeam: args.awayTeam,
    homeTeam: args.homeTeam,
  });

  return {
    schemaVersion: 1,
    commitment: c,
    chainId: args.chainId,
    verifyingContract: args.matchingModuleAddress,
    maker: makerLower,
    taker: takerLower,
    selfMatch,
    contest,
    market,
    makerSide,
    takerSide,
    odds,
    economics,
    expiry,
    speculation,
    approvals,
    nonceInvalidated: c.nonceInvalidated,
    isLive: c.isLive,
    warnings,
    you,
    counterparty,
    outcomes,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function requireField<T>(value: T | null, name: string, hash: string): T {
  if (value === null) {
    throw new OspexValidationError(
      `Commitment ${hash} is missing required field for match: ${name}.`,
      { field: name },
    );
  }
  return value;
}

function roleFor(market: MarketType, positionType: 0 | 1): SideRole {
  if (market === 'total') return positionType === 0 ? 'over' : 'under';
  return positionType === 0 ? 'away' : 'home';
}

function invertRole(role: SideRole): SideRole {
  switch (role) {
    case 'away':
      return 'home';
    case 'home':
      return 'away';
    case 'over':
      return 'under';
    case 'under':
      return 'over';
  }
}

function labelFor(role: SideRole, awayTeam: string, homeTeam: string): string {
  switch (role) {
    case 'away':
      return awayTeam;
    case 'home':
      return homeTeam;
    case 'over':
      return 'over';
    case 'under':
      return 'under';
  }
}

function buildContestLabel(
  away: string,
  home: string,
  matchTime: string,
  sport: string,
): string {
  const date = matchTime.length >= 10 ? matchTime.slice(0, 10) : matchTime;
  return `${away} @ ${home}, ${date} — ${sport.toUpperCase()}`;
}

/**
 * Render the spread/total line from a given side's perspective. Spread
 * lineTicks is stored away-perspective; flips for home selection. Total
 * shows "Over X" or "Under X" depending on role.
 */
function computeLineDisplay(
  market: MarketType,
  lineTicks: number,
  role: SideRole,
  awayTeam: string,
  homeTeam: string,
): string | null {
  if (market === 'moneyline') return null;
  if (market === 'total') {
    const lineDecimal = ticksToDecimalLine(Math.abs(lineTicks));
    return `${role === 'over' ? 'Over' : 'Under'} ${lineDecimal}`;
  }
  // Spread.
  const fromSelectedTicks = role === 'away' ? lineTicks : -lineTicks;
  const formatted = ticksToDecimalLine(fromSelectedTicks);
  const signed =
    fromSelectedTicks >= 0 && !formatted.startsWith('+') ? `+${formatted}` : formatted;
  const teamLabel = role === 'away' ? awayTeam : homeTeam;
  return `${teamLabel} ${signed}`;
}

/**
 * Compute the symmetric counterparty oddsTick. If maker decimal is
 * D = oddsTick / 100, taker decimal is D / (D - 1) = oddsTick / (oddsTick - 100).
 * In tick units: takerTick = round(100 * oddsTick / (oddsTick - 100)).
 */
function inverseOddsTick(oddsTick: number): number {
  const profitTicks = oddsTick - 100;
  if (profitTicks <= 0) {
    throw new OspexValidationError(
      `Cannot invert oddsTick=${oddsTick}; protocol minimum is 101.`,
      { field: 'oddsTick' },
    );
  }
  return Math.round((100 * oddsTick) / profitTicks);
}

function buildLazyCreationFee(
  totalFeeWei6: bigint,
  makerTreasuryAllowanceWei6: bigint,
  selfMatch: boolean,
): LazyCreationFee {
  // Each side's required allowance — the wallet that's both maker and
  // taker pays the full fee through TWO safeTransferFrom calls; the
  // wallet's allowance must cover the total. For the non-self case
  // both sides pay half each.
  const halfFeeWei6 = totalFeeWei6 / 2n;
  const takerShareWei6 = selfMatch ? totalFeeWei6 : halfFeeWei6;
  const makerShareWei6 = selfMatch ? totalFeeWei6 : halfFeeWei6;
  return {
    totalFeeWei6: totalFeeWei6.toString(),
    totalFeeUSDC: wei6ToDecimalUSDC(totalFeeWei6),
    takerShareWei6: takerShareWei6.toString(),
    takerShareUSDC: wei6ToDecimalUSDC(takerShareWei6),
    makerShareWei6: makerShareWei6.toString(),
    makerShareUSDC: wei6ToDecimalUSDC(makerShareWei6),
    makerTreasuryAllowanceWei6: makerTreasuryAllowanceWei6.toString(),
    makerTreasuryAllowanceUSDC: wei6ToDecimalUSDC(makerTreasuryAllowanceWei6),
    makerTreasuryAllowanceSufficient:
      makerTreasuryAllowanceWei6 >= makerShareWei6,
  };
}

function parseExpiryToUnixSec(iso: string): bigint {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new OspexValidationError(`Commitment expiry is not a valid ISO-8601 string: "${iso}".`, {
      field: 'expiry',
    });
  }
  return BigInt(Math.floor(ms / 1000));
}
