/**
 * Public types for the resolver-layer preview model. The CLI renders
 * pretty text from `SubmitPreview`; `--json` emits the envelope; tests
 * assert against the structured shape; future agents in other languages
 * consume the same JSON contract via `schemaVersion`.
 *
 * Lock the contract early — once market-maker bots start consuming
 * the JSON output, the schema is part of the public SDK surface.
 * Drift is policed by `schemaVersion: 1` and the agent integration
 * contract in `docs/AGENT_CONTRACT.md`.
 */

import type { MarketType } from './odds.js';
import type { SubmitResult } from '../commitments/submitRaw.js';

/** How the resolver matched the user's `--side` input. */
export type ResolutionSource = 'exact' | 'nickname' | 'alias' | 'over' | 'under';

/** Which entity the resolved side maps to on the speculation. */
export type SideRole = 'away' | 'home' | 'over' | 'under';

/**
 * Always-present, agent-facing summary of the speculation creation fee
 * for a single preview (submit or match). Answers the six core
 * questions in one block without forcing consumers to inspect
 * `approvals[]`, decode protocol vocabulary, or sum role shares.
 *
 * Symmetric across modes: existing-mode emits zeros + `applies:false` +
 * `condition:'never'` so an agent's branch is "read one field, act"
 * instead of "infer absence of fields." Lazy-mode emits the on-chain
 * fee split + the viewer's actual wallet exposure (self-match-aware).
 *
 * See `MatchPreviewSpeculation.creationFee` and the lazy `SpeculationMode`
 * branch's `creationFee` for wiring; emitted unconditionally by
 * `buildSubmitPreview` and `buildMatchPreview`.
 */
export interface SpeculationCreationFeeSummary {
  /**
   * Does a creation fee apply on this tx?
   *
   *   false — speculation already exists; no fee under any circumstance.
   *   true  — speculation does not yet exist AT PREVIEW TIME, so this
   *           tx would trigger lazy creation and pull the fee IF it is
   *           still the first match on the speculationKey at execution
   *           time. NOT a guarantee — another tx may create the
   *           speculation first, in which case no fee is pulled.
   */
  applies: boolean;
  /**
   *   'never' — `applies===false`; the speculation is already created.
   *   'if-first-match-at-execution' — `applies===true`; fee is pulled
   *     IFF this tx is still the first match when it lands. If a prior
   *     match creates the speculation first, the fee is not charged.
   */
  condition: 'never' | 'if-first-match-at-execution';
  /** Full fee in wei6. `"0"` when `applies===false`. */
  totalFeeWei6: string;
  totalFeeUSDC: string;
  /** Taker's role-based share. `"0"` when `applies===false`. */
  takerShareWei6: string;
  takerShareUSDC: string;
  /** Maker's role-based share. `"0"` when `applies===false`. */
  makerShareWei6: string;
  makerShareUSDC: string;
  /**
   * What THIS wallet (the viewer) actually pays. Collapses self-match
   * doubling automatically: on a match preview the viewer is the
   * taker, and on self-match `viewerShare === totalFee` (the single
   * wallet pays both role shares). On a submit preview the viewer is
   * the maker and `viewerShare === makerShare` (no self-match concept
   * yet — no taker has signed). `"0"` when `applies===false`.
   */
  viewerShareWei6: string;
  viewerShareUSDC: string;
  /** TreasuryModule address when `applies===true`; null otherwise. */
  spender: `0x${string}` | null;
  /** Symbolic spender name — saves agents an address-book lookup. */
  spenderLabel: 'TreasuryModule' | null;
  /** Approval-row discriminator; null when `applies===false`. */
  approvalPurpose: 'lazy-creation-fee' | null;
  /**
   * Does the viewer's current TreasuryModule allowance need to be
   * raised before signing? Equivalent to `approvals[].needsApproval`
   * for `purpose === 'lazy-creation-fee'` (computed against
   * `viewerShare`, not the role share — accounts for self-match).
   * Always `false` when `applies===false`.
   */
  approvalNeeded: boolean;
  /** Human-readable one-liner — see render copy in `matchPreviewRender.ts`. */
  note: string;
}

