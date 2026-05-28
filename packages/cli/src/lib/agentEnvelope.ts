/**
 * Agent-facing JSON envelope (schemaVersion: 2) — CLI-side builder
 * + writer.
 *
 * Pairs with the type definitions exported from `@ospex/sdk` under
 * `agentEnvelope.ts`. This module owns:
 *
 *   - buildAgentEnvelope({...}) — apply defaults, validate hard
 *     constraints (nextCommands ≤ 3), stamp generatedAt + versions.
 *   - buildFailureEnvelope({...}) — same shape, ok: false, payload:
 *     null. Required so failures still emit valid JSON for agents.
 *   - writeAgentEnvelope(envelope, stream?) — BigInt-safe
 *     JSON.stringify to stdout (or override for tests). Stdout is
 *     reserved for the envelope; logs / prompts go to stderr.
 *   - CLI_VERSION / SDK_VERSION — package versions read once at
 *     module load via `createRequire` (works without TypeScript
 *     rootDir gymnastics; portable across Windows + Linux).
 *
 * Full spec + per-field rules live in `docs/AGENT_ENVELOPE_SPEC.md`;
 * the integration contract is `docs/AGENT_CONTRACT.md`.
 */

import { formatUnits } from 'viem';
import {
  OspexError,
  getAddresses,
  wei6ToDecimalUSDC,
  type AgentApprovalSpenderLabel,
  type AgentEnvelope,
  type AgentFailureEnvelope,
  type AgentError,
  type AgentErrorCauseEntry,
  type AgentWarning,
  type AgentEffect,
  type AgentNextCommand,
  type AgentPayout,
  type AgentStage,
  type ApprovalRequirement,
  type ChainId,
  type Commitment,
  type EstimatedCosts,
  type Hex,
  type Network,
  type PerspectiveAmount,
  type PreviewApproval,
  type PreviewContest,
  type SpeculationMode,
  type WalletRole,
} from '@ospex/sdk';
import { sanitizeUntargetedMessage } from './redact.js';
import { CLI_VERSION, SDK_VERSION } from './version.js';

/* ------------------------------------------------------------------------- */
/* Version constants                                                         */
/* ------------------------------------------------------------------------- */

// Resolved once (bundle-time inject with a runtime fallback) in `./version.ts`, then
// re-exported here so existing `import { CLI_VERSION } from './agentEnvelope.js'` call
// sites (e.g. `index.ts`) and the envelope builders below keep working unchanged.
export { CLI_VERSION, SDK_VERSION };

/* ------------------------------------------------------------------------- */
/* Constants                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Hard cap on `nextCommands[]` length, enforced inside the builder.
 * Spec §2.6: maximum 3 suggestions, ordered verify → complete →
 * remediate. Prevents an envelope from accidentally suggesting a
 * dozen things and an agent auto-running them all.
 */
export const MAX_NEXT_COMMANDS = 3;

/* ------------------------------------------------------------------------- */
/* Builder — success path                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Input shape for `buildAgentEnvelope`. Fields that map directly to
 * the envelope are optional with sensible defaults so per-command
 * call sites stay tight. Required: `ok`, `action`, `stage`, `network`,
 * `chainId`, `payload`.
 *
 * `generatedAt` is overridable for deterministic tests.
 */
export interface BuildAgentEnvelopeArgs<TPayload> {
  ok: boolean;
  action: string;
  stage: AgentStage;
  network: Network;
  chainId: ChainId;

  wallet?: Hex | null;
  walletRole?: WalletRole;
  signer?: Hex | null;

  requiresSignature?: boolean;
  requiresTransaction?: boolean;
  approvalRequirements?: ApprovalRequirement[];

  estimatedCosts?: EstimatedCosts | null;
  risk?: PerspectiveAmount | null;
  payout?: AgentPayout | null;
  contest?: PreviewContest | null;
  speculation?: SpeculationMode | null;
  commitment?: Commitment | null;
  sideSummary?: string | null;

  warnings?: AgentWarning[];
  errors?: AgentError[];
  effects?: AgentEffect[];
  nextCommands?: AgentNextCommand[];

  payload: TPayload;

  /** ISO-8601 UTC. Override for tests; defaults to now. */
  generatedAt?: string;
  /** Override CLI version. Tests only. */
  cliVersion?: string;
  /** Override SDK version. Tests only. */
  sdkVersion?: string;
}

