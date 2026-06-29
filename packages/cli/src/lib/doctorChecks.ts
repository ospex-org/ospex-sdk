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

import { formatUnits } from 'viem';
import { CLI_VERSION, SDK_VERSION } from './version.js';
import type { ApprovalsSnapshot, BalancesSnapshot } from '@ospex/sdk';
import type {
  ApiUrlSource,
  ExpectedChainIdSource,
  ResolvedApiUrl,
  ResolvedRpcUrl,
  RpcUrlSource,
} from './config.js';
import type {
  AuthSourceResolution,
  PasswordFilePermissions,
} from './authResolution.js';
import type { ContractCheckResult, RpcProbeResult } from './doctorProbe.js';

// ── thresholds (mirrored from doctorRender.ts) ────────────────────────
//
// These intentionally match the renderer's "effectively zero" floors so
// the structured checks never disagree with the human-rendered balance
// annotations. If you change one, change the other.
const POL_GAS_FLOOR_WEI = 100_000_000_000_000n;

// ── envelope types ────────────────────────────────────────────────────

export type CapabilityId =
  | 'matchCommitments'
  | 'submitCommitments'
  | 'createContests';

export type CheckId =
  | 'config.api_url'
  | 'config.rpc_url'
  | 'config.chain_id_expected'
  | 'connectivity.api'
  | 'connectivity.rpc'
  | 'network.chain_id_match'
  | 'network.contracts_deployed'
  | 'signer.resolved'
  | 'signer.address_known'
  | 'signer.password_source'
  | 'signer.password_file_perms'
  | 'balances.native'
  | 'balances.usdc'
  | 'allowances.usdc_position'
  | 'allowances.usdc_treasury';

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
  | 'password_source_missing'
  | 'password_file_perms_loose'
  | 'signer_unresolvable'
  | 'config_not_set';

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
  /** Kept for back-compat with PR 2 callers; superseded by
   *  `rpcUrl.value === null` in PR 3. When unset, the runner derives
   *  it from `rpcUrl ?? null`. */
  rpcUrlMissing?: boolean;
  // PR 3 additions: URL provenance.
  apiUrl?: ResolvedApiUrl | null;
  rpcUrl?: ResolvedRpcUrl | null;
  // PR 4 additions: signer provenance via the shared auth-check
  // walker. `authResolution` is the walker's output; the doctor
  // always runs it in non-unlocking mode. `passwordFilePermissions`
  // comes from the same lib helper auth-check uses. `strict` mirrors
  // the user's --strict flag — drives `signer.password_file_perms`
  // from warn (default) to fail.
  authResolution?: AuthSourceResolution | null;
  passwordFilePermissions?: PasswordFilePermissions | null;
  strict?: boolean;
}

interface NormalizedChecksInputs extends ChecksInputs {
  expectedChainId: { value: 137 | 80002; source: ExpectedChainIdSource } | null;
  rpcProbe: RpcProbeResult | null;
  contractCheck: ContractCheckResult | null;
  rpcUrlMissing: boolean;
  apiUrl: ResolvedApiUrl | null;
  rpcUrl: ResolvedRpcUrl | null;
  authResolution: AuthSourceResolution | null;
  passwordFilePermissions: PasswordFilePermissions | null;
  strict: boolean;
}

function normalize(inputs: ChecksInputs): NormalizedChecksInputs {
  const apiUrl = inputs.apiUrl ?? null;
  const rpcUrl = inputs.rpcUrl ?? null;
  // `rpcUrlMissing` is back-compat with PR 2 callers. PR 3 callers
  // supply `rpcUrl` directly and we derive missing-ness from it.
  const rpcUrlMissing =
    inputs.rpcUrlMissing ?? (rpcUrl !== null ? rpcUrl.value === null : false);
  return {
    ...inputs,
    expectedChainId: inputs.expectedChainId ?? null,
    rpcProbe: inputs.rpcProbe ?? null,
    contractCheck: inputs.contractCheck ?? null,
    rpcUrlMissing,
    apiUrl,
    rpcUrl,
    authResolution: inputs.authResolution ?? null,
    passwordFilePermissions: inputs.passwordFilePermissions ?? null,
    strict: inputs.strict ?? false,
  };
}