/** Discriminator for speculation existence at preview time. */
export type SpeculationMode =
  | {
      mode: 'existing';
      speculationId: string;
      /**
       * Always-present canonical agent-facing fee summary. On existing
       * mode every numeric field is `"0"`, `applies===false`,
       * `condition==='never'`, `spender===null`. See
       * `SpeculationCreationFeeSummary` for the full contract.
       */
      creationFee: SpeculationCreationFeeSummary;
    }
  | {
      mode: 'lazy';
      speculationId: null;
      speculationKey: string;
      /**
       * The maker's share of the speculation creation fee — paid ONLY
       * if this commitment turns out to be the first match on the
       * `speculationKey` (i.e., this match is what triggers lazy
       * creation). Formatted decimal USDC string (`"0.250000"`); see
       * `SPECULATION_CREATION_FEE_MAKER_SHARE_WEI6` for the source
       * value, and `TreasuryModule.processSplitFee` for the split
       * mechanic. If the speculation already exists at match time
       * (someone else triggered creation), no fee is charged.
       *
       * The fee is pulled from the maker's `TreasuryModule` allowance
       * — a different spender from the `riskAmount` (which goes to
       * `PositionModule`). The CLI surfaces this in the preview so
       * the maker isn't surprised by a +0.25 USDC charge at match
       * time. The match-side preview includes a separate
       * `lazy-creation-fee` approval row (and a
       * `maker-treasury-allowance-insufficient` warning when the
       * maker's TreasuryModule allowance is short), so a taker can
       * abort before signing rather than wait for an on-chain revert.
       *
       * @deprecated Prefer `creationFee.makerShareUSDC` for
       * agent-safe fee semantics. Retained for backwards compatibility
       * with earlier lazy-only consumers.
       */
      makerCreationFeeUSDC: string;
      /**
       * Always-present canonical fee summary. On a SubmitPreview the
       * viewer is the maker, so `viewerShare === makerShare`.
       */
      creationFee: SpeculationCreationFeeSummary;
    };

/** Three-valued outcome result on a single condition row. */
export type OutcomeResult = 'win' | 'lose' | 'push';

/**
 * How `expiry` was determined. Visible in the preview and `--json`
 * output so consumers (and humans glancing at the preview block) can
 * tell at a glance whether the value came from the user, the contest's
 * scheduled match time, or a fallback path.
 *
 *   - 'default-match-time'           — user did not pass --expiry; we
 *                                       defaulted to the contest's
 *                                       scheduled match time exactly.
 *                                       (Pregame commitments expire at
 *                                       tip-off by default — protects
 *                                       users from stale pregame odds
 *                                       being filled after start.)
 *   - 'missing-match-time-fallback'  — user did not pass --expiry AND
 *                                       contest.matchTime was missing /
 *                                       invalid, so we fell back to
 *                                       now + 1h. Loud annotation so
 *                                       the user notices.
 *   - 'user-iso'                     — user passed an ISO-8601 / RFC3339
 *                                       string (e.g. '2026-05-09T20:00:00Z').
 *   - 'user-unix'                    — user passed a unix-seconds value.
 *   - 'user-relative'                — user passed a duration string
 *                                       like '30m', '4h', '1d', '1w';
 *                                       expiry = now + duration.
 */
export type ExpirySource =
  | 'default-match-time'
  | 'missing-match-time-fallback'
  | 'user-iso'
  | 'user-unix'
  | 'user-relative';

/**
 * Provenance + safety metadata for the canonical signed expiry. The
 * signed value lives in `PreviewRaw.expiry` (string unix-sec); this
 * block carries the metadata the renderer / `--json` consumers need
 * to surface it back to the user.
 */
export interface PreviewExpiry {
  /** Canonical signed value as unix-seconds string (mirrors raw.expiry). */
  unixSec: string;
  /** Human-readable ISO-8601 form (UTC, e.g. '2026-05-09T20:00:00Z'). */
  iso: string;
  source: ExpirySource;
  /**
   * True if the chosen expiry is strictly later than the contest's
   * scheduled match time. The default (`source = default-match-time`)
   * sets expiry to matchTime exactly, so this is false in the default
   * case. It can only be true when the user explicitly opted in to a
   * post-start expiry — live-betting exposure is intentional. The CLI
   * renderer surfaces a warning line in this case.
   */
  afterMatchTime: boolean;
  /**
   * Contest's scheduled match time as unix-seconds string. Null when
   * the contest had no matchTime (in which case `source` is
   * `missing-match-time-fallback`). Useful for the
   * `expiry > matchTime` UI computation.
   */
  matchTimeUnixSec: string | null;
}