export function buildAgentEnvelope<TPayload>(
  args: BuildAgentEnvelopeArgs<TPayload>,
): AgentEnvelope<TPayload> {
  const nextCommands = args.nextCommands ?? [];
  if (nextCommands.length > MAX_NEXT_COMMANDS) {
    throw new Error(
      `buildAgentEnvelope: nextCommands exceeds cap (${nextCommands.length} > ${MAX_NEXT_COMMANDS}). ` +
        `Spec §2.6 mandates a hard cap; prefer one good suggestion over many.`,
    );
  }
  // Wire-contract guard: payload MUST NOT carry an inner
  // `schemaVersion`. The outer envelope is the only schemaVersion
  // marker; nesting a v1 marker under v2 gives agents two version
  // signals (Hermes PR-67 review). Callers wrapping a legacy v1
  // envelope (e.g. `JsonDoctorReport`) MUST destructure it out:
  //   const { schemaVersion: _legacy, ...payload } = report;
  //   buildAgentEnvelope({ ..., payload });
  // Throws so future PR-3/4/5 migrations can't silently ship the
  // same bug.
  if (
    args.payload !== null &&
    typeof args.payload === 'object' &&
    'schemaVersion' in (args.payload as Record<string, unknown>)
  ) {
    throw new Error(
      'buildAgentEnvelope: payload object carries an inner `schemaVersion` field. ' +
        'The outer v2 envelope is the only schemaVersion marker — strip it from the ' +
        'payload (e.g. via destructure) before wrapping. See docs/AGENT_ENVELOPE_SPEC.md.',
    );
  }
  return {
    schemaVersion: 2,
    ok: args.ok,
    action: args.action,
    stage: args.stage,
    network: args.network,
    chainId: args.chainId,
    generatedAt: args.generatedAt ?? generatedAtNow(),
    cliVersion: args.cliVersion ?? CLI_VERSION,
    sdkVersion: args.sdkVersion ?? SDK_VERSION,
    wallet: args.wallet ?? null,
    walletRole: args.walletRole ?? 'none',
    signer: args.signer ?? null,
    requiresSignature: args.requiresSignature ?? false,
    requiresTransaction: args.requiresTransaction ?? false,
    approvalRequirements: args.approvalRequirements ?? [],
    estimatedCosts: args.estimatedCosts ?? null,
    risk: args.risk ?? null,
    payout: args.payout ?? null,
    contest: args.contest ?? null,
    speculation: args.speculation ?? null,
    commitment: args.commitment ?? null,
    sideSummary: args.sideSummary ?? null,
    warnings: args.warnings ?? [],
    errors: args.errors ?? [],
    effects: args.effects ?? [],
    nextCommands,
    payload: args.payload,
  };
}

/* ------------------------------------------------------------------------- */
/* Builder — failure path                                                    */
/* ------------------------------------------------------------------------- */

export interface BuildFailureEnvelopeArgs {
  action: string;
  stage: AgentStage;
  network: Network;
  chainId: ChainId;
  /** Required — failures must explain themselves. */
  errors: AgentError[];

  wallet?: Hex | null;
  walletRole?: WalletRole;
  signer?: Hex | null;

  warnings?: AgentWarning[];
  nextCommands?: AgentNextCommand[];

  /** Pre-failure preflight info the agent may still want. */
  requiresSignature?: boolean;
  requiresTransaction?: boolean;
  approvalRequirements?: ApprovalRequirement[];

  /**
   * Effects that already completed before the failure. Critical for
   * mid-flight failures (Hermes's PR-6 scope): if a `commitments
   * submit --yes --json` runs an approve tx that confirms and then
   * `submitPrepared` throws NONCE_TOO_LOW, the confirmed approve tx
   * MUST appear in the failure envelope's effects[] so agents see
   * the on-chain side effect they need to reconcile against. Empty
   * (default) when the failure happened before any side effect.
   */
  effects?: AgentEffect[];

  generatedAt?: string;
  cliVersion?: string;
  sdkVersion?: string;
}

/**
 * Always emits a valid envelope shape even when the command failed,
 * so an agent's `--json | jq .` pipeline doesn't choke on the error
 * path. `ok: false`, `payload: null`, errors populated.
 *
 * Errors so catastrophic the envelope can't be built (e.g.
 * `OspexValidationError` at argv parse time, before SDK init) still
 * fall back to plain stderr + exit 1 — see `index.ts`. The window
 * this helper covers is "everything after `getClient()` returns."
 */
