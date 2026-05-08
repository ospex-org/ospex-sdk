/**
 * Pure preview-model builder. Given pre-resolved data — contest
 * context, market type, scorer, line ticks, side resolution, odds,
 * risk, and EIP-712 identity fields — returns a `SubmitPreview`
 * with computed economics, the full EIP-712 raw block, allowance
 * deltas, and the explicit win/lose/push outcome rows.
 *
 * No I/O — no API calls, no RPC. The orchestrator (`prepareSubmit`,
 * landing in PR C) is responsible for fetching contest detail,
 * speculation detail, allowances, and the maker's nonce, then calling
 * this with everything pre-fetched.
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
import { tickToDecimalOdds, wei6ToDecimalUSDC, ticksToDecimalLine } from './decimals.js';
import { pushPossible } from './pushPossible.js';
import type { ResolveSideResult } from './resolveSide.js';
import type { MarketType } from '../types/odds.js';
import type {
  PreviewApproval,
  PreviewContest,
  PreviewEconomics,
  PreviewMarket,
  PreviewOutcome,
  PreviewRaw,
  PreviewSide,
  SpeculationMode,
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
  speculation: SpeculationMode;
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
  expirySec: bigint;
  nonce: bigint;
  // Allowance preflight (the only token relevant to commit submit is USDC)
  positionModuleAddress: Hex;
  usdcCurrentAllowanceWei6: bigint;
}

export function buildSubmitPreview(args: BuildSubmitPreviewArgs): SubmitPreview {
  const profitWei6 = (args.riskWei6 * BigInt(args.oddsTick - 100)) / ODDS_SCALE;
  const returnWei6 = args.riskWei6 + profitWei6;

  const economics: PreviewEconomics = {
    oddsTick: args.oddsTick,
    oddsDecimal: tickToDecimalOdds(args.oddsTick),
    riskWei6: args.riskWei6.toString(),
    riskUSDC: wei6ToDecimalUSDC(args.riskWei6),
    profitUSDC: wei6ToDecimalUSDC(profitWei6),
    returnUSDC: wei6ToDecimalUSDC(returnWei6),
    counterpartyRiskUSDC: wei6ToDecimalUSDC(profitWei6),
  };

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

  const approvals: PreviewApproval[] = [
    {
      token: 'USDC',
      spender: args.positionModuleAddress,
      required: args.riskWei6.toString(),
      current: args.usdcCurrentAllowanceWei6.toString(),
      needsApproval: args.usdcCurrentAllowanceWei6 < args.riskWei6,
    },
  ];

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

  const market: PreviewMarket = {
    type: args.market,
    speculation: args.speculation,
    lineTicks: args.lineTicks,
    displayLine,
  };

  const side: PreviewSide = {
    input: args.sideInput,
    resolvedLabel: args.resolvedSide.resolvedLabel,
    positionType: args.resolvedSide.positionType,
    role: args.resolvedSide.role,
    resolutionSource: args.resolvedSide.resolutionSource,
  };

  const outcomes = buildOutcomes(args, profitWei6);

  return { contest, market, side, economics, raw, approvals, outcomes };
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

function buildOutcomes(args: BuildSubmitPreviewArgs, profitWei6: bigint): PreviewOutcome[] {
  const winPayout = wei6ToDecimalUSDC(profitWei6);
  const losePayout = wei6ToDecimalUSDC(-args.riskWei6);
  const pushPayout = wei6ToDecimalUSDC(args.riskWei6);

  if (args.market === 'moneyline') {
    return [
      {
        condition: `${args.resolvedSide.resolvedLabel} wins`,
        result: 'win',
        payoutUSDC: winPayout,
      },
      {
        condition: `${otherTeam(args)} wins`,
        result: 'lose',
        payoutUSDC: losePayout,
      },
    ];
  }

  if (args.market === 'total') {
    // line_ticks for total is unsigned; convert to a decimal threshold
    // for human-readable conditions.
    const totalDecimal = ticksToDecimalLine(Math.abs(args.lineTicks));
    const integerLine = pushPossible('total', args.lineTicks);
    const threshold = Math.abs(args.lineTicks) / 10;
    if (args.resolvedSide.role === 'over') {
      const winRow: PreviewOutcome = {
        condition: `Combined score ${Math.floor(threshold) + 1} or more`,
        result: 'win',
        payoutUSDC: winPayout,
      };
      if (integerLine) {
        return [
          winRow,
          {
            condition: `Combined score exactly ${threshold}`,
            result: 'push',
            payoutUSDC: pushPayout,
          },
          {
            condition: `Combined score ${Math.floor(threshold) - 1} or fewer`,
            result: 'lose',
            payoutUSDC: losePayout,
          },
        ];
      }
      return [
        winRow,
        {
          condition: `Combined score ${Math.floor(threshold)} or fewer`,
          result: 'lose',
          payoutUSDC: losePayout,
        },
      ];
    }
    // under
    const winRow: PreviewOutcome = {
      condition: integerLine
        ? `Combined score ${threshold - 1} or fewer`
        : `Combined score ${Math.floor(threshold)} or fewer`,
      result: 'win',
      payoutUSDC: winPayout,
    };
    if (integerLine) {
      return [
        winRow,
        {
          condition: `Combined score exactly ${threshold}`,
          result: 'push',
          payoutUSDC: pushPayout,
        },
        {
          condition: `Combined score ${threshold + 1} or more`,
          result: 'lose',
          payoutUSDC: losePayout,
        },
      ];
    }
    // half-point under: "≤ floor(threshold) → win", "> threshold → lose"
    void totalDecimal;
    return [
      winRow,
      {
        condition: `Combined score ${Math.ceil(threshold)} or more`,
        result: 'lose',
        payoutUSDC: losePayout,
      },
    ];
  }

  // Spread.
  return buildSpreadOutcomes(args, winPayout, losePayout, pushPayout);
}

function otherTeam(args: BuildSubmitPreviewArgs): string {
  return args.resolvedSide.role === 'away' ? args.homeTeam : args.awayTeam;
}

function buildSpreadOutcomes(
  args: BuildSubmitPreviewArgs,
  winPayout: string,
  losePayout: string,
  pushPayout: string,
): PreviewOutcome[] {
  const integerLine = pushPossible('spread', args.lineTicks);
  // Selected-side line ticks (positive = underdog; negative = favored)
  const selectedTicks =
    args.resolvedSide.role === 'away' ? args.lineTicks : -args.lineTicks;
  // line magnitude in points (e.g. 35 → 3.5, 30 → 3)
  const points = Math.abs(selectedTicks) / 10;
  const team = args.resolvedSide.resolvedLabel;
  const opp = otherTeam(args);

  if (selectedTicks < 0) {
    // Selected team is favored by `points`. Win = team wins by > points.
    if (integerLine) {
      // Exact `points` is a push.
      return [
        {
          condition: `${team} wins by ${points + 1} or more`,
          result: 'win',
          payoutUSDC: winPayout,
        },
        {
          condition: `${team} wins by exactly ${points}`,
          result: 'push',
          payoutUSDC: pushPayout,
        },
        {
          condition: `${team} wins by ${points - 1} or fewer, OR ${team} loses`,
          result: 'lose',
          payoutUSDC: losePayout,
        },
      ];
    }
    // Half-point favored: e.g. -3.5 → win by 4+, otherwise lose.
    return [
      {
        condition: `${team} wins by ${Math.ceil(points)} or more`,
        result: 'win',
        payoutUSDC: winPayout,
      },
      {
        condition: `${team} wins by ${Math.floor(points)} or fewer, OR ${team} loses`,
        result: 'lose',
        payoutUSDC: losePayout,
      },
    ];
  }
  if (selectedTicks > 0) {
    // Selected team is underdog by `points`. Win = team wins OR loses by < points.
    if (integerLine) {
      return [
        {
          condition: `${team} wins, OR ${team} loses by ${points - 1} or fewer`,
          result: 'win',
          payoutUSDC: winPayout,
        },
        {
          condition: `${team} loses by exactly ${points}`,
          result: 'push',
          payoutUSDC: pushPayout,
        },
        {
          condition: `${team} loses by ${points + 1} or more`,
          result: 'lose',
          payoutUSDC: losePayout,
        },
      ];
    }
    return [
      {
        condition: `${team} wins, OR ${team} loses by ${Math.floor(points)} or fewer`,
        result: 'win',
        payoutUSDC: winPayout,
      },
      {
        condition: `${team} loses by ${Math.ceil(points)} or more`,
        result: 'lose',
        payoutUSDC: losePayout,
      },
    ];
  }
  // selectedTicks === 0 — pick'em (rare for spread). Same shape as moneyline.
  return [
    {
      condition: `${team} wins`,
      result: 'win',
      payoutUSDC: winPayout,
    },
    {
      condition: `${opp} wins`,
      result: 'lose',
      payoutUSDC: losePayout,
    },
  ];
}