/** What the user is risking + receiving + the protocol-level numerics. */
export interface PreviewEconomics {
  oddsTick: number;
  /** Decimal odds string with 2 fractional digits (e.g. "1.91", "2.50"). */
  oddsDecimal: string;
  /**
   * American odds string with explicit sign (e.g. "+150", "-110").
   * Derived from `oddsTick`. For oddsTick = 200 (decimal 2.00, even
   * money) the canonical rendering is "+100". Negative-American values
   * are rounded via the same 2dp precision the protocol uses; round-
   * trip from American input may surface a different American display
   * if the input wasn't 2dp-clean (e.g. "-113" → tick 188 → "-114").
   */
  oddsAmerican: string;
  /** wei6 (USDC * 10^6) as a decimal string for JSON safety. */
  riskWei6: string;
  /** Formatted USDC string with 6 decimal places, e.g. "1.000000". */
  riskUSDC: string;
  /** Formatted USDC. */
  profitUSDC: string;
  /** risk + profit. */
  returnUSDC: string;
  /**
   * Risk a counterparty would have to commit to take the other side
   * of this commitment in full. Useful for market-maker context.
   */
  counterpartyRiskUSDC: string;
}

/**
 * The full EIP-712 OspexCommitment message — what `submitPrepared`
 * signs. Adding a field here is a wire-protocol change; review against
 * `MatchingModule.sol`'s typed-data definition before extending.
 */
export interface PreviewRaw {
  maker: string;
  chainId: number;
  verifyingContract: string;
  contestId: string;
  scorer: string;
  lineTicks: number;
  positionType: 0 | 1;
  oddsTick: number;
  /** wei6 as decimal string. */
  riskAmount: string;
  /** unix seconds as decimal string. */
  expiry: string;
  /** bigint as decimal string. */
  nonce: string;
  /** keccak256(abi.encode(uint256 contestId, address scorer, int32 lineTicks)). */
  speculationKey: string;
}

/**
 * Discriminator for what an approval is FOR. The CLI uses this to
 * dispatch to the correct SDK approve method (`approve` for
 * commitment-risk, `approveCreationFee` for the lazy-creation-fee row)
 * and to label the row in the renderer. Adding a new value here
 * requires a corresponding case in the CLI's approval-loop dispatcher.
 *
 *   - 'commitment-risk'     — USDC → PositionModule. Always present.
 *   - 'lazy-creation-fee'   — USDC → TreasuryModule. Present only when
 *                             `speculation.mode === 'lazy'` (i.e. the
 *                             maker may pay 0.25 USDC of the protocol
 *                             speculation creation fee at match time).
 */
export type ApprovalPurpose = 'commitment-risk' | 'lazy-creation-fee';

export interface PreviewApproval {
  token: 'USDC';
  spender: string;
  /** wei (token's native decimals) as decimal string. */
  required: string;
  current: string;
  needsApproval: boolean;
  /**
   * Why this approval row exists. Use to label the row in the renderer
   * (the CLI prints "(commitment risk)" / "(lazy creation fee)" after
   * the spender so users running both rows see what each one is for)
   * AND to dispatch to the correct SDK approve method (commitment-risk
   * → `client.commitments.approve`; lazy-creation-fee →
   * `client.commitments.approveCreationFee`). Pre-PR-B preview models
   * had no `purpose` field and only ever produced one row; consumers
   * pinning on the wire shape should treat the field as new and
   * default-handle unknown values.
   */
  purpose: ApprovalPurpose;
}