export function buildFailureEnvelope(
  args: BuildFailureEnvelopeArgs,
): AgentFailureEnvelope {
  if (args.errors.length === 0) {
    throw new Error(
      `buildFailureEnvelope: at least one error is required. ` +
        `If the command succeeded, use buildAgentEnvelope with ok: true.`,
    );
  }
  const env = buildAgentEnvelope<null>({
    ok: false,
    action: args.action,
    stage: args.stage,
    network: args.network,
    chainId: args.chainId,
    ...(args.wallet !== undefined ? { wallet: args.wallet } : {}),
    ...(args.walletRole !== undefined ? { walletRole: args.walletRole } : {}),
    ...(args.signer !== undefined ? { signer: args.signer } : {}),
    ...(args.requiresSignature !== undefined ? { requiresSignature: args.requiresSignature } : {}),
    ...(args.requiresTransaction !== undefined ? { requiresTransaction: args.requiresTransaction } : {}),
    ...(args.approvalRequirements !== undefined ? { approvalRequirements: args.approvalRequirements } : {}),
    ...(args.warnings !== undefined ? { warnings: args.warnings } : {}),
    errors: args.errors,
    ...(args.effects !== undefined ? { effects: args.effects } : {}),
    ...(args.nextCommands !== undefined ? { nextCommands: args.nextCommands } : {}),
    payload: null,
    ...(args.generatedAt !== undefined ? { generatedAt: args.generatedAt } : {}),
    ...(args.cliVersion !== undefined ? { cliVersion: args.cliVersion } : {}),
    ...(args.sdkVersion !== undefined ? { sdkVersion: args.sdkVersion } : {}),
  });
  // Narrow the discriminator for callers that switch on ok.
  return env as AgentFailureEnvelope;
}

/* ------------------------------------------------------------------------- */
/* Per-command failure emit + raw-error → AgentError mapper                  */
/* ------------------------------------------------------------------------- */

export interface EmitJsonFailureArgs {
  action: string;
  stage: AgentStage;
  chainId: ChainId;
  /** Raw error thrown by the SDK/CLI body — converted to AgentError. */
  error: unknown;

  wallet?: Hex | null;
  walletRole?: WalletRole;
  signer?: Hex | null;

  /**
   * Whether the command would have produced an EIP-712 signature had
   * it succeeded. Defaults to `false` (the safe envelope-default), so
   * write commands MUST pass `true` explicitly. Without it, an agent
   * reading a failure envelope from `contests create` / `commitments
   * submit` sees `requiresSignature: false` — misleading because the
   * signer was resolved and a signature WAS the intent.
   */
  requiresSignature?: boolean;

  /**
   * Whether the command would have produced an on-chain transaction
   * had it succeeded. Same rationale as `requiresSignature` — write
   * commands MUST pass `true` so the failure envelope advertises
   * write-intent to agent recovery logic.
   */
  requiresTransaction?: boolean;

  /**
   * Approval pre-flight requirements known at failure time. Surfaced
   * verbatim in the envelope so an agent recovering from a
   * pre-broadcast failure (e.g. balance / allowance gating) can act
   * on the same information the success path would have advertised.
   */
  approvalRequirements?: ApprovalRequirement[];

  /**
   * Completed on-chain / off-chain effects that landed BEFORE the
   * failure. Preserved in the envelope per Hermes's PR-6 scope:
   * "any already-completed effects[] when a command fails after
   * side effects." Empty / omitted when the failure happened before
   * any side effect.
   */
  effects?: AgentEffect[];

  warnings?: AgentWarning[];

  /**
   * Suggested remediation commands (PR-7). Typically derived from
   * the error code via `deriveRemediationNextCommands` —
   * ALLOWANCE_INSUFFICIENT → `remediate-approve-*` suggestions, etc.
   * Capped at 3 by `buildAgentEnvelope`.
   */
  nextCommands?: AgentNextCommand[];
}

/**
 * Build + write a v2 failure envelope to stdout. Per-command catch
 * blocks call this when `--json` is set and a thrown error needs to
 * surface as a structured envelope instead of legacy stderr.
 *
 * The caller is responsible for `process.exit(1)` after — this helper
 * doesn't exit so call sites stay explicit about flow control (and
 * tests can assert without process termination).
 *
 * Stdout-only: the envelope goes to stdout (the agent contract);
 * anything that was already on stderr (renderers, prompts, progress
 * lines) stays there.
 */
