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
import type { ExpectedChainIdSource } from './config.js';
import type { ContractCheckResult, RpcProbeResult } from './doctorProbe.js';

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
  | 'connectivity.rpc'
  | 'config.chain_id_expected'
  | 'network.chain_id_match'
  | 'network.contracts_deployed'
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
  | 'rpc_timeout'
  | 'chain_id_mismatch'
  | 'contract_not_deployed'
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
 *
 * `expectedChainId` is resolved upstream by `resolveExpectedChainId`
 * (env > config > default 137). `rpcProbe` and `contractCheck` come
 * from the probes in `doctorProbe.ts`. Both may be `null` if the
 * doctor decided not to run them (e.g. no rpcUrl configured) — the
 * affected checks skip cleanly.
 *
 * PR 2 fields are marked optional so PR 1-era callers (and tests
 * predating the probes) compile and run without churning every call
 * site. The runner normalizes `undefined` to the documented default
 * (`null` or `false`) at entry.
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
  // PR 2 additions: chain probes + expected chain id.
  expectedChainId?: { value: 137 | 80002; source: ExpectedChainIdSource } | null;
  rpcProbe?: RpcProbeResult | null;
  contractCheck?: ContractCheckResult | null;
  /** True when no rpcUrl was configured — drives the skip cascade for
   *  every chain-touching check. PR 2 doesn't yet ship the structured
   *  `config.rpc_url` check (that's PR 3); for now this flag flows
   *  into the connectivity.rpc message. */
  rpcUrlMissing?: boolean;
}

interface NormalizedChecksInputs extends ChecksInputs {
  expectedChainId: { value: 137 | 80002; source: ExpectedChainIdSource } | null;
  rpcProbe: RpcProbeResult | null;
  contractCheck: ContractCheckResult | null;
  rpcUrlMissing: boolean;
}

function normalize(inputs: ChecksInputs): NormalizedChecksInputs {
  return {
    ...inputs,
    expectedChainId: inputs.expectedChainId ?? null,
    rpcProbe: inputs.rpcProbe ?? null,
    contractCheck: inputs.contractCheck ?? null,
    rpcUrlMissing: inputs.rpcUrlMissing ?? false,
  };
}

const ALL_CAPABILITIES: CapabilityId[] = [
  'matchCommitments',
  'submitCommitments',
  'createContests',
];

export function runDoctorChecks(rawInputs: ChecksInputs): CheckResult[] {
  // Normalize PR 2 fields so check functions can rely on the guaranteed
  // shape — saves a `?? null` at every call site.
  const inputs = normalize(rawInputs);
  // Order matters for human-renderer scanability: config → connectivity
  // → network → identity → balances → allowances. Agents iterate by id
  // so the order is purely display.
  return [
    checkConfigChainIdExpected(inputs),
    checkConnectivityApi(inputs),
    checkConnectivityRpc(inputs),
    checkNetworkChainIdMatch(inputs),
    checkNetworkContractsDeployed(inputs),
    checkSignerAddressKnown(inputs),
    checkBalancesNative(inputs),
    checkBalancesUsdc(inputs),
    checkBalancesLink(inputs),
    checkAllowancesUsdcPosition(inputs),
    checkAllowancesUsdcTreasury(inputs),
    checkAllowancesLinkOracle(inputs),
  ];
}

// ── PR 2: chain provenance + probes ───────────────────────────────────

// Expected chain id provenance. `warn` only when the source is the
// implicit default — the user hasn't explicitly chosen a chain, and a
// wrong-RPC scenario can silently look "fine" until a tx reverts.
// Once they set OSPEX_CHAIN_ID or config.chainId, this flips to ok.
function checkConfigChainIdExpected(inputs: NormalizedChecksInputs): CheckResult {
  if (inputs.expectedChainId === null) {
    return {
      id: 'config.chain_id_expected',
      label: 'Expected chain ID configured',
      status: 'skip',
      blockingFor: [],
      details: 'expected chain id not resolved',
      dependsOn: [],
    };
  }
  const { value, source } = inputs.expectedChainId;
  const data: Record<string, unknown> = { expected: value, expectedSource: source };
  if (source === 'default') {
    return {
      id: 'config.chain_id_expected',
      label: 'Expected chain ID configured',
      status: 'warn',
      blockingFor: [],
      details: `falling back to default chain id ${value} — set OSPEX_CHAIN_ID or run \`ospex init\` to make this explicit`,
      data,
    };
  }
  return {
    id: 'config.chain_id_expected',
    label: 'Expected chain ID configured',
    status: 'ok',
    blockingFor: [],
    data,
  };
}

