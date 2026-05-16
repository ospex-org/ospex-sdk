/**
 * Pure preview-model builder. Given pre-resolved data — contest
 * context, market type, scorer, line ticks, side resolution, odds,
 * risk, and EIP-712 identity fields — returns a `SubmitPreview`
 * with computed economics, the full EIP-712 raw block, allowance
 * deltas, and the explicit win/lose/push outcome rows.
 *
 * No I/O — no API calls, no RPC. The orchestrator (`prepareSubmit`)
 * is responsible for fetching contest detail, speculation detail,
 * allowances, and the maker's nonce, then calling this with
 * everything pre-fetched.
 *
 * Outcome generation:
 *   - moneyline: two rows (win / lose). No push.
 *   - spread:  three rows when push possible (line on integer); two
 *              otherwise. Win condition flips by positionType.
 *   - total:   same shape as spread.
 *
 * Display labels and conditions are written from the *selected side's*
 * perspective so the preview reads naturally regardless of whether
 * the user picked away or home / over or under.
 */

import { deriveSpeculationKey } from '../chain/eip712.js';
import {
  tickToAmericanOdds,
  tickToDecimalOdds,
  wei6ToDecimalUSDC,
  ticksToDecimalLine,
} from './decimals.js';
import { buildPreviewOutcomes } from './outcomeView.js';
import {
  buildPreviewCounterparty,
  buildPreviewYou,
  inverseOddsTick,
} from './perspectiveView.js';
import { buildCreationFeeSummary } from './creationFeeSummary.js';
import type { ResolveSideResult } from './resolveSide.js';
import type { MarketType } from '../types/odds.js';
import type {
  ExpirySource,
  PreviewApproval,
  PreviewContest,
  PreviewCounterparty,
  PreviewEconomics,
  PreviewExpiry,
  PreviewMarket,
  PreviewOutcome,
  PreviewRaw,
  PreviewSide,
  PreviewYou,
  SubmitPreview,
} from '../types/preview.js';
import type { Hex } from '../types/signer.js';

const ODDS_SCALE = 100n;

export interface BuildSubmitPreviewArgs {
  // Contest
  contestId: bigint;
  awayTeam: string;
  homeTeam: string;
  awayTeamId: string | null;
  homeTeamId: string | null;
  sport: string;
  matchTime: string;
  // Market
  market: MarketType;
  scorer: Hex;
  lineTicks: number;
  /**
   * Input shape for the speculation discriminator. Deliberately
   * narrower than the public `SpeculationMode` — the lazy variant
   * omits `makerCreationFeeUSDC` because that's enriched here from
   * `makerCreationFeeWei6`. Caller supplies the bare structural data;
   * `buildSubmitPreview` computes the user-facing fee string.
   */
  speculation:
    | { mode: 'existing'; speculationId: string }
    | { mode: 'lazy'; speculationId: null; speculationKey: string };
  // Side (already resolved)
  resolvedSide: ResolveSideResult;
  sideInput: string;
  // Economics inputs
  oddsTick: number;
  riskWei6: bigint;
  // EIP-712 identity
  maker: Hex;
  chainId: number;
  matchingModuleAddress: Hex;
  /**
   * Per-side share of the protocol speculation creation fee, in wei6.
   * Only used when `speculation.mode === 'lazy'`; passed in from the
   * orchestrator (which reads it from
   * `SPECULATION_CREATION_FEE_MAKER_SHARE_WEI6[chainId]`). Setting it
   * to 0n is acceptable in tests / future chains where the fee is
   * disabled, but the canonical mainnet value is 250000n (0.25 USDC).
   * Formatted in the lazy preview as `makerCreationFeeUSDC`.
   */
  makerCreationFeeWei6: bigint;
  expirySec: bigint;
  /** Provenance of the chosen expiry — see prepareSubmit's parseExpiry. */
  expirySource: ExpirySource;
  /**
   * Contest match time as unix-seconds bigint, or null when missing/
   * invalid. Used here to decide whether to set
   * `expiry.afterMatchTime` (live-betting flag) and to populate
   * `expiry.matchTimeUnixSec`.
   */
  matchTimeSec: bigint | null;
  nonce: bigint;
  // Allowance preflight (the only token relevant to commit submit is USDC).
  // Two spenders matter:
  //   - PositionModule pulls the maker's `riskAmount` at match time
  //     (the safeTransferFrom in PositionModule.recordFill).
  //   - TreasuryModule pulls the maker's HALF of the protocol's
  //     speculation-creation fee on the FIRST match of a lazy spec
  //     (TreasuryModule.processSplitFee). For non-lazy commits this
  //     never fires, so the second allowance row is omitted from the
  //     `approvals[]` output.
  positionModuleAddress: Hex;
  usdcCurrentAllowanceWei6: bigint;
  treasuryModuleAddress: Hex;
  treasuryUsdcCurrentAllowanceWei6: bigint;
}