export interface PreviewOutcome {
  condition: string;
  result: OutcomeResult;
  /**
   * Formatted USDC string. For 'lose' shows the negative risk; for 'push'
   * shows the stake returned.
   *
   * **Signed, and one of three USDC fields with no paired `*Wei6` twin**
   * (the others are `economics.takerProfitOnWinUSDC` and
   * `economics.takerReturnOnWinUSDC`, which are always positive and so do
   * parse). A `'lose'` row is `wei6ToDecimalUSDC(-risk)` — e.g.
   * `'-7.700000'` — which NEITHER `usdcDecimalToAmountWei6` nor
   * `usdcDecimalToWei6` will parse, since both accept positive amounts
   * only. This is the one USDC string in a preview that has no sanctioned
   * decode path: take the sign off it yourself, or derive it from the
   * perspective's `risk.wei6` / `profit.wei6`, which are unsigned and
   * paired.
   */
  payoutUSDC: string;
}

/**
 * Wei6 integer + formatted decimal USDC string, used for every amount
 * surfaced inside the `you` / `counterparty` perspective blocks. The
 * `usdc` form is always 6 fractional digits, produced by
 * `wei6ToDecimalUSDC`.
 *
 * **Decode via `wei6`, not `usdc`** — `BigInt(amount.wei6)` is exact and
 * never throws. The decimal string is for display. If you do parse it,
 * `usdcDecimalToAmountWei6` is the right parser (these are arbitrary USDC
 * amounts, not maker risk — as the `"4.999918"` example below shows, they
 * sit off the 100-wei6 lot grid that `usdcDecimalToWei6` enforces), but it
 * accepts POSITIVE amounts only and so cannot decode every USDC string the
 * SDK emits elsewhere. See `PreviewOutcome.payoutUSDC`.
 */
export interface PerspectiveAmount {
  /** wei6 (USDC × 10^6) as a decimal string, BigInt-safe over JSON. */
  wei6: string;
  /** Formatted decimal USDC with exactly 6 fractional digits, e.g. "4.999918". */
  usdc: string;
}

/** Decimal + American + tick representation of a single perspective's effective odds. */
export interface PerspectiveOdds {
  /** Decimal odds with 2 fractional digits, e.g. "1.65". */
  decimal: string;
  /** Signed American odds, e.g. "-154". */
  american: string;
  /** Decimal × 100. Exposed for sorting / exact arithmetic. */
  oddsTick: number;
}

/**
 * The executing party's perspective. Populated by `buildSubmitPreview`
 * (role: 'maker') and `buildMatchPreview` (role: 'taker'). Marked
 * OPTIONAL in `SubmitPreview` / `MatchPreview` because the field is an
 * additive extension under `schemaVersion: 1`; consumers built against
 * the legacy envelope shape continue to compile. The helper functions
 * `computeMatchYouView` / `computeSubmitYouView` backfill from the
 * legacy fields on previews that predate the addition.
 */
export interface PreviewYou {
  /** Which protocol role the viewer is playing. */
  role: 'maker' | 'taker';
  /** Viewer's wallet (lowercased 0x-hex). */
  address: `0x${string}`;
  /**
   * What the viewer is backing in concise display form. Examples:
   *   moneyline → "Los Angeles Dodgers"
   *   spread    → "Los Angeles Lakers -3.5"
   *   total     → "Over 220.5" / "Under 220.5"
   *
   * Treat as display/readback only. Structured consumers that need the
   * underlying integers should read `role`, `market.type`, and
   * `market.lineTicks` from the parent envelope.
   */
  backing: string;
  /** The viewer's effective odds (already inverted for the taker role). */
  odds: PerspectiveOdds;
  /** What the viewer is risking. */
  risk: PerspectiveAmount;
  /** Profit if the viewer wins. */
  profit: PerspectiveAmount;
  /**
   * risk + profit. Named `totalReturn` (not `return`) so polyglot
   * codegen doesn't trip on the JavaScript reserved word.
   */
  totalReturn: PerspectiveAmount;
}

/**
 * The other party's perspective. Mirrors `PreviewYou` field-for-field
 * with one nullability difference: `address` is `null` on a fresh
 * `SubmitPreview` because no taker has signed yet. On a `MatchPreview`
 * the counterparty is the (signed) maker and the address is known.
 *
 * Optional on the public interfaces for the same reason as `PreviewYou`.
 */
