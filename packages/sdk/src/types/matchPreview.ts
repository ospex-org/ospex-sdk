/**
 * Public types for the match-flow preview model. Parallels
 * `SubmitPreview` (see `preview.ts`) but adapted for the taker side:
 * the maker has already signed; the taker submits a tx that references
 * the maker's signed payload, so there is no `raw` EIP-712 block here.
 *
 * Differences from `SubmitPreview`:
 *   - No `raw` block (taker doesn't sign EIP-712).
 *   - `nonceInvalidated` and `isLive` snapshots — surface the
 *     prepare→submit race so callers can spot a row that was cancelled
 *     while they were looking at it.
 *   - Both maker- and taker-perspective odds, and (for spread) both
 *     line displays.
 *   - `speculation.lazyCreation` block exposing the on-chain fee split
 *     when this match would create the speculation.
 *
 * Wire safety: every numeric field that may exceed Number.MAX_SAFE_INTEGER
 * is a decimal string (e.g. `riskWei6: '1000000'`). USDC formatted
 * strings (`takerRiskUSDC: '1.000000'`) are produced via
 * `wei6ToDecimalUSDC`.
 *
 * Most of them carry a paired integer: `<name>USDC` ↔ `<name>Wei6`, and
 * inside `you` / `counterparty` the pair is `{ wei6, usdc }` on the same
 * object. **Decode those with `BigInt(...)`** — exact, never throws.
 *
 * Three fields have NO paired integer IN THIS ENVELOPE (pinned by
 * `usdc-field-pairing.test.ts`; `SubmitPreview` has a different, larger
 * set — do not treat this list as global):
 *   - `economics.takerProfitOnWinUSDC` — read `you.profit.wei6`, which
 *     equals `economics.fillMakerRiskWei6`.
 *   - `economics.takerReturnOnWinUSDC` — read `you.totalReturn.wei6`,
 *     which equals `takerRiskWei6 + fillMakerRiskWei6`.
 *     (Use the integer source rather than parsing. `SubmitPreview`'s
 *     equivalents can legitimately be `'0.000000'`, which no parser
 *     accepts; sourcing the integer is sign-agnostic and cannot rot.)
 *   - `outcomes[].payoutUSDC` — SIGNED per row: `'win'` / `'push'` rows
 *     are positive and parse, while a `'lose'` row is the negated risk
 *     (e.g. `'-7.700000'`) and NEITHER parser accepts it. Strip the sign
 *     yourself, or derive it from the perspective's unsigned `risk.wei6` /
 *     `profit.wei6`.
 *
 * Do not assume any decimal string parses: `wei6ToDecimalUSDC` is total,
 * but the SDK's parsers validate user-supplied input and accept POSITIVE
 * amounts only — `speculation.creationFee.*USDC` is `'0.000000'` whenever
 * the speculation already exists. Reserve `usdcDecimalToAmountWei6` for
 * amounts a human or agent typed. (`usdcDecimalToWei6` is narrower still:
 * it also enforces the maker's 100-wei6 lot rule, which a taker-side
 * amount need not satisfy.)
 */

import type { PublicVisibleCommitment } from './commitment.js';
import type { MarketType } from './odds.js';
import type {
  ApprovalPurpose,
  PreviewApproval,
  PreviewCounterparty,
  PreviewOutcome,
  PreviewYou,
  SideRole,
  SpeculationCreationFeeSummary,
} from './preview.js';
import type { Hex } from './signer.js';

// Re-export the approval discriminator for downstream consumers — match
// uses the same `commitment-risk` and `lazy-creation-fee` purposes the
// submit preview does.
export type { ApprovalPurpose, PreviewApproval, SpeculationCreationFeeSummary };

/** A single warning surfaced on the preview block. */
export type MatchPreviewWarning =
  | 'self-match'
  | 'expires-soon'
  | 'expired'
  | 'partial-fill'
  | 'nonce-invalidated'
  | 'maker-treasury-allowance-insufficient';

export interface MatchPreviewContest {
  contestId: string;
  /** "Away @ Home, ISO-date — SPORT". */
  label: string;
  awayTeam: string;
  homeTeam: string;
  awayTeamId: string | null;
  homeTeamId: string | null;
  sport: string;
  /** ISO-8601 string. */
  matchTime: string;
}

