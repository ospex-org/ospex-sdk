/**
 * `ospex doctor` v2 — flat, machine-switchable preflight surface.
 *
 * The current doctor reports balances, allowances, and a readiness
 * matrix. This module adds a parallel structured surface — a flat list
 * of `CheckResult` records and per-capability rollups — so agents can
 * switch on stable check IDs instead of parsing the human matrix.
 *
 * The renderer in `doctorRender.ts` still produces the existing fields;
 * this module's output is composed alongside them. None of these tasks
 * fetch from the network — they classify already-fetched snapshots so
 * the SDK reads stay in one place (the doctor command).
 *
 * Stable surface — part of the `schemaVersion: 1` envelope contract.
 * Check IDs and error codes are switchable; labels / details / remediation
 * are human and may move.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatUnits } from 'viem';
import type { ApprovalsSnapshot, BalancesSnapshot } from '@ospex/sdk';

// ── thresholds (mirrored from doctorRender.ts) ────────────────────────
//
// These intentionally match the renderer's "effectively zero" floors so
// the structured checks never disagree with the human-rendered balance
// annotations. If you change one, change the other.
const POL_GAS_FLOOR_WEI = 100_000_000_000_000n;
const LINK_DUST_FLOOR_WEI = 1_000_000_000_000n;

// ── envelope types ────────────────────────────────────────────────────

export type CapabilityId =
  | 'matchCommitments'
  | 'submitCommitments'
  | 'createContests';

export type CheckId =
  | 'connectivity.api'
  | 'signer.address_known'
  | 'balances.native'
  | 'balances.usdc'
  | 'balances.link'
  | 'allowances.usdc_position'
  | 'allowances.usdc_treasury'
  | 'allowances.link_oracle';

// Stable enum, additive forward-compat. Later PRs append new codes.
export type ErrorCode =
  | 'api_error'
  | 'rpc_error'
  | 'balance_below_floor'
  | 'balance_zero'
  | 'allowance_zero'
  | 'password_source_missing';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckError {
  code: ErrorCode;
  retryable: boolean;
}

export interface CheckResult {
  id: CheckId;
  label: string;
  status: CheckStatus;
  blockingFor: CapabilityId[];
  details?: string;
  remediation?: string;
  data?: Record<string, unknown>;
  dependsOn?: CheckId[];
  error?: CheckError;
}

export interface CapabilityRollup {
  ok: boolean;
  worstStatus: 'ok' | 'warn' | 'fail';
  blockingChecks: CheckId[];
}

export interface SummaryBlock {
  ok: boolean;
  counts: { ok: number; warn: number; fail: number; skip: number };
  worstStatus: 'ok' | 'warn' | 'fail';
  byCapability: {
    matchCommitments: CapabilityRollup;
    submitCommitments: CapabilityRollup;
    createContests: CapabilityRollup;
  };
}

export interface MetaBlock {
  generatedAt: string;
  cliVersion: string;
  sdkVersion: string;
}

// ── check runner ──────────────────────────────────────────────────────

/**
 * Pre-fetched inputs for the check runner. Each section can be `null`
 * when the underlying fetch failed; the runner translates that to a
 * structured `fail` line for the affected checks without throwing.
 *
 * This is the shape that lets the doctor catch RPC / API errors at the
 * fetch site, attach a human message to the corresponding `*Error`
 * field, and still produce a complete envelope.
 */
export interface ChecksInputs {
  apiOk: boolean;
  apiError?: string;
  balances: BalancesSnapshot | null;
  balancesError?: string;
  approvals: ApprovalsSnapshot | null;
  approvalsError?: string;
  /** Resolved wallet address, or `null` if --json/non-TTY mode couldn't derive it without prompting. */
  signerAddress: string | null;
  signerAddressError?: string;
}

const ALL_CAPABILITIES: CapabilityId[] = [
  'matchCommitments',
  'submitCommitments',
  'createContests',
];

export function runDoctorChecks(inputs: ChecksInputs): CheckResult[] {
  return [
    checkConnectivityApi(inputs),
    checkSignerAddressKnown(inputs),
    checkBalancesNative(inputs),
    checkBalancesUsdc(inputs),
    checkBalancesLink(inputs),
    checkAllowancesUsdcPosition(inputs),
    checkAllowancesUsdcTreasury(inputs),
    checkAllowancesLinkOracle(inputs),
  ];
}