export interface PreviewCounterparty {
  /** Which protocol role the counterparty is playing. */
  role: 'maker' | 'taker';
  /** Counterparty's wallet, or `null` when no counterparty has signed yet (submit-preview hypothetical). */
  address: `0x${string}` | null;
  backing: string;
  odds: PerspectiveOdds;
  /**
   * The counterparty's risk. On `MatchPreview` this is the maker's
   * `fillMakerRisk` (their realized risk against this fill). On
   * `SubmitPreview` this is what a full-fill counterparty would need
   * to risk — equals `economics.counterpartyRiskUSDC` already on the
   * envelope.
   */
  risk: PerspectiveAmount;
  /**
   * Counterparty's profit if they win. Under the zero-vig protocol
   * this always equals the viewer's `risk` (one side's loss is the
   * other side's win).
   */
  profit: PerspectiveAmount;
  /** risk + profit. */
  totalReturn: PerspectiveAmount;
}

export interface PreviewContest {
  contestId: string;
  /** "Away @ Home, ISO-date — SPORT". */
  label: string;
  awayTeam: string;
  homeTeam: string;
  awayTeamId: string | null;
  homeTeamId: string | null;
  sport: string;
  matchTime: string;
}

export interface PreviewMarket {
  type: MarketType;
  speculation: SpeculationMode;
  lineTicks: number;
  /** "Lakers -3.5", "Over 8.5", null for moneyline. */
  displayLine: string | null;
}

export interface PreviewSide {
  input: string;
  resolvedLabel: string;
  positionType: 0 | 1;
  role: SideRole;
  resolutionSource: ResolutionSource;
}

export interface SubmitPreview {
  contest: PreviewContest;
  market: PreviewMarket;
  side: PreviewSide;
  economics: PreviewEconomics;
  /**
   * Provenance + safety metadata for the canonical signed expiry. The
   * raw signed value remains in `raw.expiry`; this block answers
   * "where did that value come from?" + "is it after match start?".
   */
  expiry: PreviewExpiry;
  raw: PreviewRaw;
  approvals: PreviewApproval[];
  outcomes: PreviewOutcome[];
  /**
   * Maker-perspective (you) view of this commitment. Populated by
   * builders shipped after the perspective-view addition; agents
   * should treat the field as optional and fall back to the legacy
   * `side` / `economics` fields via `computeSubmitYouView` for
   * mixed-version compatibility.
   */
  you?: PreviewYou;
  /**
   * Hypothetical taker counterparty. `address` is always `null` on a
   * submit preview because no taker has signed yet.
   */
  counterparty?: PreviewCounterparty;
  /**
   * Coarse action tag in operator/agent vocabulary:
   *
   *   'trade-only' — speculation already exists at preview time; the
   *     match this commitment is eventually filled by will record a
   *     position only, no creation fee.
   *   'trade-and-create-speculation' — speculation does NOT yet exist
   *     at preview time; IF this commitment is the first to be matched,
   *     that match would record the position AND create the
   *     speculation, pulling the creation fee.
   *
   * Always present. Mirrors `market.speculation.mode` but in operator
   * vocabulary. Documents a PREVIEW-TIME view of the expected execution
   * path — another commit can be matched first, in which case the
   * action collapses back to trade-only at execution time.
   */
  submitAction: 'trade-only' | 'trade-and-create-speculation';
}

/**
 * @deprecated Legacy pre-v2 wire type. The CLI's `commitments submit --json`
 * now emits a v2 `AgentEnvelope` (`stage: 'preview'`, `payload: SubmitPreview`) —
 * see `docs/AGENT_CONTRACT.md`. Retained (exported) for back-compat only; it is
 * NOT the current `--json` shape.
 */
export interface SubmitPreviewEnvelope {
  schemaVersion: 1;
  preview: SubmitPreview;
}