export function buildSubmitPreview(args: BuildSubmitPreviewArgs): SubmitPreview {
  const profitWei6 = (args.riskWei6 * BigInt(args.oddsTick - 100)) / ODDS_SCALE;
  const returnWei6 = args.riskWei6 + profitWei6;

  const economics: PreviewEconomics = {
    oddsTick: args.oddsTick,
    oddsDecimal: tickToDecimalOdds(args.oddsTick),
    oddsAmerican: tickToAmericanOdds(args.oddsTick),
    riskWei6: args.riskWei6.toString(),
    riskUSDC: wei6ToDecimalUSDC(args.riskWei6),
    profitUSDC: wei6ToDecimalUSDC(profitWei6),
    returnUSDC: wei6ToDecimalUSDC(returnWei6),
    counterpartyRiskUSDC: wei6ToDecimalUSDC(profitWei6),
  };

  // Derive the canonical speculationKey ONCE. It's used for raw.speculationKey
  // (what gets signed) AND, when lazy, for market.speculation.speculationKey
  // (what the preview shows). Caller-supplied speculation values for the
  // lazy mode are overridden so the preview readback can never drift from
  // what the signature binds — the trust-model invariant is that
  // raw.speculationKey == market.speculation.speculationKey when lazy.
  const speculationKey = deriveSpeculationKey(args.contestId, args.scorer, args.lineTicks);

  const raw: PreviewRaw = {
    maker: args.maker,
    chainId: args.chainId,
    verifyingContract: args.matchingModuleAddress,
    contestId: args.contestId.toString(),
    scorer: args.scorer,
    lineTicks: args.lineTicks,
    positionType: args.resolvedSide.positionType,
    oddsTick: args.oddsTick,
    riskAmount: args.riskWei6.toString(),
    expiry: args.expirySec.toString(),
    nonce: args.nonce.toString(),
    speculationKey,
  };

  const expiry: PreviewExpiry = {
    unixSec: args.expirySec.toString(),
    iso: new Date(Number(args.expirySec) * 1000).toISOString(),
    source: args.expirySource,
    afterMatchTime: args.matchTimeSec !== null && args.expirySec > args.matchTimeSec,
    matchTimeUnixSec: args.matchTimeSec !== null ? args.matchTimeSec.toString() : null,
  };

  // Always include the PositionModule (commitment-risk) approval row.
  // Add a second row for the lazy creation fee ONLY when this commit
  // would trigger lazy speculation creation on its first match — a
  // non-lazy commit never pays the fee, so the row would just be
  // visual noise.
  const approvals: PreviewApproval[] = [
    {
      token: 'USDC',
      spender: args.positionModuleAddress,
      required: args.riskWei6.toString(),
      current: args.usdcCurrentAllowanceWei6.toString(),
      needsApproval: args.usdcCurrentAllowanceWei6 < args.riskWei6,
      purpose: 'commitment-risk',
    },
  ];
  if (args.speculation.mode === 'lazy' && args.makerCreationFeeWei6 > 0n) {
    approvals.push({
      token: 'USDC',
      spender: args.treasuryModuleAddress,
      required: args.makerCreationFeeWei6.toString(),
      current: args.treasuryUsdcCurrentAllowanceWei6.toString(),
      needsApproval: args.treasuryUsdcCurrentAllowanceWei6 < args.makerCreationFeeWei6,
      purpose: 'lazy-creation-fee',
    });
  }

  const contest: PreviewContest = {
    contestId: args.contestId.toString(),
    label: buildContestLabel(args.awayTeam, args.homeTeam, args.matchTime, args.sport),
    awayTeam: args.awayTeam,
    homeTeam: args.homeTeam,
    awayTeamId: args.awayTeamId,
    homeTeamId: args.homeTeamId,
    sport: args.sport,
    matchTime: args.matchTime,
  };

  const displayLine = computeDisplayLine(
    args.market,
    args.lineTicks,
    args.resolvedSide,
    args.awayTeam,
    args.homeTeam,
  );

  // ── Speculation creation-fee summary ──────────────────────────────
  // Always present on both modes — agent reads one field, no inference
  // from missing fields. The on-chain split is exactly 50/50, so the
  // total = `makerCreationFeeWei6 * 2`. On a submit preview the viewer
  // is the maker (no taker has signed yet, no self-match concept).
  const totalFeeWei6 = args.makerCreationFeeWei6 * 2n;
  const creationFee = buildCreationFeeSummary({
    mode: args.speculation.mode,
    totalFeeWei6,
    selfMatch: false,
    viewerRole: 'maker',
    viewerTreasuryAllowanceWei6: args.treasuryUsdcCurrentAllowanceWei6,
    treasuryModuleAddress: args.treasuryModuleAddress,
    speculationId:
      args.speculation.mode === 'existing'
        ? args.speculation.speculationId
        : null,
  });

  const market: PreviewMarket = {
    type: args.market,
    speculation:
      args.speculation.mode === 'lazy'
        ? {
            mode: 'lazy',
            speculationId: null,
            speculationKey,
            makerCreationFeeUSDC: wei6ToDecimalUSDC(args.makerCreationFeeWei6),
            creationFee,
          }
        : {
            mode: 'existing',
            speculationId: args.speculation.speculationId,
            creationFee,
          },
    lineTicks: args.lineTicks,
    displayLine,
  };
  const submitAction: 'trade-only' | 'trade-and-create-speculation' =
    args.speculation.mode === 'lazy'
      ? 'trade-and-create-speculation'
      : 'trade-only';

  const side: PreviewSide = {
    input: args.sideInput,
    resolvedLabel: args.resolvedSide.resolvedLabel,
    positionType: args.resolvedSide.positionType,
    role: args.resolvedSide.role,
    resolutionSource: args.resolvedSide.resolutionSource,
  };

  const outcomes = buildPreviewOutcomes({
    market: args.market,
    lineTicks: args.lineTicks,
    riskWei6: args.riskWei6,
    profitWei6,
    resolvedSide: {
      role: args.resolvedSide.role,
      resolvedLabel: args.resolvedSide.resolvedLabel,
    },
    awayTeam: args.awayTeam,
    homeTeam: args.homeTeam,
  });

  // ── Agent-facing "you / counterparty" view ────────────────────────
  // Maker is the executing party on a submit preview; the counterparty
  // is the hypothetical taker who would fully fill (address: null —
  // no taker has signed yet). Mirrors `MatchPreview.you/counterparty`
  // for one consistent agent surface across both flows.
  const you: PreviewYou = buildPreviewYou({
    role: 'maker',
    address: args.maker,
    market: args.market,
    positionType: args.resolvedSide.positionType,
    lineTicks: args.lineTicks,
    oddsTick: args.oddsTick,
    riskWei6: args.riskWei6,
    profitWei6,
    awayTeam: args.awayTeam,
    homeTeam: args.homeTeam,
  });
  const counterpartyOddsTick = inverseOddsTick(args.oddsTick);
  // Counterparty risks `profitWei6` to potentially win `args.riskWei6`
  // (zero-vig protocol). For the hypothetical taker the address is
  // null since no one has signed the other side yet.
  const counterparty: PreviewCounterparty = buildPreviewCounterparty({
    role: 'taker',
    address: null,
    market: args.market,
    positionType: args.resolvedSide.positionType === 0 ? 1 : 0,
    lineTicks: args.lineTicks,
    oddsTick: counterpartyOddsTick,
    riskWei6: profitWei6,
    profitWei6: args.riskWei6,
    awayTeam: args.awayTeam,
    homeTeam: args.homeTeam,
  });

  return {
    contest,
    market,
    side,
    economics,
    expiry,
    raw,
    approvals,
    outcomes,
    you,
    counterparty,
    submitAction,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildContestLabel(away: string, home: string, matchTime: string, sport: string): string {
  // Take the date portion of an ISO string, e.g. "2026-05-08".
  const date = matchTime.length >= 10 ? matchTime.slice(0, 10) : matchTime;
  return `${away} @ ${home}, ${date} — ${sport.toUpperCase()}`;
}

function computeDisplayLine(
  market: MarketType,
  lineTicks: number,
  resolvedSide: ResolveSideResult,
  awayTeam: string,
  homeTeam: string,
): string | null {
  if (market === 'moneyline') return null;
  if (market === 'total') {
    // line_ticks for total is the absolute total line (not signed
    // per side). Display "Over X" or "Under X" depending on side.
    const lineDecimal = ticksToDecimalLine(Math.abs(lineTicks));
    return `${resolvedSide.role === 'over' ? 'Over' : 'Under'} ${lineDecimal}`;
  }
  // Spread: stored line_ticks is the AWAY perspective. Convert to
  // selected-side perspective for display.
  const awayLineTicks = lineTicks;
  const homeLineTicks = -lineTicks;
  const fromSelectedTicks = resolvedSide.role === 'away' ? awayLineTicks : homeLineTicks;
  const formatted = ticksToDecimalLine(fromSelectedTicks);
  // Add explicit sign for positive lines (the formatter only emits '-' for negatives).
  const signed = fromSelectedTicks >= 0 && !formatted.startsWith('+') ? `+${formatted}` : formatted;
  const teamLabel = resolvedSide.role === 'away' ? awayTeam : homeTeam;
  return `${teamLabel} ${signed}`;
}

// Note: the per-market outcome generation that used to live here is
// now in `outcomeView.ts:buildPreviewOutcomes`, called from this file's
// main body. Match-side previews call the same helper for taker-
// perspective outcomes.
