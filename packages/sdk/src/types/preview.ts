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
import type { SubmitResult } from '../commitments/submit.js';

/** How the resolver matched the user's `--side` input. */
export type ResolutionSource = 'exact' | 'nickname' | 'alias' | 'over' | 'under';

/** Which entity the resolved side maps to on the speculation. */
export type SideRole = 'away' | 'home' | 'over' | 'under';

/** Discriminator for speculation existence at preview time. */
export type SpeculationMode =
  | { mode: 'existing'; speculationId: string }
  | { mode: 'lazy'; speculationId: null; speculationKey: string };

/** Three-valued outcome result on a single condition row. */
export type OutcomeResult = 'win' | 'lose' | 'push';

/** What the user is risking + receiving + the protocol-level numerics. */
export interface PreviewEconomics {
  oddsTick: number;
  oddsDecimal: string;
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
  /** Decimal odds as string, e.g. "2.50". */
  odds: string;
  /** Decimal USDC as string, e.g. "1" or "0.001". */
  riskUsdc: string;
  /** ISO-8601 or unix-seconds. Default 24h from now. */
  expiry?: string | number;
  /** Explicit nonce override. */
  nonce?: bigint;
}
