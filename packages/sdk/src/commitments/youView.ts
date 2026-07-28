/**
 * Forward-compatible accessors for the agent-facing "you / counterparty
 * / outcomes" view on `MatchPreview` and `SubmitPreview`.
 *
 * Agents that read the JSON envelope on a recent SDK build get the
 * fields populated directly (`preview.you`, `preview.counterparty`,
 * `preview.outcomes`). For envelopes produced by an older SDK build —
 * before the perspective-view addition — these fields are absent. The
 * helpers in this file backfill them from the legacy maker/taker
 * blocks (`makerSide`, `takerSide`, `odds`, `economics`) so an agent
 * handling a mixed-version stream sees a single shape.
 *
 * Both helpers are pure (no I/O, no state) and throw
 * `OspexValidationError` only when a legacy field a backfill depends
 * on is missing/corrupt — the "first build the view, then claim it
 * never throws" guarantee is bounded by the envelope being a valid
 * preview to begin with.
 */

import { OspexValidationError } from '../errors.js';
import type { MatchPreview } from '../types/matchPreview.js';
import type {
  PreviewCounterparty,
  PreviewOutcome,
  PreviewYou,
  SubmitPreview,
} from '../types/preview.js';
import {
  buildPreviewCounterparty,
  buildPreviewYou,
  inverseOddsTick,
} from './perspectiveView.js';
import { buildPreviewOutcomes } from './outcomeView.js';
import { usdcDecimalToAmountWei6 } from './decimals.js';

export interface MatchYouView {
  you: PreviewYou;
  counterparty: PreviewCounterparty;
  outcomes: PreviewOutcome[];
}

/**
 * Resolve the taker-perspective view of a `MatchPreview`. Returns
 * `preview.you` / `preview.counterparty` / `preview.outcomes`
 * directly when present; otherwise backfills from the legacy
 * `makerSide` / `takerSide` / `odds` / `economics` fields so the
 * caller never has to branch on SDK version.
 */
export function computeMatchYouView(preview: MatchPreview): MatchYouView {
  if (
    preview.you !== undefined &&
    preview.counterparty !== undefined &&
    preview.outcomes !== undefined
  ) {
    return {
      you: preview.you,
      counterparty: preview.counterparty,
      outcomes: preview.outcomes,
    };
  }

  // Backfill path. All four legacy blocks must be present on a valid
  // MatchPreview; if not, the envelope itself is corrupt and we
  // surface that as a typed error rather than guessing.
  const { commitment, makerSide, takerSide, odds, economics, market, contest } =
    preview;
  if (
    commitment.marketType === null ||
    commitment.lineTicks === null ||
    commitment.positionType === null
  ) {
    throw new OspexValidationError(
      `computeMatchYouView: commitment ${commitment.commitmentHash} is missing required market/positionType/line for backfill.`,
    );
  }

  const you = buildPreviewYou({
    role: 'taker',
    address: preview.taker,
    market: commitment.marketType,
    positionType: takerSide.positionType,
    lineTicks: commitment.lineTicks,
    oddsTick: odds.takerOddsTick,
    riskWei6: BigInt(economics.takerRiskWei6),
    profitWei6: BigInt(economics.fillMakerRiskWei6),
    awayTeam: contest.awayTeam,
    homeTeam: contest.homeTeam,
  });

  const counterparty = buildPreviewCounterparty({
    role: 'maker',
    address: preview.maker,
    market: commitment.marketType,
    positionType: makerSide.positionType,
    lineTicks: commitment.lineTicks,
    oddsTick: odds.oddsTick,
    riskWei6: BigInt(economics.fillMakerRiskWei6),
    profitWei6: BigInt(economics.takerRiskWei6),
    awayTeam: contest.awayTeam,
    homeTeam: contest.homeTeam,
  });

  const outcomes = buildPreviewOutcomes({
    market: commitment.marketType,
    lineTicks: commitment.lineTicks,
    riskWei6: BigInt(economics.takerRiskWei6),
    profitWei6: BigInt(economics.fillMakerRiskWei6),
    resolvedSide: {
      role: takerSide.role,
      resolvedLabel: takerSide.resolvedLabel,
    },
    awayTeam: contest.awayTeam,
    homeTeam: contest.homeTeam,
  });

  void market;
  // `inverseOddsTick` import is for the SubmitYouView backfill below;
  // referenced here to keep the import live for downstream consumers
  // that re-export from this module's barrel slot.
  void inverseOddsTick;

  return { you, counterparty, outcomes };
}