// RPC liveness. Fails on transport error / timeout / malformed
// response. Every chain-touching check downstream skips when this
// fails (declared via `dependsOn`).
function checkConnectivityRpc(inputs: NormalizedChecksInputs): CheckResult {
  if (inputs.rpcProbe === null) {
    // Distinguish "doctor tried but rpcUrl wasn't configured" (fail)
    // from "probe wasn't attempted by this caller" (skip — typical
    // unit-test path that didn't construct probe inputs).
    if (inputs.rpcUrlMissing) {
      return {
        id: 'connectivity.rpc',
        label: 'RPC reachable',
        status: 'fail',
        blockingFor: [...ALL_CAPABILITIES],
        details: 'rpcUrl not configured — run `ospex init` to set one',
        remediation:
          'Run `ospex init` and supply an RPC URL (Alchemy / Infura / QuickNode strongly recommended over public RPCs).',
        error: { code: 'rpc_error', retryable: false },
      };
    }
    return {
      id: 'connectivity.rpc',
      label: 'RPC reachable',
      status: 'skip',
      blockingFor: [...ALL_CAPABILITIES],
      details: 'rpc probe did not run',
    };
  }
  if (inputs.rpcProbe.ok) {
    return {
      id: 'connectivity.rpc',
      label: 'RPC reachable',
      status: 'ok',
      blockingFor: [...ALL_CAPABILITIES],
      data: {
        urlHost: inputs.rpcProbe.urlHost,
        durationMs: inputs.rpcProbe.durationMs,
        chainId: inputs.rpcProbe.chainId,
        blockNumber: inputs.rpcProbe.blockNumber.toString(),
        blockTimestamp: inputs.rpcProbe.blockTimestamp.toString(),
        blockAgeSec: inputs.rpcProbe.blockAgeSec,
      },
    };
  }
  // Transport error / timeout. Distinguish timeout from other errors
  // so agents can retry timeouts with backoff but treat 401 / DNS
  // errors as config bugs.
  const isTimeout = /\btimeout\b/i.test(inputs.rpcProbe.error);
  return {
    id: 'connectivity.rpc',
    label: 'RPC reachable',
    status: 'fail',
    blockingFor: [...ALL_CAPABILITIES],
    details: inputs.rpcProbe.error,
    remediation: 'Verify rpcUrl is reachable and the API key (if any) is valid.',
    data: {
      urlHost: inputs.rpcProbe.urlHost,
      durationMs: inputs.rpcProbe.durationMs,
    },
    error: { code: isTimeout ? 'rpc_timeout' : 'rpc_error', retryable: true },
  };
}

// Cross-check: does the RPC actually speak the chain the SDK was
// configured for? Catches pointed-at-wrong-network — a common
// foot-gun when copy-pasting an Alchemy URL between environments.
function checkNetworkChainIdMatch(inputs: NormalizedChecksInputs): CheckResult {
  if (inputs.rpcProbe === null || !inputs.rpcProbe.ok) {
    return {
      id: 'network.chain_id_match',
      label: 'RPC chain id matches expected',
      status: 'skip',
      blockingFor: [...ALL_CAPABILITIES],
      details: 'RPC unreachable — cannot compare',
      dependsOn: ['connectivity.rpc'],
    };
  }
  if (inputs.expectedChainId === null) {
    return {
      id: 'network.chain_id_match',
      label: 'RPC chain id matches expected',
      status: 'skip',
      blockingFor: [...ALL_CAPABILITIES],
      details: 'expected chain id not resolved',
      dependsOn: ['config.chain_id_expected'],
    };
  }
  const expected = inputs.expectedChainId.value;
  const actual = inputs.rpcProbe.chainId;
  if (expected === actual) {
    return {
      id: 'network.chain_id_match',
      label: 'RPC chain id matches expected',
      status: 'ok',
      blockingFor: [...ALL_CAPABILITIES],
      data: { expected, actual },
    };
  }
  return {
    id: 'network.chain_id_match',
    label: 'RPC chain id matches expected',
    status: 'fail',
    blockingFor: [...ALL_CAPABILITIES],
    details: `RPC reports chain ${actual}, expected ${expected}`,
    remediation:
      `Either set OSPEX_CHAIN_ID=${actual} if this RPC is intentional, or point rpcUrl at chain ${expected}.`,
    data: { expected, actual },
    error: { code: 'chain_id_mismatch', retryable: false },
  };
}