export function emitJsonFailure(args: EmitJsonFailureArgs): void {
  const env = buildFailureEnvelope({
    action: args.action,
    stage: args.stage,
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    errors: [errorToAgentError(args.error)],
    ...(args.wallet !== undefined ? { wallet: args.wallet } : {}),
    ...(args.walletRole !== undefined ? { walletRole: args.walletRole } : {}),
    ...(args.signer !== undefined ? { signer: args.signer } : {}),
    ...(args.requiresSignature !== undefined ? { requiresSignature: args.requiresSignature } : {}),
    ...(args.requiresTransaction !== undefined ? { requiresTransaction: args.requiresTransaction } : {}),
    ...(args.approvalRequirements !== undefined ? { approvalRequirements: args.approvalRequirements } : {}),
    ...(args.effects !== undefined ? { effects: args.effects } : {}),
    ...(args.warnings !== undefined ? { warnings: args.warnings } : {}),
    ...(args.nextCommands !== undefined ? { nextCommands: args.nextCommands } : {}),
  });
  writeAgentEnvelope(env);
}

/**
 * Map an arbitrary thrown value into an AgentError. SDK errors
 * (`OspexError` subclasses) keep their `code` field — that's the
 * stable agent-routing surface per AGENT_CONTRACT.md §7. Native
 * `Error`s fall back to `UNKNOWN_ERROR` so the envelope's
 * structured-error contract holds even on unexpected throws.
 *
 * For OspexChainError specifically the `txHash` (when present on a
 * reverted send) and `reason` are surfaced under `details` so agents
 * can recover the on-chain location of the failure without parsing
 * the message text.
 *
 * `err.cause` (ES2022 Error.cause) is walked into
 * `details.causeChain[]` (sanitized) — this is the only path that
 * surfaces underlying viem / transport / API errors in `--json` mode.
 * Without it, a wrapped `OspexChainError("Transaction broadcast or
 * inclusion failed.", { cause })` lands in the envelope as opaque text
 * with no breadcrumb back to "rate-limited" / "timeout" / "underpriced".
 */
export function errorToAgentError(err: unknown): AgentError {
  if (err instanceof OspexError) {
    const details: Record<string, unknown> = { ...(extractOspexErrorDetails(err) ?? {}) };
    const causeChain = buildCauseChain(readCause(err));
    if (causeChain.length > 0) details.causeChain = causeChain;
    const agentError: AgentError = { code: err.code, message: err.message };
    if (Object.keys(details).length > 0) agentError.details = details;
    return agentError;
  }
  if (err instanceof Error) {
    const agentError: AgentError = { code: 'UNKNOWN_ERROR', message: err.message };
    const causeChain = buildCauseChain(readCause(err));
    if (causeChain.length > 0) agentError.details = { causeChain };
    return agentError;
  }
  return { code: 'UNKNOWN_ERROR', message: String(err) };
}

/* ------------------------------------------------------------------------- */
/* Cause-chain walker                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Maximum depth the cause-chain walker descends. Bounded so a
 * self-referential or pathological chain can't bloat the envelope.
 * Matches the depth Hermes's diagnose-create.mjs uses as a working
 * reference; viem chains rarely exceed 2-3 levels in practice.
 */
export const MAX_CAUSE_CHAIN_DEPTH = 4;

/**
 * Walk `err.cause` outward into a flat, ordered list of safe summary
 * entries. Index 0 is the most immediate nested cause. Stops at:
 *
 *   - `current === undefined | null`
 *   - depth equal to `maxDepth` (default `MAX_CAUSE_CHAIN_DEPTH`)
 *   - a cycle (`Set`-based seen check)
 *
 * String fields are sanitized via `sanitizeUntargetedMessage` so any
 * RPC URLs or credential-shaped substrings viem put in `err.message` /
 * `err.metaMessages[]` are redacted before reaching stdout.
 */
export function buildCauseChain(
  initial: unknown,
  maxDepth: number = MAX_CAUSE_CHAIN_DEPTH,
): AgentErrorCauseEntry[] {
  const chain: AgentErrorCauseEntry[] = [];
  let current: unknown = initial;
  const seen = new Set<object>();
  for (let depth = 0; depth < maxDepth; depth++) {
    if (current === undefined || current === null) break;
    if (typeof current === 'object') {
      if (seen.has(current)) break;
      seen.add(current);
    }
    chain.push(causeEntryFor(current));
    current = readCause(current);
  }
  return chain;
}

function readCause(err: unknown): unknown {
  if (err === null || typeof err !== 'object') return undefined;
  if (!('cause' in (err as Record<string, unknown>))) return undefined;
  return (err as { cause: unknown }).cause;
}