const ALL_CAPABILITIES: CapabilityId[] = [
  'matchCommitments',
  'submitCommitments',
  'createContests',
];

export function runDoctorChecks(rawInputs: ChecksInputs): CheckResult[] {
  // Normalize PR 2/3 fields so check functions can rely on the
  // guaranteed shape — saves a `?? null` at every call site.
  const inputs = normalize(rawInputs);
  // Order matters for human-renderer scanability: config → connectivity
  // → network → identity → balances → allowances. Agents iterate by id
  // so the order is purely display.
  return [
    checkConfigApiUrl(inputs),
    checkConfigRpcUrl(inputs),
    checkConfigChainIdExpected(inputs),
    checkConnectivityApi(inputs),
    checkConnectivityRpc(inputs),
    checkNetworkChainIdMatch(inputs),
    checkNetworkContractsDeployed(inputs),
    checkSignerResolved(inputs),
    checkSignerAddressKnown(inputs),
    checkSignerPasswordSource(inputs),
    checkSignerPasswordFilePerms(inputs),
    checkBalancesNative(inputs),
    checkBalancesUsdc(inputs),
    checkAllowancesUsdcPosition(inputs),
    checkAllowancesUsdcTreasury(inputs),
  ];
}

// ── PR 3: config URL provenance ───────────────────────────────────────

// API URL always has a documented default (`https://api.ospex.org`),
// so this check never fails. It exists to surface the provenance
// (env / config / default) so agents can diagnose "why does this
// envelope point at a staging API?".
function checkConfigApiUrl(inputs: NormalizedChecksInputs): CheckResult {
  if (inputs.apiUrl === null) {
    // Caller didn't supply detailed config — skip rather than guess.
    return {
      id: 'config.api_url',
      label: 'API URL configured',
      status: 'skip',
      blockingFor: [],
      details: 'api url provenance not resolved',
    };
  }
  return {
    id: 'config.api_url',
    label: 'API URL configured',
    status: 'ok',
    blockingFor: [],
    data: { source: inputs.apiUrl.source },
  };
}