export interface SubmitYouView {
  you: PreviewYou;
  counterparty: PreviewCounterparty;
  outcomes: PreviewOutcome[];
}

/**
 * Resolve the maker-perspective view of a `SubmitPreview`. Returns
 * `preview.you` / `preview.counterparty` directly when present (and
 * the always-populated `preview.outcomes`); otherwise backfills from
 * the legacy `side` / `economics` fields.
 *
 * Exported from the same module as its match-side sibling so the
 * symmetric API surface is one import for downstream agents.
 */
export function computeSubmitYouView(preview: SubmitPreview): SubmitYouView {
  if (preview.you !== undefined && preview.counterparty !== undefined) {
    return {
      you: preview.you,
      counterparty: preview.counterparty,
      outcomes: preview.outcomes,
    };
  }

  const riskWei6 = BigInt(preview.economics.riskWei6);
  const oddsTick = preview.economics.oddsTick;
  // profit = risk × (oddsTick − 100) / 100. BigInt floor-division mirrors
  // the existing math in buildSubmitPreview.
  const profitWei6 = (riskWei6 * BigInt(oddsTick - 100)) / 100n;
  const takerTick = inverseOddsTick(oddsTick);
  // Hypothetical counterparty's risk = profitWei6 (zero-vig protocol).
  const counterpartyRiskWei6 = profitWei6;

  // Cross-check: the existing envelope publishes counterpartyRiskUSDC
  // as a decimal string. We re-derive the wei6 form via integer math
  // above; verify the two paths agree to catch any silent drift.
  //
  // The counterparty's risk is a TAKER-side value — it carries no lot
  // rule, and sub-lot values are routine (at riskWei6=100n, oddsTick=101
  // it is "0.000001"). Parsing it with the maker-risk parser threw on
  // every one of those, and the try/catch added to compensate swallowed
  // the drift error too — both are OspexValidationError — so this check
  // could never actually fire. The right parser removes the need for it.
  const fromString = usdcDecimalToAmountWei6(preview.economics.counterpartyRiskUSDC);
  if (fromString !== counterpartyRiskWei6) {
    throw new OspexValidationError(
      `computeSubmitYouView: counterpartyRiskUSDC=${preview.economics.counterpartyRiskUSDC} disagrees with the BigInt-derived value (${counterpartyRiskWei6}).`,
    );
  }

  const you = buildPreviewYou({
    role: 'maker',
    address: preview.raw.maker as `0x${string}`,
    market: preview.market.type,
    positionType: preview.side.positionType,
    lineTicks: preview.market.lineTicks,
    oddsTick,
    riskWei6,
    profitWei6,
    awayTeam: preview.contest.awayTeam,
    homeTeam: preview.contest.homeTeam,
  });
  const counterparty = buildPreviewCounterparty({
    role: 'taker',
    address: null,
    market: preview.market.type,
    positionType: preview.side.positionType === 0 ? 1 : 0,
    lineTicks: preview.market.lineTicks,
    oddsTick: takerTick,
    riskWei6: counterpartyRiskWei6,
    profitWei6: riskWei6, // zero-vig: counterparty wins ← maker's risk
    awayTeam: preview.contest.awayTeam,
    homeTeam: preview.contest.homeTeam,
  });

  return {
    you,
    counterparty,
    outcomes: preview.outcomes,
  };
}