/**
 * Extract a single `AgentErrorCauseEntry` from one node of the cause
 * chain. Pulls only the known-safe fields and sanitizes free-form
 * strings. The `name === 'Error'` filter drops the noise from plain
 * `Error` instances whose constructor name carries no information.
 */
function causeEntryFor(err: unknown): AgentErrorCauseEntry {
  if (err === null || typeof err !== 'object') {
    return { message: sanitizeUntargetedMessage(String(err)) };
  }
  const e = err as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    shortMessage?: unknown;
    metaMessages?: unknown;
    status?: unknown;
    reason?: unknown;
    revertReason?: unknown;
    txHash?: unknown;
  };
  const out: AgentErrorCauseEntry = {};
  if (typeof e.name === 'string' && e.name !== '' && e.name !== 'Error') {
    out.name = e.name;
  }
  if (typeof e.code === 'string') out.code = e.code;
  if (typeof e.message === 'string') {
    out.message = sanitizeUntargetedMessage(e.message);
  }
  if (typeof e.shortMessage === 'string') {
    out.shortMessage = sanitizeUntargetedMessage(e.shortMessage);
  }
  if (Array.isArray(e.metaMessages)) {
    const meta = e.metaMessages
      .filter((m): m is string => typeof m === 'string')
      .map(sanitizeUntargetedMessage);
    if (meta.length > 0) out.metaMessages = meta;
  }
  if (typeof e.status === 'number') out.status = e.status;
  if (typeof e.reason === 'string') out.reason = e.reason;
  if (typeof e.revertReason === 'string') {
    out.revertReason = sanitizeUntargetedMessage(e.revertReason);
  }
  if (typeof e.txHash === 'string') out.txHash = e.txHash;
  return out;
}

/**
 * Pull the structured fields off a typed OspexError into a
 * loosely-typed details bag the failure envelope can surface to
 * agents. Returns undefined when the error has nothing extra to add
 * (keeps the envelope tight).
 */
function extractOspexErrorDetails(err: OspexError): Record<string, unknown> | undefined {
  // Defensive read — different subclasses carry different fields;
  // we copy any of the standard typed-error fields documented in
  // AGENT_CONTRACT.md §7 when they're present.
  const e = err as unknown as {
    reason?: string;
    revertReason?: string;
    txHash?: string;
    field?: string;
    apiCode?: string;
    status?: number;
    path?: string;
    required?: bigint;
    current?: bigint;
    spender?: string;
    token?: string;
    expectedAddress?: string;
    actualAddress?: string;
    mode?: string;
    expectedHash?: string;
    actualHash?: string;
    subscriptionId?: bigint;
  };
  const out: Record<string, unknown> = {};
  if (typeof e.reason === 'string') out.reason = e.reason;
  if (typeof e.revertReason === 'string') out.revertReason = e.revertReason;
  if (typeof e.txHash === 'string') out.txHash = e.txHash;
  if (typeof e.field === 'string') out.field = e.field;
  if (typeof e.apiCode === 'string') out.apiCode = e.apiCode;
  if (typeof e.status === 'number') out.status = e.status;
  if (typeof e.path === 'string') out.path = e.path;
  if (typeof e.required === 'bigint') out.required = e.required.toString();
  if (typeof e.current === 'bigint') out.current = e.current.toString();
  if (typeof e.spender === 'string') out.spender = e.spender;
  if (typeof e.token === 'string') out.token = e.token;
  if (typeof e.expectedAddress === 'string') out.expectedAddress = e.expectedAddress;
  if (typeof e.actualAddress === 'string') out.actualAddress = e.actualAddress;
  if (typeof e.mode === 'string') out.mode = e.mode;
  if (typeof e.expectedHash === 'string') out.expectedHash = e.expectedHash;
  if (typeof e.actualHash === 'string') out.actualHash = e.actualHash;
  if (typeof e.subscriptionId === 'bigint') out.subscriptionId = e.subscriptionId.toString();
  return Object.keys(out).length === 0 ? undefined : out;
}

/* ------------------------------------------------------------------------- */
/* Writer                                                                    */
/* ------------------------------------------------------------------------- */

export interface WriteAgentEnvelopeOptions {
  /** Override target stream — defaults to process.stdout. */
  out?: NodeJS.WritableStream;
  /** JSON.stringify spaces. Defaults to 2 for human-tail-friendly output. */
  indent?: number;
}

/**
 * Writes the envelope to stdout (or override) as BigInt-safe JSON
 * with a trailing newline. The envelope is the sole content on
 * stdout for `--json` invocations — every log line, prompt, and
 * preview rendering MUST go to stderr.
 */