// `eth_getCode` for each of the SDK's expected contract addresses on
// the EXPECTED chain. Catches wrong-environment-same-chainid (private
// fork that reports the right chain id but doesn't have Ospex
// deployed). Skips when chain id mismatch is already flagged — no
// point reporting "everything missing" when the cause is the wrong
// chain entirely.
function checkNetworkContractsDeployed(inputs: NormalizedChecksInputs): CheckResult {
  if (inputs.rpcProbe === null || !inputs.rpcProbe.ok) {
    return {
      id: 'network.contracts_deployed',
      label: 'Expected contracts deployed on this RPC',
      status: 'skip',
      blockingFor: [...ALL_CAPABILITIES],
      details: 'RPC unreachable — cannot probe contracts',
      dependsOn: ['connectivity.rpc'],
    };
  }
  if (
    inputs.expectedChainId !== null &&
    inputs.rpcProbe.chainId !== inputs.expectedChainId.value
  ) {
    return {
      id: 'network.contracts_deployed',
      label: 'Expected contracts deployed on this RPC',
      status: 'skip',
      blockingFor: [...ALL_CAPABILITIES],
      details: 'chain id mismatch — contracts probe is moot until RPC is on the expected chain',
      dependsOn: ['network.chain_id_match'],
    };
  }
  if (inputs.contractCheck === null) {
    return {
      id: 'network.contracts_deployed',
      label: 'Expected contracts deployed on this RPC',
      status: 'skip',
      blockingFor: [...ALL_CAPABILITIES],
      details: 'contracts probe did not run',
      dependsOn: ['connectivity.rpc'],
    };
  }
  if ('unavailable' in inputs.contractCheck) {
    return {
      id: 'network.contracts_deployed',
      label: 'Expected contracts deployed on this RPC',
      status: 'skip',
      blockingFor: [...ALL_CAPABILITIES],
      details: inputs.contractCheck.reason,
    };
  }
  const { checked, missing, partial } = inputs.contractCheck;
  const data = { checked, missing, partial };
  if (missing.length === 0 && !partial) {
    return {
      id: 'network.contracts_deployed',
      label: 'Expected contracts deployed on this RPC',
      status: 'ok',
      blockingFor: [...ALL_CAPABILITIES],
      data,
    };
  }
  // Partial probe (some getBytecode calls errored) → warn rather than
  // hard fail, since we couldn't conclude they're missing. Full miss
  // is a real fail.
  if (partial && missing.length === 0) {
    return {
      id: 'network.contracts_deployed',
      label: 'Expected contracts deployed on this RPC',
      status: 'warn',
      blockingFor: [...ALL_CAPABILITIES],
      details: 'some bytecode lookups failed — could not confirm all contracts',
      data,
    };
  }
  return {
    id: 'network.contracts_deployed',
    label: 'Expected contracts deployed on this RPC',
    status: 'fail',
    blockingFor: [...ALL_CAPABILITIES],
    details: `missing bytecode at: ${missing.join(', ')}`,
    remediation:
      'This RPC does not have the SDK-expected Ospex contracts deployed. ' +
      'Check that rpcUrl points at the right environment (mainnet vs Amoy vs local fork).',
    data,
    error: { code: 'contract_not_deployed', retryable: false },
  };
}

// ── PR 1 checks (preserved) ───────────────────────────────────────────

