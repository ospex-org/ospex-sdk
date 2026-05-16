/**
 * Pure outcome-generation helper shared by `buildSubmitPreview`
 * (maker perspective) and `buildMatchPreview` (taker perspective).
 *
 * Given a side resolution (role + label), the market type, line ticks,
 * and the perspective's risk + profit, emit the win/lose/push rows for
 * the preview's `outcomes[]` block. The push rules mirror
 * `pushPossible.ts` and the protocol's spread/total settlement
 * semantics:
 *
 *   - moneyline: no push, two rows.
 *   - spread:    three rows on an integer line (push when final margin
 *                exactly equals the line), two otherwise.
 *   - total:     three rows on an integer line (push when combined
 *                score exactly equals the line), two otherwise.
 *
 * The condition strings are written from the selected-side perspective
 * so the same generator produces natural-reading text whether called
 * with the maker's resolution (for submit) or the taker's resolution
 * (for match — taker role is the maker's role, inverted).
 */

import { pushPossible } from './pushPossible.js';
import type { MarketType } from '../types/odds.js';
import type { PreviewOutcome, SideRole } from '../types/preview.js';
import { wei6ToDecimalUSDC } from './decimals.js';

export interface BuildOutcomesArgs {
  market: MarketType;
  /** Stored away-perspective line ticks. */
  lineTicks: number;
  /** This perspective's risk in wei6. Negated on lose rows. */
  riskWei6: bigint;
  /** This perspective's profit in wei6. */
  profitWei6: bigint;
  /** The side this perspective is backing — role + display label. */
  resolvedSide: {
    role: SideRole;
    /** Bare team name for moneyline/spread; "over"/"under" for total. */
    resolvedLabel: string;
  };
  /** Contest's away team name. Used for the "other team wins" condition. */
  awayTeam: string;
  /** Contest's home team name. */
  homeTeam: string;
}

/**
 * Mirror of `buildSubmitPreview`'s internal `buildOutcomes`, extracted
 * so `buildMatchPreview` can call it for the taker perspective without
 * a third copy of the conditional-payout grid.
 */
export function buildPreviewOutcomes(args: BuildOutcomesArgs): PreviewOutcome[] {
  const winPayout = wei6ToDecimalUSDC(args.profitWei6);
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

function otherTeam(args: BuildOutcomesArgs): string {
  return args.resolvedSide.role === 'away' ? args.homeTeam : args.awayTeam;
}

function buildSpreadOutcomes(
  args: BuildOutcomesArgs,
  winPayout: string,
  losePayout: string,
  pushPayout: string,
): PreviewOutcome[] {
  const integerLine = pushPossible('spread', args.lineTicks);
  const selectedTicks =
    args.resolvedSide.role === 'away' ? args.lineTicks : -args.lineTicks;
  const points = Math.abs(selectedTicks) / 10;
  const team = args.resolvedSide.resolvedLabel;
  const opp = otherTeam(args);

  if (selectedTicks < 0) {
    if (integerLine) {
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
  // selectedTicks === 0 — pick'em spread. Three-row outcome including the
  // protocol-defined tie/push, never collapsed to the moneyline shape.
  return [
    {
      condition: `${team} wins`,
      result: 'win',
      payoutUSDC: winPayout,
    },
    {
      condition: `${team} and ${opp} tie (final margin 0)`,
      result: 'push',
      payoutUSDC: pushPayout,
    },
    {
      condition: `${opp} wins`,
      result: 'lose',
      payoutUSDC: losePayout,
    },
  ];
}