export function writeAgentEnvelope(
  envelope: AgentEnvelope<unknown>,
  options: WriteAgentEnvelopeOptions = {},
): void {
  const stream = options.out ?? process.stdout;
  const indent = options.indent ?? 2;
  stream.write(JSON.stringify(envelope, jsonReplacer, indent) + '\n');
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Derive the `Network` enum value from a `ChainId`. Used by every
 * Class A command to populate `envelope.network` alongside `chainId`.
 *
 * Polygon mainnet = 137 → 'polygon'; Polygon Amoy = 80002 → 'amoy'.
 * The ChainId type already pins the input to one of these two
 * literals, so the implementation is total at the type level.
 */
export function networkForChainId(chainId: ChainId): Network {
  return chainId === 137 ? 'polygon' : 'amoy';
}

/* ------------------------------------------------------------------------- */
/* Preview-approval → ApprovalRequirement mapper                             */
/* ------------------------------------------------------------------------- */

/**
 * Map a v1 `PreviewApproval` (from `SubmitPreview` / `MatchPreview`)
 * into the v2 `ApprovalRequirement` shoulder shape used by every
 * preview-bearing write under `--json`. Adds the symbolic
 * `tokenSymbol` / `spenderLabel` annotations + human-formatted
 * decimals that agents shouldn't have to derive themselves.
 *
 * Throws `OspexConfigError` (from `getAddresses`) when the chainId
 * isn't deployed. Throws on an unknown spender — that's a bug, not a
 * forward-compat path; if a new spender becomes legitimate, extend
 * `AgentApprovalSpenderLabel` and the lookup below in lockstep.
 */
export function mapPreviewApprovals(
  approvals: readonly PreviewApproval[],
  chainId: ChainId,
): ApprovalRequirement[] {
  const addresses = getAddresses(chainId);
  return approvals.map((a) => {
    const tokenAddress = (a.token === 'USDC'
      ? addresses.usdc.toLowerCase()
      : addresses.linkToken.toLowerCase()) as Hex;
    const spenderHex = a.spender.toLowerCase() as Hex;
    const spenderLabel = spenderLabelFor(spenderHex, chainId);
    return {
      token: tokenAddress,
      tokenSymbol: a.token,
      spender: spenderHex,
      spenderLabel,
      purpose: a.purpose,
      requiredWei: a.required,
      requiredHuman: formatTokenAmount(a.token, a.required),
      currentWei: a.current,
      currentHuman: formatTokenAmount(a.token, a.current),
      needsApproval: a.needsApproval,
    };
  });
}

/**
 * Look up the symbolic label for a known Ospex spender on a given
 * chain. The labels are part of the agent envelope contract — agents
 * should never need their own module-address book to explain an
 * approval row.
 */
export function spenderLabelFor(
  spender: Hex,
  chainId: ChainId,
): AgentApprovalSpenderLabel {
  const a = getAddresses(chainId);
  const s = spender.toLowerCase();
  if (s === a.positionModule.toLowerCase()) return 'PositionModule';
  if (s === a.treasuryModule.toLowerCase()) return 'TreasuryModule';
  if (s === a.oracleModule.toLowerCase()) return 'OracleModule';
  throw new Error(
    `spenderLabelFor: unknown spender ${spender} on chainId ${chainId}. ` +
      'Extend AgentApprovalSpenderLabel and this lookup together when adding a new module.',
  );
}

/**
 * Human-format a wei-denominated decimal string for a token. USDC
 * (6 decimals) → 6-fractional-digit decimal string via the SDK's
 * canonical formatter; LINK (18 decimals) → viem's `formatUnits`.
 *
 * Exported for tests + reuse by ApprovalRequirement consumers (e.g.
 * `approvals setup` may need to format current vs target outside the
 * preview path).
 */
export function formatTokenAmount(
  symbol: 'USDC' | 'LINK',
  weiDecimalStr: string,
): string {
  const value = BigInt(weiDecimalStr);
  if (symbol === 'USDC') return wei6ToDecimalUSDC(value);
  return formatUnits(value, 18);
}

/**
 * BigInt-safe JSON replacer. Matches `lib/format.ts`'s replacer; kept
 * inline here so the envelope writer has no dependency on the legacy
 * formatter (which has table-rendering logic agents don't need).
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function generatedAtNow(): string {
  // `toISOString()` already returns UTC, ms-precision: `"2026-05-16T15:00:00.123Z"`.
  return new Date().toISOString();
}
