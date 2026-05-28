/**
 * Agent-facing JSON envelope (schemaVersion: 2). Wraps every Class A
 * CLI command's `--json` output in a single shared shoulder block so
 * agents can route, preflight, explain, remediate, and verify with one
 * consistent shape instead of learning each command's bespoke JSON.
 *
 * Authoritative shape — full field-by-field rules + per-command matrix
 * live in `docs/AGENT_ENVELOPE_SPEC.md`. Only additive changes inside
 * schemaVersion: 2 are permitted (new optional fields, new enum
 * values). Consumers MUST log + ignore unknown enum values and unknown
 * fields.
 */

import type { Hex } from './signer.js';
import type { Network, ChainId } from './protocol.js';
import type { Commitment } from './commitment.js';
import type {
  PreviewContest,
  SpeculationMode,
  PerspectiveAmount,
} from './preview.js';

/* ------------------------------------------------------------------------- */
/* Top-level envelope                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Discriminator for what an agent is being asked to do at this stage:
 *
 *   read       — pure read; no signature, no tx, no state change.
 *   preview    — preview-bearing command run WITHOUT `--yes`. Renders
 *                what execution would do; does not sign or send.
 *   execute    — command actually signed / dispatched. `effects[]`
 *                records what happened.
 *   dry-run    — command computes the plan it WOULD execute (e.g.
 *                `claim-all --dry-run`) without sending anything.
 *                Distinct from `preview` for ergonomics: `dry-run`
 *                belongs to commands whose default mode IS execute.
 */
export type AgentStage = 'read' | 'preview' | 'execute' | 'dry-run';

/**
 * How the envelope's `wallet` field is being used by this command.
 *
 *   signer  — this command is asking that wallet to sign something
 *             (or, on preview, would).
 *   subject — this command is querying that wallet's data. No
 *             signature requested.
 *   filter  — this command is filtering results by that wallet
 *             (e.g. `commitments list --maker`). No data ABOUT the
 *             wallet itself is fetched.
 *   none    — no wallet context.
 *
 * The split exists to prevent an agent from assuming it can sign for
 * an address it's merely inspecting.
 */
export type WalletRole = 'signer' | 'subject' | 'filter' | 'none';

/**
 * The shared agent-facing JSON envelope. Every Class A CLI command
 * emits this under `--json`.
 *
 * `payload` carries the command-specific data (e.g. `SubmitPreview`
 * for `commitments submit --json`, `Commitment[]` for `commitments
 * list --json`).
 *
 * Field order in the TypeScript declaration is by section; JSON
 * consumers MUST NOT depend on field order (it's not part of the
 * contract; JSON objects are unordered per spec).
 */
export interface AgentEnvelope<TPayload = unknown> {
  schemaVersion: 2;

  /* Status */
  ok: boolean;
  /** Stable dotted command identifier, e.g. `'commitments.submit'`. */
  action: string;
  stage: AgentStage;

  /* Network + provenance */
  network: Network;
  chainId: ChainId;
  /** ISO-8601 UTC, generated when the envelope was built. */
  generatedAt: string;
  /** `@ospex/cli` semver from package.json. */
  cliVersion: string;
  /** `@ospex/sdk` semver from package.json. */
  sdkVersion: string;

  /* Wallet context */
  wallet: Hex | null;
  walletRole: WalletRole;
  /** Signer address, when the command resolved one. */
  signer: Hex | null;

  /* Action preflight (populated mostly on preview / dry-run stages) */
  requiresSignature: boolean;
  requiresTransaction: boolean;
  approvalRequirements: ApprovalRequirement[];

  /* Economics + identity (populated when there's a single clear context) */
  estimatedCosts: EstimatedCosts | null;
  risk: PerspectiveAmount | null;
  payout: AgentPayout | null;
  contest: PreviewContest | null;
  speculation: SpeculationMode | null;
  commitment: Commitment | null;
  /** Display helper. Never load-bearing; canonical structured fields live under `payload`. */
  sideSummary: string | null;

  /* Outcomes + structured signals */
  warnings: AgentWarning[];
  errors: AgentError[];
  /** Post-execute log of signatures + txs + off-chain writes. Empty for preview / read / dry-run. */
  effects: AgentEffect[];
  /** Hard cap: 3 entries. Ordered: verify → complete → remediate. */
  nextCommands: AgentNextCommand[];

  /** Command-specific payload. `null` on failure envelopes where no payload could be produced. */
  payload: TPayload;
}

/* ------------------------------------------------------------------------- */
/* Approval requirements                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Why an approval row exists. Superset of the v1 `ApprovalPurpose`:
 * v1 only ever surfaced `commitment-risk` + `lazy-creation-fee`. v2
 * extends to contest-lifecycle approvals (LINK → OracleModule and
 * USDC → TreasuryModule for contest creation; LINK → OracleModule
 * for contest scoring).
 *
 * Forward-compatible — new values may be added; consumers MUST log
 * + ignore unknown.
 */