// RPC URL has no default — bring-your-own. Failing this check
// cascades into `connectivity.rpc` and every chain-touching check.
function checkConfigRpcUrl(inputs: NormalizedChecksInputs): CheckResult {
  if (inputs.rpcUrl === null) {
    // Caller didn't supply detailed config — skip rather than fail.
    return {
      id: 'config.rpc_url',
      label: 'RPC URL configured',
      status: 'skip',
      blockingFor: [...ALL_CAPABILITIES],
      details: 'rpc url provenance not resolved',
    };
  }
  if (inputs.rpcUrl.value === null) {
    return {
      id: 'config.rpc_url',
      label: 'RPC URL configured',
      status: 'fail',
      blockingFor: [...ALL_CAPABILITIES],
      details: 'no rpcUrl configured — every chain read will skip',
      remediation:
        'Run `ospex init` and supply an RPC URL (Alchemy / Infura / QuickNode strongly recommended over public RPCs), or export OSPEX_RPC_URL.',
      error: { code: 'config_not_set', retryable: false },
    };
  }
  return {
    id: 'config.rpc_url',
    label: 'RPC URL configured',
    status: 'ok',
    blockingFor: [...ALL_CAPABILITIES],
    data: { source: inputs.rpcUrl.source },
  };
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
    // `config.rpc_url: fail` (rpcUrl unset) is the authoritative
    // signal — skip here with `dependsOn` so agents traverse to the
    // upstream cause rather than seeing two duplicate fails. PR 2
    // surfaced this as a direct fail; PR 3 makes config.rpc_url the
    // canonical source of truth.
    if (inputs.rpcUrlMissing) {
      return {
        id: 'connectivity.rpc',
        label: 'RPC reachable',
        status: 'skip',
        blockingFor: [...ALL_CAPABILITIES],
        details: 'rpcUrl not configured (see config.rpc_url)',
        dependsOn: ['config.rpc_url'],
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
  const { checked, missing, unknown } = inputs.contractCheck;
  const data = { checked, missing, unknown };
  // Confirmed missing wins — it's a definite deployment problem.
  if (missing.length > 0) {
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
  // Lookup errors with no confirmed-missing → warn, not fail. We
  // genuinely don't know if those contracts are deployed; surfacing
  // it as a hard fail would over-claim.
  if (unknown.length > 0) {
    return {
      id: 'network.contracts_deployed',
      label: 'Expected contracts deployed on this RPC',
      status: 'warn',
      blockingFor: [...ALL_CAPABILITIES],
      details: `bytecode lookup failed for: ${unknown.join(', ')} (could not confirm deployment)`,
      data,
    };
  }
  return {
    id: 'network.contracts_deployed',
    label: 'Expected contracts deployed on this RPC',
    status: 'ok',
    blockingFor: [...ALL_CAPABILITIES],
    data,
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

// ── PR 4: signer provenance via the shared auth-check walker ────────

// "Is there a usable keystore at all?" Walker resolves a path and
// checks existence. The default-legacy fallback can still produce
// `provenance: 'default-legacy'` with `exists: false` — that's the
// signer-not-configured case. Session-cache path is a carve-out:
// when the session has a fresh entry, the keystore file isn't
// consulted, so a non-existent legacy keystore still permits unlock.
function checkSignerResolved(inputs: NormalizedChecksInputs): CheckResult {
  const res = inputs.authResolution;
  if (res === null) {
    return {
      id: 'signer.resolved',
      label: 'Signer source resolved',
      status: 'skip',
      blockingFor: [...ALL_CAPABILITIES],
      details: 'auth resolution not run',
    };
  }
  const sessionWillUnlock = res.password.provenance === 'session-cache';
  if (!res.keystore.exists && !sessionWillUnlock) {
    return {
      id: 'signer.resolved',
      label: 'Signer source resolved',
      status: 'fail',
      blockingFor: [...ALL_CAPABILITIES],
      details: `no keystore at ${res.keystore.path}`,
      remediation:
        'Create a Foundry keystore (`cast wallet new ~/.foundry/keystores <name>`), ' +
        'then run `ospex auth use-foundry --account <name> --password-file <path>`.',
      data: {
        keystoreProvenance: res.keystore.provenance,
        keystorePath: res.keystore.path,
      },
      error: { code: 'signer_unresolvable', retryable: false },
    };
  }
  return {
    id: 'signer.resolved',
    label: 'Signer source resolved',
    status: 'ok',
    blockingFor: [...ALL_CAPABILITIES],
    data: {
      keystoreProvenance: res.keystore.provenance,
      keystorePath: res.keystore.path,
      account: res.keystore.account,
    },
  };
}

// Doctor-side enforcement of the no-prompt rule in §12. The doctor
// command sets `signerAddress: null` when --json / non-TTY mode would
// otherwise require an interactive unlock; this check turns that into a
// structured failure instead of a hang. PR 4 enriches the data field
// with the resolver's provenance — agents can switch on how the
// address was obtained (flag-address vs in-keystore vs session cache).
function checkSignerAddressKnown(inputs: NormalizedChecksInputs): CheckResult {
  if (inputs.signerAddress !== null) {
    const data: Record<string, unknown> = {
      address: inputs.signerAddress.toLowerCase(),
    };
    // When walker data is available, surface where the address came
    // from. The flag-address override (no walker involvement) is the
    // typical agent-friendly path; we mark it explicitly.
    if (inputs.authResolution !== null) {
      data.keystoreProvenance = inputs.authResolution.keystore.provenance;
      data.passwordProvenance = inputs.authResolution.password.provenance;
    }
    return {
      id: 'signer.address_known',
      label: 'Wallet address resolved',
      status: 'ok',
      blockingFor: [...ALL_CAPABILITIES],
      data,
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

// Informational: warn when no non-interactive password source is
// configured. Doesn't block any capability — agents that pass
// --address never need a password source; humans in interactive mode
// can answer a prompt. The structured warn lets an agent operator
// notice they'd hang in non-interactive mode without setting one up.
function checkSignerPasswordSource(inputs: NormalizedChecksInputs): CheckResult {
  const res = inputs.authResolution;
  if (res === null) {
    return {
      id: 'signer.password_source',
      label: 'Non-interactive password source configured',
      status: 'skip',
      blockingFor: [],
      details: 'auth resolution not run',
    };
  }
  const haveNonInteractive =
    res.password.provenance !== 'none' &&
    res.password.provenance !== 'session-cache';
  if (haveNonInteractive) {
    return {
      id: 'signer.password_source',
      label: 'Non-interactive password source configured',
      status: 'ok',
      blockingFor: [],
      data: { passwordProvenance: res.password.provenance },
    };
  }
  // session-cache works for non-interactive unlock but is the
  // soft-deprecated legacy path. Report as ok but distinguish.
  if (res.password.provenance === 'session-cache') {
    return {
      id: 'signer.password_source',
      label: 'Non-interactive password source configured',
      status: 'ok',
      blockingFor: [],
      details: 'using cached session (legacy `ospex wallet unlock`)',
      data: { passwordProvenance: 'session-cache' },
    };
  }
  return {
    id: 'signer.password_source',
    label: 'Non-interactive password source configured',
    status: 'warn',
    blockingFor: [],
    details:
      'no non-interactive password source — write commands would prompt for the passphrase',
    remediation:
      'Run `ospex auth use-foundry --account <name> --password-file <path>` to pin one, ' +
      'or pass --password-file / OSPEX_PASSWORD_FILE per invocation.',
    data: { passwordProvenance: 'none' },
  };
}

// Loose password-file perms (POSIX `mode & 0o077 !== 0`). Default
// `warn` so a developer on their own box isn't blocked; `--strict`
// promotes to `fail` and blocks every capability — the rollup then
// drives the exit-1 outcome that the legacy early-exit gate used to
// produce.
function checkSignerPasswordFilePerms(inputs: NormalizedChecksInputs): CheckResult {
  const perms = inputs.passwordFilePermissions;
  if (perms === null) {
    return {
      id: 'signer.password_file_perms',
      label: 'Password file permissions tight',
      status: 'skip',
      blockingFor: [],
      details: 'perms not checked',
    };
  }
  if (perms.platformSkipped) {
    return {
      id: 'signer.password_file_perms',
      label: 'Password file permissions tight',
      status: 'skip',
      blockingFor: [],
      details: 'non-POSIX host — perms not applicable',
      data: { platformSkipped: true },
    };
  }
  if (!perms.checked) {
    return {
      id: 'signer.password_file_perms',
      label: 'Password file permissions tight',
      status: 'skip',
      blockingFor: [],
      details: 'no password file configured',
    };
  }
  const data: Record<string, unknown> = {
    mode: perms.mode,
    octal: perms.octal,
    loose: perms.loose,
  };
  if (perms.loose === true) {
    if (inputs.strict) {
      return {
        id: 'signer.password_file_perms',
        label: 'Password file permissions tight',
        status: 'fail',
        // --strict makes this fully blocking; the rollup converts it
        // into exit-1 via the readiness derivation. Matches what the
        // pre-PR-4 `runPasswordFilePermissionGate` early-exit produced.
        blockingFor: [...ALL_CAPABILITIES],
        details: `mode 0${perms.octal as string} (group/other readable) — rejected by --strict`,
        remediation: 'Tighten with `chmod 600 <password-file>`.',
        data,
        error: { code: 'password_file_perms_loose', retryable: false },
      };
    }
    return {
      id: 'signer.password_file_perms',
      label: 'Password file permissions tight',
      status: 'warn',
      blockingFor: [],
      details: `mode 0${perms.octal as string} (group/other readable)`,
      remediation: 'Tighten with `chmod 600 <password-file>`, or run with --strict to fail.',
      data,
    };
  }
  return {
    id: 'signer.password_file_perms',
    label: 'Password file permissions tight',
    status: 'ok',
    blockingFor: [],
    data,
  };
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
        remediation: 'Run `ospex approvals setup --fee-usdc <amount>` to approve.',
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
  // `byCapability.*.ok` is false and the process exits 1. A review
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
 * Build the `meta` block from the shared `CLI_VERSION` / `SDK_VERSION` (resolved once in
 * `lib/version.ts` — a bundle-time inject with a runtime package.json fallback, `'unknown'`
 * if a read fails). Best-effort: the doctor never crashes over a version string.
 */
export function buildMeta(): MetaBlock {
  return {
    generatedAt: new Date().toISOString(),
    cliVersion: CLI_VERSION,
    sdkVersion: SDK_VERSION,
  };
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
