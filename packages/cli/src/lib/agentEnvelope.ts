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
 * Full spec + per-field rules live in `agent-envelope-spec.md`
 * (repo root) and `docs/AGENT_CONTRACT.md` (rewritten for v2 in the
 * next PR).
 */

import { createRequire } from 'node:module';
import type {
  AgentEnvelope,
  AgentFailureEnvelope,
  AgentError,
  AgentWarning,
  AgentEffect,
  AgentNextCommand,
  AgentPayout,
  AgentStage,
  ApprovalRequirement,
  ChainId,
  Commitment,
  EstimatedCosts,
  Hex,
  Network,
  PerspectiveAmount,
  PreviewContest,
  SpeculationMode,
  WalletRole,
} from '@ospex/sdk';

/* ------------------------------------------------------------------------- */
/* Version constants                                                         */
/* ------------------------------------------------------------------------- */

interface PkgShape {
  version: string;
}

// `createRequire` lets us read package.json at runtime without pulling
// it through TypeScript's rootDir check (which `import ... with { type:
// 'json' }` would trip because the CLI's tsconfig has `rootDir:
// "./src"` and package.json lives one level up).
const require = createRequire(import.meta.url);
const cliPkg = require('../../package.json') as PkgShape;
const sdkPkg = require('@ospex/sdk/package.json') as PkgShape;

export const CLI_VERSION: string = cliPkg.version;
export const SDK_VERSION: string = sdkPkg.version;

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