export type AgentApprovalPurpose =
  | 'commitment-risk'
  | 'lazy-creation-fee'
  | 'contest-creation-usdc'
  | 'contest-creation-link'
  | 'contest-scoring-link';

/** Symbolic spender label — saves agents a module-address-book lookup. */
export type AgentApprovalSpenderLabel =
  | 'PositionModule'
  | 'TreasuryModule'
  | 'OracleModule';

export interface ApprovalRequirement {
  token: Hex;
  tokenSymbol: 'USDC' | 'LINK';
  spender: Hex;
  spenderLabel: AgentApprovalSpenderLabel;
  purpose: AgentApprovalPurpose;
  /** wei (token's native decimals) as decimal string. */
  requiredWei: string;
  /** Formatted with token's native decimals (USDC 6dp, LINK 18dp). */
  requiredHuman: string;
  currentWei: string;
  currentHuman: string;
  needsApproval: boolean;
}

/* ------------------------------------------------------------------------- */
/* Estimated costs                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Deterministic protocol fees are populated by default when they
 * apply. Gas estimation is opt-in via a future `--estimate-gas` flag
 * (deferred to a follow-up additive minor); until then `gas` is
 * always `null`.
 *
 * No `gasUSDC` field by design: Polygon's gas asset is POL, not
 * USDC. Quoting gas in USDC requires a trusted conversion source we
 * don't currently maintain.
 */
export interface EstimatedCosts {
  gas: {
    nativeToken: 'POL';
    estimatedWei: string;
    /** Formatted, 18dp. */
    estimatedPOL: string;
    source: 'rpc-estimateGas';
  } | null;
  usdcFees: AgentUsdcFee[];
  linkFees: AgentLinkFee[];
}

export interface AgentUsdcFee {
  purpose: 'lazy-creation-fee' | 'contest-creation-fee';
  /** wei6 as decimal string. */
  amountWei6: string;
  /** Formatted, 6 fractional digits. */
  amountUSDC: string;
  /**
   * True when the fee is charged only under a race-condition path
   * (e.g. lazy-creation-fee is pulled only if this match is the first
   * to land on the speculationKey). Agents must surface the
   * conditional nature to operators.
   */
  conditional: boolean;
  note?: string;
}

export interface AgentLinkFee {
  purpose: 'contest-verification' | 'contest-scoring';
  /** wei (18dp) as decimal string. */
  amountWei: string;
  /** Formatted, 18dp. */
  amountLINK: string;
}

/* ------------------------------------------------------------------------- */
/* Payout                                                                    */
/* ------------------------------------------------------------------------- */

export interface AgentPayout {
  /** Profit if the viewer wins. */
  profit: PerspectiveAmount;
  /** Risk + profit. Named `totalReturn` (not `return`) so polyglot codegen doesn't trip on the JS reserved word. */
  totalReturn: PerspectiveAmount;
}

/* ------------------------------------------------------------------------- */
/* Warnings + errors                                                         */
/* ------------------------------------------------------------------------- */

export type AgentWarningSeverity = 'info' | 'warning' | 'blocking';

/**
 * Which downstream operation a warning blocks. Forward-compatible —
 * new values may be added; consumers MUST log + ignore unknown.
 */
export type AgentBlockingCapability =
  | 'submit'
  | 'match'
  | 'cancel-onchain'
  | 'claim'
  | 'settle'
  | 'contest-create'
  | 'contest-score'
  | 'market-maker';

/**
 * Stable initial catalog. Forward-compatible — new codes may be added;
 * consumers MUST switch on `code` with a default arm.
 *
 * Codes lifted from existing surfaces:
 *   `'self-match'`, `'expires-soon'`, `'expired'`, `'partial-fill'`,
 *   `'nonce-invalidated'`, `'maker-treasury-allowance-insufficient'`
 *     — from `MatchPreview.warnings` (v1).
 *   `'expiry-after-match-time'` — from `SubmitPreview.expiry.afterMatchTime`.
 *   `'allowance-short'` — derived from any `approvalRequirements[].needsApproval`.
 *   `'nonce-floor-stale'` — `nonce-floor` read when chain > supabase.
 *   `'verify-script-expiring-soon'` — from `contests scripts` (T-30d).
 *   `'password-file-permissions-loose'` — from `auth check` (blocking under `--strict`).
 *
 * Catalog left as a wide `string` so additive expansion in any PR
 * doesn't need a type-file edit.
 */
export type AgentWarningCode = string;

export interface AgentWarning {
  code: AgentWarningCode;
  /** Human-readable copy. May drift between versions; agents switch on `code`, not `message`. */
  message: string;
  severity: AgentWarningSeverity;
  /** Which downstream operations this warning would block. Absent ⇒ informational only. */
  blockingFor?: AgentBlockingCapability[];
  details?: unknown;
}

