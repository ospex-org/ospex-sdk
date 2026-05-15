/**
 * Tests for the v2 doctor surface — flat `checks[]` array, capability
 * rollups, soft-fail on null snapshots, and the no-prompt signer
 * check. Complements `doctor.test.ts` (which covers the legacy
 * `computeReadiness` / `pickNextSuggestion` paths) by exercising the
 * structured pieces agents will switch on.
 */

import { describe, expect, it } from 'vitest';
import type { ApprovalsSnapshot, BalancesSnapshot } from '@ospex/sdk';
import { buildDoctorReport } from '../src/lib/doctorRender.js';
import {
  buildSummary,
  runDoctorChecks,
  type CheckResult,
  type MetaBlock,
} from '../src/lib/doctorChecks.js';
import type { ContractCheckResult, RpcProbeResult } from '../src/lib/doctorProbe.js';

const OWNER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`;
const POSITION_MODULE = '0x0DCd42f8609cd7884ddBa3481b03a78dfc88366c' as `0x${string}`;
const TREASURY_MODULE = '0xCB56CD2c509301e888965DD3A2E5C486Fe03a56e' as `0x${string}`;
const ORACLE_MODULE = '0x7e1397eD5b4c9f606DCF2EB0281485B2296E29Bb' as `0x${string}`;
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as `0x${string}`;
const LINK = '0xb0897686c545045aFc77CF20eC7A532E3120E0F1' as `0x${string}`;

const STUB_META: MetaBlock = {
  generatedAt: '2026-05-15T00:00:00.000Z',
  cliVersion: '0.1.0',
  sdkVersion: '0.1.0',
};

function makeApprovals(overrides: {
  positionModule?: bigint;
  treasuryModule?: bigint;
  oracleModule?: bigint;
} = {}): ApprovalsSnapshot {
  return {
    owner: OWNER,
    chainId: 137,
    usdc: {
      address: USDC,
      decimals: 6,
      allowances: {
        positionModule: {
          spender: POSITION_MODULE,
          spenderModule: 'positionModule',
          raw: overrides.positionModule ?? 0n,
        },
        treasuryModule: {
          spender: TREASURY_MODULE,
          spenderModule: 'treasuryModule',
          raw: overrides.treasuryModule ?? 0n,
        },
      },
    },
    link: {
      address: LINK,
      decimals: 18,
      allowances: {
        oracleModule: {
          spender: ORACLE_MODULE,
          spenderModule: 'oracleModule',
          raw: overrides.oracleModule ?? 0n,
        },
      },
    },
  };
}

function makeBalances(overrides: {
  native?: bigint;
  usdc?: bigint;
  link?: bigint;
  chainId?: number;
} = {}): BalancesSnapshot {
  return {
    owner: OWNER,
    chainId: overrides.chainId ?? 137,
    native: overrides.native ?? 0n,
    usdc: overrides.usdc ?? 0n,
    link: overrides.link ?? 0n,
    usdcAddress: USDC,
    linkAddress: LINK,
  };
}

function findCheck(checks: CheckResult[], id: string): CheckResult {
  const c = checks.find((r) => r.id === id);
  if (c === undefined) throw new Error(`expected a check with id=${id}`);
  return c;
}

// PR 2 happy-path probe defaults. Tests that want every check to be
// `ok` need to supply these — without them the new PR 2 checks
// (config.chain_id_expected / connectivity.rpc / network.chain_id_match
// / network.contracts_deployed) correctly skip because they have no
// probe data to classify.
const HAPPY_RPC_PROBE: RpcProbeResult = {
  ok: true,
  urlHost: 'rpc.example.com',
  durationMs: 42,
  chainId: 137,
  blockNumber: 50_000_000n,
  blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
  blockAgeSec: 2,
};

const HAPPY_CONTRACT_CHECK: ContractCheckResult = {
  ok: true,
  checked: [
    { name: 'USDC', address: USDC, hasCode: true },
    { name: 'LINK', address: LINK, hasCode: true },
    { name: 'PositionModule', address: POSITION_MODULE, hasCode: true },
    { name: 'TreasuryModule', address: TREASURY_MODULE, hasCode: true },
    { name: 'OracleModule', address: ORACLE_MODULE, hasCode: true },
    { name: 'OspexCore', address: '0xECD12Af197FBF4C9F706B5Eb11a19c40Cfd643db', hasCode: true },
  ],
  missing: [],
  partial: false,
};

const HAPPY_EXPECTED_CHAIN_ID = { value: 137 as const, source: 'env-OSPEX_CHAIN_ID' as const };

const HAPPY_CHAIN_PROBES = {
  expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
  rpcProbe: HAPPY_RPC_PROBE,
  contractCheck: HAPPY_CONTRACT_CHECK,
};

describe('runDoctorChecks — happy path', () => {
  it('returns ok for every check when balances + allowances + apiOk + probes are satisfied', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: makeBalances({
        native: 10n ** 18n,
        usdc: 10_000_000n,
        link: 2n * 10n ** 18n,
      }),
      approvals: makeApprovals({
        positionModule: 50_000_000n,
        treasuryModule: 5_000_000n,
        oracleModule: 2n * 10n ** 18n,
      }),
      signerAddress: OWNER,
      ...HAPPY_CHAIN_PROBES,
    });
    for (const c of checks) {
      expect(c.status, `expected ${c.id} to be ok`).toBe('ok');
      expect(c.error).toBeUndefined();
    }
  });

  it('emits structured error on a zero USDC balance with stable code', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: makeBalances({ native: 10n ** 18n, usdc: 0n }),
      approvals: makeApprovals({ positionModule: 50_000_000n }),
      signerAddress: OWNER,
    });
    const c = findCheck(checks, 'balances.usdc');
    expect(c.status).toBe('fail');
    expect(c.error?.code).toBe('balance_zero');
    expect(c.error?.retryable).toBe(false);
    expect(c.blockingFor).toEqual(['matchCommitments', 'submitCommitments']);
  });

  it('flags LINK as blocking createContests only — not match/submit', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n, link: 0n }),
      approvals: makeApprovals({ positionModule: 50_000_000n }),
      signerAddress: OWNER,
    });
    const c = findCheck(checks, 'balances.link');
    expect(c.status).toBe('fail');
    expect(c.blockingFor).toEqual(['createContests']);
  });
});

describe('runDoctorChecks — soft-fail on null snapshots', () => {
  it('null balances → balance checks are skip, not fail, with a details message', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      balancesError: 'connect ECONNREFUSED 127.0.0.1:8545',
      approvals: makeApprovals({ positionModule: 50_000_000n }),
      signerAddress: OWNER,
    });
    for (const id of ['balances.native', 'balances.usdc', 'balances.link']) {
      const c = findCheck(checks, id);
      expect(c.status, `${id} should skip when balances is null`).toBe('skip');
      expect(c.details).toContain('ECONNREFUSED');
    }
  });

  it('null approvals → allowance checks skip', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
      approvals: null,
      approvalsError: 'rpc unreachable',
      signerAddress: OWNER,
    });
    for (const id of [
      'allowances.usdc_position',
      'allowances.usdc_treasury',
      'allowances.link_oracle',
    ]) {
      const c = findCheck(checks, id);
      expect(c.status, `${id} should skip when approvals is null`).toBe('skip');
    }
  });

  it('apiOk=false → connectivity.api: fail with api_error code', () => {
    const checks = runDoctorChecks({
      apiOk: false,
      apiError: 'fetch failed',
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
      approvals: makeApprovals({ positionModule: 50_000_000n }),
      signerAddress: OWNER,
    });
    const c = findCheck(checks, 'connectivity.api');
    expect(c.status).toBe('fail');
    expect(c.error?.code).toBe('api_error');
    expect(c.error?.retryable).toBe(true);
    expect(c.blockingFor).toEqual([
      'matchCommitments',
      'submitCommitments',
      'createContests',
    ]);
  });

  it('signerAddress=null → signer.address_known: fail with password_source_missing', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: null,
      signerAddressError: 'address could not be derived without unlocking the keystore',
    });
    const c = findCheck(checks, 'signer.address_known');
    expect(c.status).toBe('fail');
    expect(c.error?.code).toBe('password_source_missing');
    expect(c.error?.retryable).toBe(false);
    expect(c.details).toContain('keystore');
  });
});

describe('buildSummary — rollup math', () => {
  it('all ok → summary.ok true, every byCapability.ok true', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: makeBalances({
        native: 10n ** 18n,
        usdc: 10_000_000n,
        link: 2n * 10n ** 18n,
      }),
      approvals: makeApprovals({
        positionModule: 50_000_000n,
        treasuryModule: 5_000_000n,
        oracleModule: 2n * 10n ** 18n,
      }),
      signerAddress: OWNER,
      ...HAPPY_CHAIN_PROBES,
    });
    const s = buildSummary(checks);
    expect(s.ok).toBe(true);
    expect(s.worstStatus).toBe('ok');
    expect(s.byCapability.matchCommitments.ok).toBe(true);
    expect(s.byCapability.submitCommitments.ok).toBe(true);
    expect(s.byCapability.createContests.ok).toBe(true);
  });

  it('LINK fail → createContests not ok, matchCommitments still ok (capability isolation)', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: makeBalances({
        native: 10n ** 18n,
        usdc: 10_000_000n,
        link: 0n,
      }),
      approvals: makeApprovals({
        positionModule: 50_000_000n,
        treasuryModule: 5_000_000n,
      }),
      signerAddress: OWNER,
      ...HAPPY_CHAIN_PROBES,
    });
    const s = buildSummary(checks);
    expect(s.byCapability.matchCommitments.ok).toBe(true);
    expect(s.byCapability.submitCommitments.ok).toBe(true);
    expect(s.byCapability.createContests.ok).toBe(false);
    expect(s.byCapability.createContests.blockingChecks).toContain('balances.link');
    // Worst status fail because LINK is fail somewhere.
    expect(s.worstStatus).toBe('fail');
    // Whole-envelope ok=false because there's a fail.
    expect(s.ok).toBe(false);
  });

  it('null snapshots → skip statuses roll up as worstStatus=warn (not fail)', () => {
    // A pure skip-only scenario rolls up as warn — fail is reserved
    // for confirmed failures, skip is "didn't check".
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
    });
    const s = buildSummary(checks);
    // worstStatus is warn (no fail, but plenty of skip).
    expect(s.worstStatus).toBe('warn');
    // Every capability not-ok because skipped checks block them.
    expect(s.byCapability.matchCommitments.ok).toBe(false);
    expect(s.byCapability.createContests.ok).toBe(false);
    // summary.ok must also be false — skips must not silently pass the
    // strict top-level gate (Hermes PR 52 blocker).
    expect(s.ok).toBe(false);
  });

  // Hermes PR 52 blocker. The exact repro scenario: `--address` set
  // and RPC unreachable. The envelope has 2 ok (api + address known)
  // and 6 skips, no fails. Pre-fix summary.ok was true even though
  // every byCapability.ok was false and the process exited 1 — false
  // positive an AI-agent preflight would misread as "safe to act".
  // The strict semantic ties summary.ok to "every check ok".
  it('skip-only envelope: summary.ok is false even with zero fails (Hermes PR 52)', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
    });
    const s = buildSummary(checks);
    expect(s.counts.fail).toBe(0);
    expect(s.counts.skip).toBeGreaterThan(0);
    expect(s.ok).toBe(false);
    expect(s.worstStatus).toBe('warn');
    // Consistency: summary.ok agrees with every byCapability.ok being false
    // and (in the doctor command) the exit-1 path.
    expect(s.byCapability.matchCommitments.ok).toBe(false);
    expect(s.byCapability.submitCommitments.ok).toBe(false);
    expect(s.byCapability.createContests.ok).toBe(false);
  });

  it('counts every status accurately', () => {
    const checks = runDoctorChecks({
      apiOk: false, // 1 fail
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }), // gas ok, usdc ok, link fail
      approvals: makeApprovals({ positionModule: 50_000_000n }), // position ok, treasury fail, oracle fail
      signerAddress: OWNER, // address ok
      ...HAPPY_CHAIN_PROBES, // PR 2 probes all ok → 4 more ok
    });
    const s = buildSummary(checks);
    // PR 1: address (1) + balances.native (1) + balances.usdc (1) + allowances.usdc_position (1) = 4 ok
    // PR 2: config.chain_id_expected + connectivity.rpc + network.chain_id_match + network.contracts_deployed = 4 more ok
    expect(s.counts.ok).toBe(8);
    expect(s.counts.fail).toBe(4); // connectivity.api, balances.link, allowances.usdc_treasury, allowances.link_oracle
    expect(s.counts.skip).toBe(0);
    expect(s.counts.warn).toBe(0);
  });
});

// ── PR 2: chain provenance + RPC probe + contract-code sanity ────────

describe('PR 2: config.chain_id_expected check', () => {
  it('ok when expected chain id source is env or config', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: { value: 137, source: 'env-OSPEX_CHAIN_ID' },
    });
    const c = findCheck(checks, 'config.chain_id_expected');
    expect(c.status).toBe('ok');
    expect(c.data?.['expected']).toBe(137);
    expect(c.data?.['expectedSource']).toBe('env-OSPEX_CHAIN_ID');
  });

  it('warns on implicit default — agents should know the chain wasn\'t explicit', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: { value: 137, source: 'default' },
    });
    const c = findCheck(checks, 'config.chain_id_expected');
    expect(c.status).toBe('warn');
    expect(c.details).toMatch(/default/);
    // Warn never blocks a capability — it's purely informational.
    expect(c.blockingFor).toEqual([]);
  });
});

describe('PR 2: connectivity.rpc check', () => {
  it('ok when probe succeeds — emits chainId/blockNumber/blockAge in data', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      ...HAPPY_CHAIN_PROBES,
    });
    const c = findCheck(checks, 'connectivity.rpc');
    expect(c.status).toBe('ok');
    expect(c.data?.['chainId']).toBe(137);
    expect(c.data?.['blockNumber']).toBe('50000000');
    expect(c.data?.['urlHost']).toBe('rpc.example.com');
    expect(typeof c.data?.['durationMs']).toBe('number');
  });

  it('fail with rpc_timeout when probe error mentions timeout', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      rpcProbe: {
        ok: false,
        urlHost: 'rpc.example.com',
        durationMs: 5_001,
        error: 'request timeout after 5000ms',
      },
    });
    const c = findCheck(checks, 'connectivity.rpc');
    expect(c.status).toBe('fail');
    expect(c.error?.code).toBe('rpc_timeout');
    expect(c.error?.retryable).toBe(true);
    expect(c.blockingFor).toEqual([
      'matchCommitments',
      'submitCommitments',
      'createContests',
    ]);
  });

  it('fail with rpc_error on non-timeout transport error', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      rpcProbe: {
        ok: false,
        urlHost: 'rpc.example.com',
        durationMs: 12,
        error: 'HTTP 401 Unauthorized',
      },
    });
    const c = findCheck(checks, 'connectivity.rpc');
    expect(c.status).toBe('fail');
    expect(c.error?.code).toBe('rpc_error');
  });

  it('fail when rpcUrl missing (caller signals it)', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      rpcUrlMissing: true,
    });
    const c = findCheck(checks, 'connectivity.rpc');
    expect(c.status).toBe('fail');
    expect(c.details).toMatch(/rpcUrl not configured/);
    expect(c.remediation).toMatch(/`ospex init`/);
  });
});

describe('PR 2: network.chain_id_match check', () => {
  it('fail with chain_id_mismatch when RPC reports a different chain than expected', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: { value: 137, source: 'env-OSPEX_CHAIN_ID' },
      rpcProbe: { ...HAPPY_RPC_PROBE, chainId: 80002 },
    });
    const c = findCheck(checks, 'network.chain_id_match');
    expect(c.status).toBe('fail');
    expect(c.error?.code).toBe('chain_id_mismatch');
    expect(c.data?.['expected']).toBe(137);
    expect(c.data?.['actual']).toBe(80002);
  });

  it('skip with dependsOn connectivity.rpc when RPC failed', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      rpcProbe: { ok: false, urlHost: 'h', durationMs: 1, error: 'down' },
    });
    const c = findCheck(checks, 'network.chain_id_match');
    expect(c.status).toBe('skip');
    expect(c.dependsOn).toEqual(['connectivity.rpc']);
  });
});

describe('PR 2: network.contracts_deployed check', () => {
  it('ok when all expected contracts have bytecode', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      ...HAPPY_CHAIN_PROBES,
    });
    const c = findCheck(checks, 'network.contracts_deployed');
    expect(c.status).toBe('ok');
  });

  it('fail with contract_not_deployed + data.missing when a contract has no code', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      rpcProbe: HAPPY_RPC_PROBE,
      contractCheck: {
        ok: false,
        checked: [
          { name: 'USDC', address: USDC, hasCode: true },
          { name: 'PositionModule', address: POSITION_MODULE, hasCode: false },
        ],
        missing: ['PositionModule'],
        partial: false,
      },
    });
    const c = findCheck(checks, 'network.contracts_deployed');
    expect(c.status).toBe('fail');
    expect(c.error?.code).toBe('contract_not_deployed');
    expect(c.data?.['missing']).toEqual(['PositionModule']);
  });

  it('skip on chain mismatch — short-circuits since the cause is upstream', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: { value: 137, source: 'env-OSPEX_CHAIN_ID' },
      rpcProbe: { ...HAPPY_RPC_PROBE, chainId: 80002 },
      contractCheck: HAPPY_CONTRACT_CHECK,
    });
    const c = findCheck(checks, 'network.contracts_deployed');
    expect(c.status).toBe('skip');
    expect(c.dependsOn).toEqual(['network.chain_id_match']);
  });

  it('warn on a partial probe — some bytecode lookups errored without confirming missing', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      rpcProbe: HAPPY_RPC_PROBE,
      contractCheck: {
        ok: false,
        checked: [
          { name: 'USDC', address: USDC, hasCode: true },
          { name: 'LINK', address: LINK, hasCode: false }, // lookup failed → hasCode=false but counted as partial
        ],
        missing: [],
        partial: true,
      },
    });
    const c = findCheck(checks, 'network.contracts_deployed');
    expect(c.status).toBe('warn');
  });
});

describe('PR 2: chain-mismatch cascade on balances + allowances', () => {
  it('balances downgraded to warn when RPC chain differs from expected (values are suspect)', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
      approvals: makeApprovals({ positionModule: 50_000_000n }),
      signerAddress: OWNER,
      expectedChainId: { value: 137, source: 'env-OSPEX_CHAIN_ID' },
      // RPC speaks the OTHER chain — readings are real but from the wrong network.
      rpcProbe: { ...HAPPY_RPC_PROBE, chainId: 80002 },
      contractCheck: HAPPY_CONTRACT_CHECK,
    });
    for (const id of [
      'balances.native',
      'balances.usdc',
      'balances.link',
      'allowances.usdc_position',
      'allowances.usdc_treasury',
      'allowances.link_oracle',
    ]) {
      const c = findCheck(checks, id);
      expect(c.status, `${id} should warn on chain mismatch`).toBe('warn');
      expect(c.details, `${id} should explain the mismatch`).toMatch(/chain mismatch/);
    }
  });

  it('balances skip with dependsOn connectivity.rpc when RPC is down', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      rpcProbe: { ok: false, urlHost: 'h', durationMs: 1, error: 'down' },
    });
    for (const id of ['balances.native', 'balances.usdc', 'allowances.usdc_position']) {
      const c = findCheck(checks, id);
      expect(c.status).toBe('skip');
      expect(c.dependsOn).toEqual(['connectivity.rpc']);
    }
  });
});

describe('PR 2: config.chainId envelope field', () => {
  it('records both expected and actual when both resolved', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
      ...HAPPY_CHAIN_PROBES,
    });
    expect(report.config.chainId).toEqual({
      expected: 137,
      actual: 137,
      ok: true,
      expectedSource: 'env-OSPEX_CHAIN_ID',
    });
  });

  it('ok=false when chains mismatch — agents switch on this directly', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
      expectedChainId: { value: 137, source: 'config' },
      rpcProbe: { ...HAPPY_RPC_PROBE, chainId: 80002 },
      contractCheck: HAPPY_CONTRACT_CHECK,
    });
    expect(report.config.chainId.ok).toBe(false);
    expect(report.config.chainId.expected).toBe(137);
    expect(report.config.chainId.actual).toBe(80002);
    expect(report.config.chainId.expectedSource).toBe('config');
  });

  it('ok=null when either side is missing — never infer success from a half-record', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      // No rpcProbe — actual is unknown.
    });
    expect(report.config.chainId.actual).toBeNull();
    expect(report.config.chainId.ok).toBeNull();
  });

  it('expectedSource is "unset" when no expected chain id was resolved', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
      // No expectedChainId / probe — pure PR 1-era inputs.
    });
    expect(report.config.chainId.expectedSource).toBe('unset');
    expect(report.config.chainId.expected).toBeNull();
  });
});

describe('buildDoctorReport — v2 envelope shape', () => {
  it('emits schemaVersion 1, meta, checks, summary alongside legacy fields', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: makeApprovals({ positionModule: 50_000_000n }),
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
      meta: STUB_META,
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.meta).toEqual(STUB_META);
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.summary.ok).toBeDefined();
    expect(report.summary.counts).toBeDefined();
    expect(report.summary.byCapability.matchCommitments).toBeDefined();
  });

  it('null balances → balances envelope field is null (not fake zeros)', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: makeApprovals(),
      balances: null,
      balancesError: 'rpc down',
      signerAddress: OWNER,
      meta: STUB_META,
    });
    expect(report.balances).toBeNull();
    // Network derives from balances → also null.
    expect(report.network).toBeNull();
  });

  it('null approvals → allowances envelope field is null', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      approvalsError: 'rpc down',
      balances: makeBalances({ native: 10n ** 18n }),
      signerAddress: OWNER,
      meta: STUB_META,
    });
    expect(report.allowances).toBeNull();
  });

  it('signerAddress=null sets wallet.address to null', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: null,
      signerAddressError: 'no signer',
      meta: STUB_META,
    });
    expect(report.wallet.address).toBeNull();
  });

  it('round-trips through JSON.stringify with no BigInt errors when snapshots are null', () => {
    const report = buildDoctorReport({
      apiOk: false,
      approvals: null,
      balances: null,
      signerAddress: null,
      signerAddressError: 'no signer',
      meta: STUB_META,
    });
    expect(() => JSON.stringify(report)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(report)) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(1);
  });

  it('readiness mirrors summary.byCapability on degraded path', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
    });
    expect(report.ready.matchCommitments.ok).toBe(false);
    expect(report.ready.matchCommitments.reasons.length).toBeGreaterThan(0);
    expect(report.summary.byCapability.matchCommitments.ok).toBe(false);
  });

  it('degraded suggestion fires when chain reads failed', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
    });
    expect(report.suggestion?.text).toMatch(/chain/i);
  });

  it('happy-path inputs work without supplying signerAddress or meta (back-compat)', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: makeApprovals({ positionModule: 50_000_000n }),
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
    });
    expect(report.wallet.address).toBe(OWNER);
    expect(report.meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // CLI / SDK versions are 'unknown' or a real semver — either is fine.
    expect(report.meta.cliVersion).toMatch(/^(\d+\.\d+\.\d+|unknown)$/);
    expect(report.meta.sdkVersion).toMatch(/^(\d+\.\d+\.\d+|unknown)$/);
  });
});