// Every write goes through the core API: commitments POST, match resolve,
// contests script-approval fetch. apiOk=false blocks every capability.
function checkConnectivityApi(inputs: ChecksInputs): CheckResult {
  if (inputs.apiOk) {
    return {
      id: 'connectivity.api',
      label: 'Core API reachable',
      status: 'ok',
      blockingFor: [...ALL_CAPABILITIES],
    };
  }
  const result: CheckResult = {
    id: 'connectivity.api',
    label: 'Core API reachable',
    status: 'fail',
    blockingFor: [...ALL_CAPABILITIES],
    remediation:
      'Check network connectivity to api.ospex.org. If this persists, the API may be temporarily down.',
    error: { code: 'api_error', retryable: true },
  };
  if (inputs.apiError !== undefined) result.details = inputs.apiError;
  return result;
}

// Doctor-side enforcement of the no-prompt rule in §12. The doctor
// command sets `signerAddress: null` when --json / non-TTY mode would
// otherwise require an interactive unlock; this check turns that into a
// structured failure instead of a hang.
function checkSignerAddressKnown(inputs: ChecksInputs): CheckResult {
  if (inputs.signerAddress !== null) {
    return {
      id: 'signer.address_known',
      label: 'Wallet address resolved',
      status: 'ok',
      blockingFor: [...ALL_CAPABILITIES],
      data: { address: inputs.signerAddress.toLowerCase() },
    };
  }
  const result: CheckResult = {
    id: 'signer.address_known',
    label: 'Wallet address resolved',
    status: 'fail',
    blockingFor: [...ALL_CAPABILITIES],
    details:
      inputs.signerAddressError ??
      'address could not be derived without unlocking the keystore',
    remediation:
      'Pass --address <0x...> for a read-only check, or configure a non-interactive ' +
      'signer via `ospex auth use-foundry --account <name> --password-file <path>`.',
    error: { code: 'password_source_missing', retryable: false },
  };
  return result;
}

function checkBalancesNative(inputs: ChecksInputs): CheckResult {
  if (inputs.balances === null) {
    return skipChainCheck(
      'balances.native',
      'POL balance ≥ gas floor',
      inputs.balancesError ?? 'balance read failed',
      [...ALL_CAPABILITIES],
    );
  }
  const raw = inputs.balances.native;
  const data = formatNativeData(raw);
  if (raw >= POL_GAS_FLOOR_WEI) {
    return {
      id: 'balances.native',
      label: 'POL balance ≥ gas floor',
      status: 'ok',
      blockingFor: [...ALL_CAPABILITIES],
      data,
    };
  }
  return {
    id: 'balances.native',
    label: 'POL balance ≥ gas floor',
    status: 'fail',
    blockingFor: [...ALL_CAPABILITIES],
    details: 'no POL — no tx will land',
    remediation: 'Fund this wallet with POL for gas.',
    data,
    error: { code: 'balance_below_floor', retryable: false },
  };
}

function checkBalancesUsdc(inputs: ChecksInputs): CheckResult {
  const blocking: CapabilityId[] = ['matchCommitments', 'submitCommitments'];
  if (inputs.balances === null) {
    return skipChainCheck(
      'balances.usdc',
      'USDC balance > 0',
      inputs.balancesError ?? 'balance read failed',
      blocking,
    );
  }
  const raw = inputs.balances.usdc;
  const data = { raw: raw.toString(), formatted: formatUnits(raw, 6), decimals: 6 };
  if (raw > 0n) {
    return {
      id: 'balances.usdc',
      label: 'USDC balance > 0',
      status: 'ok',
      blockingFor: blocking,
      data,
    };
  }
  return {
    id: 'balances.usdc',
    label: 'USDC balance > 0',
    status: 'fail',
    blockingFor: blocking,
    details: 'no USDC balance',
    remediation: 'Fund this wallet with USDC before placing or matching bets.',
    data,
    error: { code: 'balance_zero', retryable: false },
  };
}

// LINK is only needed for contest creation; bettors and pure matchers
// never see this fail block them.
function checkBalancesLink(inputs: ChecksInputs): CheckResult {
  const blocking: CapabilityId[] = ['createContests'];
  if (inputs.balances === null) {
    return skipChainCheck(
      'balances.link',
      'LINK balance ≥ dust floor',
      inputs.balancesError ?? 'balance read failed',
      blocking,
    );
  }
  const raw = inputs.balances.link;
  const data = {
    raw: raw.toString(),
    formatted: trimDecimal(formatUnits(raw, 18), 6),
    decimals: 18,
  };
  if (raw >= LINK_DUST_FLOOR_WEI) {
    return {
      id: 'balances.link',
      label: 'LINK balance ≥ dust floor',
      status: 'ok',
      blockingFor: blocking,
      data,
    };
  }
  return {
    id: 'balances.link',
    label: 'LINK balance ≥ dust floor',
    status: 'fail',
    blockingFor: blocking,
    details: 'no LINK balance — only required for contest creation',
    remediation: 'Fund this wallet with LINK if you intend to create contests.',
    data,
    error: { code: 'balance_below_floor', retryable: false },
  };
}