/**
 * One entry in `AgentError.details.causeChain[]`. Captures a safe
 * subset of fields from a nested error (typically a wrapped viem error
 * or another `OspexError`). String fields are sanitized — credential
 * patterns and full URLs are redacted before they land in the
 * envelope. All fields optional; agents switch on `name` / `code` /
 * `status` to classify (e.g. `name === 'HttpRequestError'` +
 * `status === 429` → rate limit).
 */
export interface AgentErrorCauseEntry {
  /** Constructor name (e.g. `'HttpRequestError'`, `'TimeoutError'`). */
  name?: string;
  /** Typed error code, when the nested error carries one. */
  code?: string;
  /** Sanitized full message. */
  message?: string;
  /** viem's one-line summary; sanitized. */
  shortMessage?: string;
  /** viem's chain-of-explanation lines; sanitized. */
  metaMessages?: readonly string[];
  /** HTTP status when the nested error was an HTTP response. */
  status?: number;
  /** Decoded revert discriminator on a nested `OspexChainError`. */
  reason?: string;
  /** Free-form revert reason on a nested `OspexChainError`. */
  revertReason?: string;
  /** Tx hash, when the nested error was tied to a broadcast tx. */
  txHash?: string;
}

/**
 * `code` uses the existing `OspexError.code` taxonomy from `errors.ts`
 * (`'API_ERROR'`, `'ALLOWANCE_INSUFFICIENT'`, `'CHAIN_ERROR'`, etc.)
 * plus envelope-specific codes (`'non_interactive_password_required'`,
 * etc.). Same forward-compat rule as warnings.
 *
 * `details.causeChain` (when present) is an ordered array of
 * `AgentErrorCauseEntry` capturing the nested-cause walk from the
 * thrown error outward — index 0 is the most immediate cause,
 * subsequent indices step further down the chain. Bounded to a small
 * depth so a self-referential or pathological chain can't bloat the
 * envelope. See `AgentErrorCauseEntry`.
 */
export interface AgentError {
  code: string;
  message: string;
  details?: unknown;
}

/* ------------------------------------------------------------------------- */
/* Effects (unified off-chain sigs + on-chain txs)                           */
/* ------------------------------------------------------------------------- */

export type AgentEffectType =
  | 'eip712-signature'
  | 'offchain-write'
  | 'transaction'
  | 'contract-call';

export type AgentEffectStatus = 'submitted' | 'confirmed' | 'reverted';

/**
 * One entry per action the command actually performed. Populated only
 * on `stage === 'execute'`; empty otherwise.
 *
 * The unified array (off-chain sigs + on-chain txs in one list) lets
 * commands like `commitments cancel --also-onchain` surface partial
 * success cleanly with per-effect `ok`. Agents that want only
 * transactions filter `effects.filter(e => e.type === 'transaction')`.
 */
export interface AgentEffect {
  type: AgentEffectType;
  /** Stable descriptor: `'submit-commitment'`, `'offchain-cancel'`, `'onchain-cancel'`, `'settle'`, `'claim'`, `'approve-usdc'`, etc. */
  purpose: string;
  ok: boolean;
  txHash?: Hex;
  /** Decimal bigint string. */
  blockNumber?: string;
  status?: AgentEffectStatus;
  /** Populated when `ok === false`. Mirrors `errors[].code` for the failed effect. */
  errorCode?: string;
}

/* ------------------------------------------------------------------------- */
/* Next commands                                                             */
/* ------------------------------------------------------------------------- */

export type AgentNextCommandIntent = 'verify' | 'complete' | 'remediate';

/**
 * A suggested follow-up command. Locally-scoped only — verify what
 * just happened, complete an explicit dry-run, remediate a known
 * local blocker. NO strategic suggestions (no "take this quote", no
 * "raise odds", no "make another market").
 *
 * `argv` is the canonical execution form for agents. `command` is the
 * copy-pasteable human-readable form. They MUST resolve to the same
 * invocation; this is enforced by the registry's argv-roundtrip
 * tests.
 *
 * `safeToAutoRun` is true only for read-only suggestions. Writes,
 * including remediations, are always `false` even when obviously
 * correct.
 */
export interface AgentNextCommand {
  /** Stable identifier from the registry, e.g. `'verify-commitment'`. */
  id: string;
  description: string;
  suggestedFor: AgentNextCommandIntent;
  /** Copy-pasteable form (single shell line, no escaping subtleties). */
  command: string;
  /** Argv-array form, omitting the `'ospex'` binary name itself. Agent-safe. */
  argv: string[];
  /** `true` only for read-only verifies. Writes/remediations always `false`. */
  safeToAutoRun: boolean;
}

/* ------------------------------------------------------------------------- */
/* Convenience aliases                                                       */
/* ------------------------------------------------------------------------- */

/**
 * The shape returned by `buildFailureEnvelope`. Functionally an
 * `AgentEnvelope<null>` with `ok: false`; the alias exists to make
 * call sites explicit at the type level.
 */
export type AgentFailureEnvelope = AgentEnvelope<null> & { ok: false };