// Every write goes through the core API: commitments POST, match resolve,
// contests script-approval fetch. apiOk=false blocks every capability.
function checkConnectivityApi(inputs: NormalizedChecksInputs): CheckResult {
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
function checkSignerAddressKnown(inputs: NormalizedChecksInputs): CheckResult {
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

function checkBalancesNative(inputs: NormalizedChecksInputs): CheckResult {
  return classifyChainCheck(
    inputs,
    'balances.native',
    'POL balance ≥ gas floor',
    [...ALL_CAPABILITIES],
    inputs.balances === null ? null : inputs.balances.native,
    inputs.balancesError,
    (raw) => {
      const data = formatNativeData(raw);
      if (raw >= POL_GAS_FLOOR_WEI) return { status: 'ok', data };
      return {
        status: 'fail',
        details: 'no POL — no tx will land',
        remediation: 'Fund this wallet with POL for gas.',
        data,
        error: { code: 'balance_below_floor', retryable: false },
      };
    },
  );
}

function checkBalancesUsdc(inputs: NormalizedChecksInputs): CheckResult {
  const blocking: CapabilityId[] = ['matchCommitments', 'submitCommitments'];
  return classifyChainCheck(
    inputs,
    'balances.usdc',
    'USDC balance > 0',
    blocking,
    inputs.balances === null ? null : inputs.balances.usdc,
    inputs.balancesError,
    (raw) => {
      const data = { raw: raw.toString(), formatted: formatUnits(raw, 6), decimals: 6 };
      if (raw > 0n) return { status: 'ok', data };
      return {
        status: 'fail',
        details: 'no USDC balance',
        remediation: 'Fund this wallet with USDC before placing or matching bets.',
        data,
        error: { code: 'balance_zero', retryable: false },
      };
    },
  );
}

// LINK is only needed for contest creation; bettors and pure matchers
// never see this fail block them.
function checkBalancesLink(inputs: NormalizedChecksInputs): CheckResult {
  return classifyChainCheck(
    inputs,
    'balances.link',
    'LINK balance ≥ dust floor',
    ['createContests'],
    inputs.balances === null ? null : inputs.balances.link,
    inputs.balancesError,
    (raw) => {
      const data = {
        raw: raw.toString(),
        formatted: trimDecimal(formatUnits(raw, 18), 6),
        decimals: 18,
      };
      if (raw >= LINK_DUST_FLOOR_WEI) return { status: 'ok', data };
      return {
        status: 'fail',
        details: 'no LINK balance — only required for contest creation',
        remediation: 'Fund this wallet with LINK if you intend to create contests.',
        data,
        error: { code: 'balance_below_floor', retryable: false },
      };
    },
  );
}

function checkAllowancesUsdcPosition(inputs: NormalizedChecksInputs): CheckResult {
  const blocking: CapabilityId[] = ['matchCommitments', 'submitCommitments'];
  return classifyChainCheck(
    inputs,
    'allowances.usdc_position',
    'USDC → PositionModule approved',
    blocking,
    inputs.approvals === null ? null : inputs.approvals.usdc.allowances.positionModule,
    inputs.approvalsError,
    (entry) => {
      const data = serializeAllowanceData(entry.raw, entry.spender, 6);
      if (entry.raw > 0n) return { status: 'ok', data };
      return {
        status: 'fail',
        details: 'PositionModule USDC not approved',
        remediation: 'Run `ospex approvals setup --risk-usdc <amount>` to approve.',
        data,
        error: { code: 'allowance_zero', retryable: false },
      };
    },
  );
}

// USDC → TreasuryModule blocks createContests (creation fee) and the
// first lazy-creation match (maker pays half of the speculation
// creation fee). The lazy-creation case is preflighted by the SDK on
// submit so most agents never see it; documented in `details`.
function checkAllowancesUsdcTreasury(inputs: NormalizedChecksInputs): CheckResult {
  return classifyChainCheck(
    inputs,
    'allowances.usdc_treasury',
    'USDC → TreasuryModule approved',
    ['createContests'],
    inputs.approvals === null ? null : inputs.approvals.usdc.allowances.treasuryModule,
    inputs.approvalsError,
    (entry) => {
      const data = serializeAllowanceData(entry.raw, entry.spender, 6);
      if (entry.raw > 0n) return { status: 'ok', data };
      return {
        status: 'fail',
        details:
          'TreasuryModule USDC not approved — required for contest creation, and for the first ' +
          'lazy-creation match on a fresh speculation key (preflighted by the SDK on submit).',
        remediation: 'Run `ospex approvals setup --create-fee-usdc <amount>` to approve.',
        data,
        error: { code: 'allowance_zero', retryable: false },
      };
    },
  );
}

function checkAllowancesLinkOracle(inputs: NormalizedChecksInputs): CheckResult {
  return classifyChainCheck(
    inputs,
    'allowances.link_oracle',
    'LINK → OracleModule approved',
    ['createContests'],
    inputs.approvals === null ? null : inputs.approvals.link.allowances.oracleModule,
    inputs.approvalsError,
    (entry) => {
      const data = serializeAllowanceData(entry.raw, entry.spender, 18);
      if (entry.raw > 0n) return { status: 'ok', data };
      return {
        status: 'fail',
        details: 'OracleModule LINK not approved — only required for contest creation.',
        remediation: 'Run `ospex approvals setup --link <amount>` to approve.',
        data,
        error: { code: 'allowance_zero', retryable: false },
      };
    },
  );
}

// ── chain-check cascade plumbing ──────────────────────────────────────

/**
 * Common cascade logic for the 6 balance/allowance checks. Encodes
 * the three upstream conditions that affect their interpretation:
 *
 *   1. Snapshot is `null` → skip with `dependsOn` pointing at whichever
 *      upstream check actually caused the absence (RPC down, no signer).
 *   2. Chain id mismatched → snapshot exists but values are from the
 *      wrong chain. Downgrade to `warn` with a clear details message
 *      regardless of the underlying value (a zero on the wrong chain
 *      tells you nothing about the expected chain). Per spec §11.2.
 *   3. Otherwise → delegate to the per-check `classify` callback for
 *      the normal ok/fail decision.
 */
function classifyChainCheck<T>(
  inputs: NormalizedChecksInputs,
  id: CheckId,
  label: string,
  blocking: CapabilityId[],
  value: T | null,
  errorMessage: string | undefined,
  classify: (value: T) => {
    status: 'ok' | 'fail';
    data: Record<string, unknown>;
    details?: string;
    remediation?: string;
    error?: CheckError;
  },
): CheckResult {
  if (value === null) {
    return {
      id,
      label,
      status: 'skip',
      blockingFor: blocking,
      details: errorMessage ?? 'chain read did not run',
      dependsOn: chainReadDependsOn(inputs),
    };
  }
  const mismatch = chainMismatch(inputs);
  if (mismatch !== null) {
    const inner = classify(value);
    return {
      id,
      label,
      status: 'warn',
      blockingFor: blocking,
      details: `chain mismatch — value from chain ${mismatch.actual}, not expected ${mismatch.expected}`,
      data: inner.data,
    };
  }
  const inner = classify(value);
  const result: CheckResult = {
    id,
    label,
    status: inner.status,
    blockingFor: blocking,
    data: inner.data,
  };
  if (inner.details !== undefined) result.details = inner.details;
  if (inner.remediation !== undefined) result.remediation = inner.remediation;
  if (inner.error !== undefined) result.error = inner.error;
  return result;
}

// Which upstream check to point at when a chain read didn't happen.
// RPC down is most fundamental; signer-unresolvable is next. PR 3
// will add `config.rpc_url` as a third source.
function chainReadDependsOn(inputs: NormalizedChecksInputs): CheckId[] {
  if (inputs.rpcUrlMissing) return ['connectivity.rpc'];
  if (inputs.rpcProbe !== null && !inputs.rpcProbe.ok) return ['connectivity.rpc'];
  if (inputs.signerAddress === null) return ['signer.address_known'];
  return [];
}

function chainMismatch(inputs: NormalizedChecksInputs): { expected: number; actual: number } | null {
  if (inputs.rpcProbe === null || !inputs.rpcProbe.ok) return null;
  if (inputs.expectedChainId === null) return null;
  if (inputs.rpcProbe.chainId === inputs.expectedChainId.value) return null;
  return { expected: inputs.expectedChainId.value, actual: inputs.rpcProbe.chainId };
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
  // `summary.ok` is the strict top-level "can the agent proceed?" boolean.
  // Requires every check to be `ok` — `warn` (advisory) and `skip` (unknown)
  // both flip it false. Anything weaker is a false-positive footgun: an
  // envelope with chain-reads-failed produces 6 `skip` lines and 0 `fail`,
  // so a `counts.fail === 0` rule would say `ok: true` while every
  // `byCapability.*.ok` is false and the process exits 1. Hermes PR 52
  // blocker; the strict semantic also matches `worstStatus === 'ok'`.
  const ok = worstStatus === 'ok';

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