function checkAllowancesUsdcPosition(inputs: ChecksInputs): CheckResult {
  const blocking: CapabilityId[] = ['matchCommitments', 'submitCommitments'];
  if (inputs.approvals === null) {
    return skipChainCheck(
      'allowances.usdc_position',
      'USDC → PositionModule approved',
      inputs.approvalsError ?? 'approval read failed',
      blocking,
    );
  }
  const entry = inputs.approvals.usdc.allowances.positionModule;
  const data = serializeAllowanceData(entry.raw, entry.spender, 6);
  if (entry.raw > 0n) {
    return {
      id: 'allowances.usdc_position',
      label: 'USDC → PositionModule approved',
      status: 'ok',
      blockingFor: blocking,
      data,
    };
  }
  return {
    id: 'allowances.usdc_position',
    label: 'USDC → PositionModule approved',
    status: 'fail',
    blockingFor: blocking,
    details: 'PositionModule USDC not approved',
    remediation: 'Run `ospex approvals setup --risk-usdc <amount>` to approve.',
    data,
    error: { code: 'allowance_zero', retryable: false },
  };
}

// USDC → TreasuryModule blocks createContests (creation fee) and the
// first lazy-creation match (maker pays half of the speculation
// creation fee). The lazy-creation case is preflighted by the SDK on
// submit so most agents never see it; documented in `details`.
function checkAllowancesUsdcTreasury(inputs: ChecksInputs): CheckResult {
  const blocking: CapabilityId[] = ['createContests'];
  if (inputs.approvals === null) {
    return skipChainCheck(
      'allowances.usdc_treasury',
      'USDC → TreasuryModule approved',
      inputs.approvalsError ?? 'approval read failed',
      blocking,
    );
  }
  const entry = inputs.approvals.usdc.allowances.treasuryModule;
  const data = serializeAllowanceData(entry.raw, entry.spender, 6);
  if (entry.raw > 0n) {
    return {
      id: 'allowances.usdc_treasury',
      label: 'USDC → TreasuryModule approved',
      status: 'ok',
      blockingFor: blocking,
      data,
    };
  }
  return {
    id: 'allowances.usdc_treasury',
    label: 'USDC → TreasuryModule approved',
    status: 'fail',
    blockingFor: blocking,
    details:
      'TreasuryModule USDC not approved — required for contest creation, and for the first ' +
      'lazy-creation match on a fresh speculation key (preflighted by the SDK on submit).',
    remediation: 'Run `ospex approvals setup --create-fee-usdc <amount>` to approve.',
    data,
    error: { code: 'allowance_zero', retryable: false },
  };
}

function checkAllowancesLinkOracle(inputs: ChecksInputs): CheckResult {
  const blocking: CapabilityId[] = ['createContests'];
  if (inputs.approvals === null) {
    return skipChainCheck(
      'allowances.link_oracle',
      'LINK → OracleModule approved',
      inputs.approvalsError ?? 'approval read failed',
      blocking,
    );
  }
  const entry = inputs.approvals.link.allowances.oracleModule;
  const data = serializeAllowanceData(entry.raw, entry.spender, 18);
  if (entry.raw > 0n) {
    return {
      id: 'allowances.link_oracle',
      label: 'LINK → OracleModule approved',
      status: 'ok',
      blockingFor: blocking,
      data,
    };
  }
  return {
    id: 'allowances.link_oracle',
    label: 'LINK → OracleModule approved',
    status: 'fail',
    blockingFor: blocking,
    details: 'OracleModule LINK not approved — only required for contest creation.',
    remediation: 'Run `ospex approvals setup --link <amount>` to approve.',
    data,
    error: { code: 'allowance_zero', retryable: false },
  };
}

// PR 1 doesn't have a structured `connectivity.rpc` check yet (PR 2),
// so a balance/approval read failure just gets a generic skip with the
// underlying error as `details`. When PR 2 lands, `dependsOn` here will
// be `['connectivity.rpc']` so the cascade is traceable.
function skipChainCheck(
  id: CheckId,
  label: string,
  details: string,
  blocking: CapabilityId[],
): CheckResult {
  return {
    id,
    label,
    status: 'skip',
    blockingFor: blocking,
    details,
    dependsOn: [],
  };
}