export interface MatchPreviewMarket {
  type: MarketType;
  lineTicks: number;
  /**
   * Line as displayed from the maker's side ("Lakers -3.5", "Over 8.5",
   * null for moneyline).
   */
  makerLineDisplay: string | null;
  /**
   * Line as displayed from the taker's side. For spread the
   * perspective inverts ("Lakers -3.5" maker → "Celtics +3.5" taker);
   * for total the over/under flips ("Over 8.5" maker → "Under 8.5"
   * taker); null for moneyline.
   */
  takerLineDisplay: string | null;
}

export interface MatchPreviewSide {
  positionType: 0 | 1;
  /** Resolved team name ("Los Angeles Lakers") or "over"/"under" for total. */
  resolvedLabel: string;
  role: SideRole;
}

/**
 * Maker- AND taker-perspective odds. For a maker price of `+260`
 * (decimal 2.60) the taker is at `-160` (decimal 1.625) — both are
 * useful in the preview because the taker most cares about their own
 * payoff curve.
 */
export interface MatchPreviewOdds {
  /** Canonical maker oddsTick (decimal × 100). */
  oddsTick: number;
  /** "1.91", "2.50". */
  makerDecimal: string;
  /** "+150", "-110". */
  makerAmerican: string;
  /** Taker tick — the symmetric counterparty price. */
  takerOddsTick: number;
  takerDecimal: string;
  takerAmerican: string;
}

export interface MatchPreviewEconomics {
  /** Maker's posted oddsTick. */
  oddsTick: number;
  /** Maker's remaining capacity (= what's left of `riskAmount`). */
  remainingMakerRiskWei6: string;
  remainingMakerRiskUSDC: string;
  /** Taker's desired risk — caller override or full-fill default. */
  takerDesiredRiskWei6: string;
  takerDesiredRiskUSDC: string;
  /** Maker's risk that this match consumes (post lot-size rounding). */
  fillMakerRiskWei6: string;
  fillMakerRiskUSDC: string;
  /** Taker's actual outlay for this match. ALWAYS shown alongside fillMakerRisk. */
  takerRiskWei6: string;
  takerRiskUSDC: string;
  /** Profit if the taker wins (= fillMakerRiskUSDC; zero-vig protocol). */
  takerProfitOnWinUSDC: string;
  /** Total return on win (takerRisk + profit). */
  takerReturnOnWinUSDC: string;
}

export interface MatchPreviewExpiry {
  /** Unix-seconds string. */
  unixSec: string;
  /** ISO-8601, UTC. */
  iso: string;
  /** True iff expiry < now (the contract would revert). */
  expired: boolean;
  /**
   * Minutes until expiry, only when within the "expires soon" window
   * (5 minutes). null otherwise.
   */
  expiresSoonMinutes: number | null;
}

/**
 * The on-chain fee-split path for a lazy speculation. Present only when
 * `speculation.mode === 'lazy'`.
 *
 *   - `totalFeeWei6` — the protocol's `SPECULATION_CREATION_FEE_WEI6`
 *     for the configured chain.
 *   - `takerShareWei6` / `makerShareWei6` — the half-fee each side pays
 *     under `TreasuryModule.processSplitFee`. When `selfMatch === true`
 *     the same wallet pays both halves; `takerShareWei6` carries the
 *     FULL fee in that case (and `makerShareWei6` is 0n on the wire to
 *     avoid double-counting in dashboards). Use `totalFeeWei6` for
 *     "what does this side need approved" by reading
 *     `approvals[].required` instead of summing shares.
 *   - `makerTreasuryAllowanceWei6` / `makerTreasuryAllowanceSufficient`
 *     — current `USDC.allowance(maker, treasuryModule)` and whether
 *     it covers the maker's share. The taker can't fix this; we
 *     surface the warning so the caller can abort before signing.
 */
export interface LazyCreationFee {
  totalFeeWei6: string;
  totalFeeUSDC: string;
  takerShareWei6: string;
  takerShareUSDC: string;
  makerShareWei6: string;
  makerShareUSDC: string;
  makerTreasuryAllowanceWei6: string;
  makerTreasuryAllowanceUSDC: string;
  makerTreasuryAllowanceSufficient: boolean;
}

/**
 * Discriminator for whether this match would create the speculation.
 * `speculationKey` is always present; `speculationId` is null in lazy
 * mode (no on-chain id assigned yet).
 */
