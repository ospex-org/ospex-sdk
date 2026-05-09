/**
 * Public types for the resolver-layer preview model. The CLI renders
 * pretty text from `SubmitPreview`; `--json` emits the envelope; tests
 * assert against the structured shape; future agents in other languages
 * consume the same JSON contract via `schemaVersion`.
 *
 * Lock the contract early — once market-maker bots start consuming
 * the JSON output, the schema is part of the public SDK surface.
 *
 * See `docs/PROPOSAL.md` §6.2 in the parent ospex-matched-pairs/ root
 * for the full design rationale.
 */

import type { MarketType } from './odds.js';
import type { SubmitResult } from '../commitments/submitRaw.js';

/** How the resolver matched the user's `--side` input. */
export type ResolutionSource = 'exact' | 'nickname' | 'alias' | 'over' | 'under';

/** Which entity the resolved side maps to on the speculation. */
export type SideRole = 'away' | 'home' | 'over' | 'under';

/** Discriminator for speculation existence at preview time. */
export type SpeculationMode =
  | { mode: 'existing'; speculationId: string }
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
       * time. NOTE: as of this PR, the SDK's allowance preflight
       * still only checks PositionModule; a follow-up will preflight
       * the TreasuryModule allowance for lazy commitments and
       * surface a second `approvals[]` row when both are short.
       * Until then, a maker submitting a lazy commit with insufficient
       * TreasuryModule allowance will not be blocked at submit time;
       * the first match will revert with `ERC20InsufficientAllowance`
       * against TreasuryModule.
       */
      makerCreationFeeUSDC: string;
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

export interface PreviewApproval {
  token: 'USDC' | 'LINK';
  spender: string;
  /** wei (token's native decimals) as decimal string. */
  required: string;
  current: string;
  needsApproval: boolean;
}

export interface PreviewOutcome {
  condition: string;
  result: OutcomeResult;
  /** Formatted USDC string. For 'lose' shows the negative risk; for 'push' shows the stake returned. */
  payoutUSDC: string;
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
}

/**
 * JSON envelope for `commitments submit --json` (preview only). Used
 * over the wire — the in-memory `prepareSubmit(args): Promise<SubmitPreview>`
 * returns the bare model. Add `schemaVersion: 1` only at the JSON
 * boundary so downstream agents have a stable contract.
 */
export interface SubmitPreviewEnvelope {
  schemaVersion: 1;
  preview: SubmitPreview;
}

/**
 * Wire shape for `commitments submit --yes --json` (post-submit).
 *
 * `result` is the SDK's existing `SubmitResult` — `{ hash, commitment }` —
 * not a re-invented `{ hash, status }` shape. Locking schemaVersion: 1
 * with a result type that disagrees with what `commitments.submit`
 * actually returns would be a self-inflicted contract break.
 */
export interface SubmitJsonResult {
  schemaVersion: 1;
  preview: SubmitPreview;
  result: SubmitResult;
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
 * Public-API decision logged in PROPOSAL.md §6.1 (post-PR-A revision).
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