/**
 * @deprecated Legacy pre-v2 wire type. The CLI's `commitments submit --yes --json`
 * now emits a v2 `AgentEnvelope` (`stage: 'execute'`, `payload: { preview, result,
 * fundability }`) — see `docs/AGENT_CONTRACT.md`. Retained (exported) for back-compat
 * only; it is NOT the current `--json` shape (it omits `fundability` and the v2 shoulder).
 *
 * `result` is pinned to the **v0.5.0 SubmitResult subset** — `hash` + `commitment` —
 * rather than the live in-memory {@link SubmitResult}. The SDK's `submitRaw` /
 * `submitPrepared` may grow new return fields over time (v0.5.1 added
 * `signedPayload`) that the legacy CLI `--json` runtime path does NOT emit; the
 * `Pick` keeps the wire schema and the typed shape aligned so typed legacy
 * consumers don't see fields the CLI never writes. The current v2
 * `AgentEnvelope` execute payload (`SubmitExecutePayload.result` in
 * `packages/cli/src/commands/commitments/submit.ts`) is independently pinned
 * to the same `{ hash, commitment }` subset by its own literal type — so
 * neither JSON envelope (legacy or v2) carries `signedPayload`. Reach for
 * `signedPayload` (or any future addition) via the in-memory `SubmitResult`
 * returned from the SDK, NOT via either JSON envelope.
 */
export interface SubmitJsonResult {
  schemaVersion: 1;
  preview: SubmitPreview;
  result: Pick<SubmitResult, 'hash' | 'commitment'>;
}

/**
 * Parent selection for the new high-level `commitments submit`.
 *
 * A discriminated union with an explicit `kind` tag instead of two
 * mutually-exclusive optional fields. Trade-offs:
 *
 * - Pro (kept): TypeScript enforces "exactly one of speculation / contest";
 *   pattern matching on `kind` is exhaustive at compile time.
 * - Con: slightly more verbose at call sites — `{ parent: { kind: 'speculation', speculationId: 123 } }`
 *   vs. `{ speculationId: 123 }`.
 *
 * The wire/JSON `--json` envelope shape is unaffected — this is a
 * TypeScript-only ergonomic.
 */
export type SubmitParent =
  | { kind: 'speculation'; speculationId: string | number }
  | {
      kind: 'contest';
      contestId: string | number;
      market: MarketType;
      /** Decimal line as string. Required for spread/total under contest mode. */
      line?: string;
    };

/** Public input shape for `client.commitments.prepareSubmit` / `.submit`. */
export interface HighLevelSubmitArgs {
  parent: SubmitParent;
  /**
   * Override the maker address for preview computation. When set,
   * `prepareSubmit` skips the `signer.getAddress()` call entirely —
   * useful for `--json` preview-only flows that mustn't trigger a
   * passphrase prompt. When unset (the default), the SDK falls back
   * to the configured signer as before.
   *
   * The signing step (`submitPrepared`) always requires a real signer
   * regardless of this override; it never reads from `maker`. So a
   * caller that uses `maker` in preview-only mode is opting out of
   * preview-time unlock but still has to attach a signer if they go
   * on to sign.
   */
  maker?: `0x${string}`;
  /** Free-form team name, alias, or `over`/`under`. */
  side: string;
  /**
   * Odds input string. Two formats accepted:
   *   - decimal with explicit decimal point: "1.91", "2.50", "101.00"
   *   - signed American: "+150", "-110", "+10000"
   * Plain integers (`"2"`, `"101"`) are rejected as ambiguous; signed
   * decimals (`"+101.0"`) are rejected as conflicting. See
   * `parseOddsInput` for the disambiguation rules.
   */
  odds: string;
  /** Decimal USDC as string, e.g. "1" or "0.001". */
  riskUsdc: string;
  /**
   * Expiry input. Three accepted forms (detection is by shape):
   *   - duration: "30m", "4h", "1d", "1w" (suffix-letter)
   *   - ISO-8601 / RFC3339: "2026-05-09T20:00:00Z" or "...-05:00"
   *   - unix-seconds: "1715299200"
   *
   * Default (omitted): the contest's scheduled match time exactly —
   * pregame commitments expire at tip-off so a stale price can't be
   * filled after the game starts. If matchTime is missing or invalid,
   * falls back to `now + 1h` (the preview annotates this as
   * `source = 'missing-match-time-fallback'`); if matchTime is already
   * past, the SDK throws — pass `expiry` explicitly to opt into a
   * live/post-start commitment.
   *
   * Validation: `now < expiry ≤ now + 1y` (protocol cap).
   */
  expiry?: string | number;
  /** Explicit nonce override. */
  nonce?: bigint;
}