export interface MatchPreviewSpeculation {
  mode: 'existing' | 'lazy';
  speculationId: string | null;
  /** keccak256(abi.encode(uint256, address, int32)) per
   * `deriveSpeculationKey`. */
  speculationKey: string;
  /**
   * Always-present canonical agent-facing creation-fee summary.
   * Existing-mode emits zeros + `applies:false` + `condition:'never'`;
   * lazy-mode emits the on-chain split plus `viewerShare*` (self-match
   * aware), `spender*`, `approvalNeeded`. See
   * `SpeculationCreationFeeSummary` for the full contract.
   */
  creationFee: SpeculationCreationFeeSummary;
  /**
   * Legacy lazy-only block — kept for backwards compatibility with
   * consumers built before the symmetric `creationFee` field landed.
   * Adds `makerTreasuryAllowance*` data that `creationFee` deliberately
   * does not carry (it's a lazy-only diagnostic, not a fee-semantic
   * concern). Still present iff `mode === 'lazy'`.
   *
   * @deprecated Prefer `creationFee` for agent-safe fee semantics. The
   * maker-allowance diagnostic remains accessible via this field and via
   * the `'maker-treasury-allowance-insufficient'` entry in `warnings`.
   */
  lazyCreation?: LazyCreationFee;
}

/**
 * The full match preview. Contains everything the renderer needs to
 * display the block AND everything `matchFromPreview` needs to send the
 * tx without re-fetching for non-revalidation purposes.
 */
export interface MatchPreview {
  /** Lock the contract early so future-language agents have a stable hook. */
  schemaVersion: 1;
  /**
   * Maker commitment as fetched from the API (with `isLive` derived).
   * Always a {@link PublicVisibleCommitment} — `prepareMatch` and
   * `matchFromPreview` refuse to operate on a redacted hidden body via
   * `requireVisibleCommitment`, so the matchable payload (signature, nonce,
   * oddsTick, etc.) is guaranteed present here.
   */
  commitment: PublicVisibleCommitment;
  /** Configured chain id — must match the client at execute time. */
  chainId: number;
  /** MatchingModule address — must match the client at execute time. */
  verifyingContract: Hex;
  maker: Hex;
  taker: Hex;
  /** True iff `maker.toLowerCase() === taker.toLowerCase()`. */
  selfMatch: boolean;
  contest: MatchPreviewContest;
  market: MatchPreviewMarket;
  makerSide: MatchPreviewSide;
  takerSide: MatchPreviewSide;
  odds: MatchPreviewOdds;
  economics: MatchPreviewEconomics;
  expiry: MatchPreviewExpiry;
  speculation: MatchPreviewSpeculation;
  /**
   * Approvals required by the taker. Always one row for PositionModule
   * (`commitment-risk`); a second row for TreasuryModule
   * (`lazy-creation-fee`) when `speculation.mode === 'lazy'`.
   */
  approvals: PreviewApproval[];
  /** Snapshot of the row's `nonceInvalidated` flag at fetch time. */
  nonceInvalidated: boolean;
  /** Snapshot of the row's `isLive` predicate at fetch time. */
  isLive: boolean;
  warnings: MatchPreviewWarning[];
  /**
   * Taker-perspective (you) view of this commitment. Populated by
   * builders shipped after the perspective-view addition; agents
   * should treat the field as optional and fall back to the legacy
   * `takerSide` / `odds` / `economics` fields via
   * `computeMatchYouView` for mixed-version compatibility.
   */
  you?: PreviewYou;
  /**
   * Maker counterparty. `address` is always non-null on a match
   * preview (the maker has signed). The field is typed nullable on
   * `PreviewCounterparty` for shape uniformity with `SubmitPreview`.
   */
  counterparty?: PreviewCounterparty;
  /**
   * Win / lose / push outcomes from the viewer's (taker) perspective.
   * Mirrors the existing `SubmitPreview.outcomes` block so both
   * previews share the same downstream rendering surface.
   */
  outcomes?: PreviewOutcome[];
  /**
   * Coarse action tag in operator/agent vocabulary:
   *
   *   'trade-only' — speculation exists at preview time; tx records a
   *     position fill only, no creation fee.
   *   'trade-and-create-speculation' — speculation does NOT yet exist
   *     at preview time; tx would record the position fill AND create
   *     the speculation, pulling the fee. NOT a guarantee — another
   *     match may create the speculation first, in which case the
   *     action collapses back to trade-only at execution time.
   *
   * Always present. Redundant with `speculation.mode` but stated in
   * the operator vocabulary an agent uses to reason about the
   * transaction, rather than the protocol's `lazy`/`existing` jargon.
   */
  tradeAction: 'trade-only' | 'trade-and-create-speculation';
}