// ── rollup ────────────────────────────────────────────────────────────

const ALL_CAPABILITY_IDS: CapabilityId[] = [
  'matchCommitments',
  'submitCommitments',
  'createContests',
];

export function buildSummary(checks: readonly CheckResult[]): SummaryBlock {
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status] += 1;
  const worstStatus = pickWorst(checks.map((c) => c.status));
  const ok = counts.fail === 0;

  const byCapability = ALL_CAPABILITY_IDS.reduce(
    (acc, cap) => {
      acc[cap] = rollupForCapability(checks, cap);
      return acc;
    },
    {} as SummaryBlock['byCapability'],
  );

  return { ok, counts, worstStatus, byCapability };
}

function rollupForCapability(
  checks: readonly CheckResult[],
  cap: CapabilityId,
): CapabilityRollup {
  const relevant = checks.filter((c) => c.blockingFor.includes(cap));
  return {
    // A capability is "actionable" only when every blocking-relevant
    // check is `ok`. `warn` (degraded) and `skip` (unknown) both fail
    // the gate, since the agent shouldn't proceed under either.
    ok: relevant.every((c) => c.status === 'ok'),
    worstStatus: pickWorst(relevant.map((c) => c.status)),
    blockingChecks: relevant.filter((c) => c.status !== 'ok').map((c) => c.id),
  };
}

// `skip` rolls up as `warn` — we don't know enough to call it ok, but
// it's not a hard fail (the upstream dependency that caused the skip
// is the actual fail, and it'll be reported there).
function pickWorst(statuses: CheckStatus[]): 'ok' | 'warn' | 'fail' {
  let worst: 'ok' | 'warn' | 'fail' = 'ok';
  for (const s of statuses) {
    if (s === 'fail') return 'fail';
    if (s === 'warn' || s === 'skip') worst = 'warn';
  }
  return worst;
}

// ── meta block ────────────────────────────────────────────────────────

/**
 * Build the `meta` block. Reads CLI + SDK versions from package.json
 * synchronously at call time. Defaults to `'unknown'` if either read
 * fails — the doctor must never crash on a missing/malformed
 * package.json, so this is intentionally lenient.
 *
 * The SDK path uses `createRequire` + the SDK's `./package.json`
 * exports entry (added in PR 1 alongside this helper). If the SDK ever
 * drops that exports entry, the SDK version reads as `'unknown'`
 * rather than the doctor failing.
 */
export function buildMeta(): MetaBlock {
  return {
    generatedAt: new Date().toISOString(),
    cliVersion: readCliVersion(),
    sdkVersion: readSdkVersion(),
  };
}

function readCliVersion(): string {
  // Walk up two levels: `src/lib/doctorChecks.ts` → `src/` → `packages/cli/`.
  // After compile: `dist/lib/doctorChecks.js` → `dist/` → `packages/cli/`.
  // Both resolve to the same on-disk file.
  const url = new URL('../../package.json', import.meta.url);
  return safeReadVersion(url);
}

function readSdkVersion(): string {
  try {
    const r = createRequire(import.meta.url);
    const resolved = r.resolve('@ospex/sdk/package.json');
    return safeReadVersion(pathToFileURL(resolved));
  } catch {
    return 'unknown';
  }
}

function safeReadVersion(url: URL): string {
  try {
    const text = readFileSync(fileURLToPath(url), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      typeof (parsed as { version: unknown }).version === 'string'
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // ignore — version reads are best-effort, never load-bearing
  }
  return 'unknown';
}

// ── helpers ───────────────────────────────────────────────────────────

function formatNativeData(raw: bigint): Record<string, unknown> {
  return {
    raw: raw.toString(),
    formatted: trimDecimal(formatUnits(raw, 18), 6),
    decimals: 18,
  };
}

function serializeAllowanceData(
  raw: bigint,
  spender: string,
  decimals: number,
): Record<string, unknown> {
  return {
    raw: raw.toString(),
    formatted:
      decimals === 6 ? formatUnits(raw, 6) : trimDecimal(formatUnits(raw, decimals), 6),
    decimals,
    spender,
  };
}

function trimDecimal(value: string, fractionDigits: number): string {
  const dot = value.indexOf('.');
  if (dot === -1) return value;
  const intPart = value.slice(0, dot);
  const fracPart = value
    .slice(dot + 1)
    .slice(0, fractionDigits)
    .replace(/0+$/, '');
  return fracPart.length === 0 ? intPart : `${intPart}.${fracPart}`;
}