/**
 * @deprecated Legacy pre-v2 wire type. The CLI's `commitments match --json`
 * now emits a v2 `AgentEnvelope` (`stage: 'preview'`, `payload: MatchPreview`) —
 * see `docs/AGENT_CONTRACT.md`. Retained (exported) for back-compat only; it is
 * NOT the current `--json` shape.
 */
export interface MatchPreviewEnvelope {
  schemaVersion: 1;
  preview: MatchPreview;
}

/**
 * @deprecated Legacy pre-v2 wire type. The CLI's `commitments match --yes --json`
 * now emits a v2 `AgentEnvelope` (`stage: 'execute'`, `payload: { preview, result,
 * fillability }`) — see `docs/AGENT_CONTRACT.md`. Retained (exported) for back-compat
 * only; it is NOT the current `--json` shape (it omits `fillability` and the v2 shoulder).
 */
export interface MatchJsonResult {
  schemaVersion: 1;
  preview: MatchPreview;
  result: {
    txHash: Hex;
    /** 'success' | 'reverted' from the receipt. */
    status: 'success' | 'reverted';
    blockNumber: string;
    takerRiskWei6: string;
    fillMakerRiskWei6: string;
  };
}

/**
 * Pure-compute input to `buildMatchPreview`. The orchestrator
 * (`prepareMatch`) is responsible for fetching the commitment, contest
 * detail, allowances, and speculation existence; this builder runs
 * only the deterministic transform.
 *
 * `bigint` types here are wei6 / odds units from the orchestrator;
 * the public `MatchPreview` carries them as decimal strings for JSON
 * safety.
 */
export interface BuildMatchPreviewArgs {
  /** Already-fetched (with `isLive` derived). Visible-only — see {@link MatchPreview.commitment}. */
  commitment: PublicVisibleCommitment;
  chainId: number;
  matchingModuleAddress: Hex;
  taker: Hex;
  /** Caller's optional override; full-fill if undefined. */
  takerDesiredRiskWei6?: bigint;
  /** Pre-fetched contest fields needed for the label + side resolution. */
  awayTeam: string;
  homeTeam: string;
  awayTeamId: string | null;
  homeTeamId: string | null;
  sport: string;
  /** ISO-8601. */
  matchTime: string;
  /** Pre-determined speculation existence (orchestrator's job). */
  speculation:
    | { mode: 'existing'; speculationId: string }
    | { mode: 'lazy' };
  /** keccak256(abi.encode(uint256, address, int32)) — same on both modes. */
  speculationKey: Hex;
  /**
   * Lazy-only: the protocol's per-chain
   * SPECULATION_CREATION_FEE_WEI6 (the total split). Ignored in
   * existing mode. Setting to 0n disables the lazy approval row in
   * tests / future chains where the fee is configured off.
   */
  speculationCreationTotalFeeWei6: bigint;
  /**
   * Lazy-only: current `USDC.allowance(taker, treasuryModule)` —
   * informs the lazy-creation-fee approval row's `current` field.
   * Ignored in existing mode.
   */
  takerTreasuryAllowanceWei6: bigint;
  /**
   * Lazy-only: current `USDC.allowance(maker, treasuryModule)` —
   * informs the maker-allowance warning. Ignored in existing mode.
   */
  makerTreasuryAllowanceWei6: bigint;
  /** TreasuryModule address — informs the lazy approval row's spender. */
  treasuryModuleAddress: Hex;
  /** PositionModule address — informs the commitment-risk row's spender. */
  positionModuleAddress: Hex;
  /** Current `USDC.allowance(taker, positionModule)`. */
  takerPositionAllowanceWei6: bigint;
  /** Caller-controlled "now" for expiry warnings — defaults to Date.now(). */
  nowUnixSec?: bigint;
  /**
   * Threshold under which the `expires-soon` warning fires. Default 5
   * minutes; tests can override.
   */
  expiresSoonThresholdSec?: bigint;
}
