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
import type {
  AuthSourceResolution,
  PasswordFilePermissions,
} from '../src/lib/authResolution.js';

const OWNER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`;
const POSITION_MODULE = '0x0DCd42f8609cd7884ddBa3481b03a78dfc88366c' as `0x${string}`;
const TREASURY_MODULE = '0xCB56CD2c509301e888965DD3A2E5C486Fe03a56e' as `0x${string}`;
const ORACLE_MODULE = '0x7e1397eD5b4c9f606DCF2EB0281485B2296E29Bb' as `0x${string}`;
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as `0x${string}`;
const LINK = '0xb0897686c545045aFc77CF20eC7A532E3120E0F1' as `0x${string}`;

const STUB_META: MetaBlock = {
  generatedAt: '2026-05-15T00:00:00.000Z',
  cliVersion: '0.2.0',
  sdkVersion: '0.2.0',
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
  unknown: [],
};

const HAPPY_EXPECTED_CHAIN_ID = { value: 137 as const, source: 'env-OSPEX_CHAIN_ID' as const };
const HAPPY_API_URL = { value: 'https://api.ospex.org', source: 'default' as const };
const HAPPY_RPC_URL = {
  value: 'https://polygon-mainnet.g.alchemy.com/v2/aaaaaaaaaaaaaaaaaaaa',
  source: 'env-OSPEX_RPC_URL' as const,
};

// PR 4: a fully resolved walker output where the signer is configured
// non-interactively. The doctor's happy path with these fields produces
// `signer.{resolved, password_source, password_file_perms}: ok`.
const HAPPY_AUTH_RESOLUTION: AuthSourceResolution = {
  keystore: {
    provenance: 'config-foundryAccount',
    path: '/home/agent/.foundry/keystores/maker-a',
    account: 'maker-a',
    exists: true,
  },
  password: {
    provenance: 'config-passwordFile',
    path: '/home/agent/.ospex/secrets/maker-a.pass',
    exists: true,
  },
  expectedAddress: {
    provenance: 'config',
    value: '0xab12cd34ab12cd34ab12cd34ab12cd34ab12cd34',
  },
  foundryKeystoresDir: {
    provenance: 'default',
    value: '/home/agent/.foundry/keystores',
  },
};
const HAPPY_PASSWORD_FILE_PERMS: PasswordFilePermissions = {
  checked: true,
  platformSkipped: false,
  mode: 0o600,
  octal: '600',
  loose: false,
};

const HAPPY_CHAIN_PROBES = {
  expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
  rpcProbe: HAPPY_RPC_PROBE,
  contractCheck: HAPPY_CONTRACT_CHECK,
  apiUrl: HAPPY_API_URL,
  rpcUrl: HAPPY_RPC_URL,
  authResolution: HAPPY_AUTH_RESOLUTION,
  passwordFilePermissions: HAPPY_PASSWORD_FILE_PERMS,
  strict: false,
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
      ...HAPPY_CHAIN_PROBES, // PR 2+3 probes all ok
    });
    const s = buildSummary(checks);
    // PR 1: address + balances.native + balances.usdc + allowances.usdc_position = 4 ok
    // PR 2: config.chain_id_expected + connectivity.rpc + network.chain_id_match + network.contracts_deployed = 4 ok
    // PR 3: config.api_url + config.rpc_url = 2 ok
    // PR 4: signer.resolved + signer.password_source + signer.password_file_perms = 3 ok
    expect(s.counts.ok).toBe(13);
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

  // PR 3: `config.rpc_url` is now the canonical signal for "rpcUrl
  // unset" — `connectivity.rpc` skips with `dependsOn` rather than
  // duplicating the fail. Two signals for the same condition was
  // noisy and the dependsOn cascade is the cleaner agent UX.
  it('skip with dependsOn config.rpc_url when rpcUrl missing', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      rpcUrlMissing: true,
    });
    const rpc = findCheck(checks, 'connectivity.rpc');
    expect(rpc.status).toBe('skip');
    expect(rpc.dependsOn).toEqual(['config.rpc_url']);
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
        unknown: [],
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

  // Real-probe shape: a lookup that errored sets hasCode=null and
  // adds the name to `unknown` (NOT `missing`). The check must warn
  // (lookup advisory) rather than fail (confirmed missing). Hermes
  // PR 53 blocker #2 — the prior implementation collapsed both into
  // hasCode:false + missing[], so the real probe path always failed.
  it('warn when a lookup errored — distinguishes unknown from confirmed missing', () => {
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
          { name: 'LINK', address: LINK, hasCode: null }, // lookup errored
        ],
        missing: [],
        unknown: ['LINK'],
      },
    });
    const c = findCheck(checks, 'network.contracts_deployed');
    expect(c.status).toBe('warn');
    expect(c.details).toMatch(/LINK/);
    expect(c.error).toBeUndefined();
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

// Hermes PR 53 blocker #1. The legacy `ready` matrix and the exit
// code must agree with `summary.byCapability` even when balances and
// approvals are populated (happy snapshot path). Pre-fix the doctor
// computed `ready` via the PR 1-only `computeReadiness`, which
// ignored the new chain/protocol checks — so a passing balance
// reading would mask a `network.contracts_deployed: fail`.
describe('PR 2: ready/exit agree with summary even on happy snapshot path', () => {
  it('network.contracts_deployed: fail flips ready.matchCommitments.ok to false', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: makeApprovals({
        positionModule: 50_000_000n,
        treasuryModule: 5_000_000n,
        oracleModule: 2n * 10n ** 18n,
      }),
      balances: makeBalances({
        native: 10n ** 18n,
        usdc: 10_000_000n,
        link: 2n * 10n ** 18n,
      }),
      signerAddress: OWNER,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      rpcProbe: HAPPY_RPC_PROBE,
      // Chain matches, balances + allowances are fine, but
      // PositionModule has no bytecode on this RPC.
      contractCheck: {
        ok: false,
        checked: [
          { name: 'PositionModule', address: POSITION_MODULE, hasCode: false },
        ],
        missing: ['PositionModule'],
        unknown: [],
      },
      meta: STUB_META,
    });
    expect(report.ready.matchCommitments.ok).toBe(false);
    expect(report.summary.byCapability.matchCommitments.ok).toBe(false);
    expect(report.summary.byCapability.matchCommitments.blockingChecks).toContain(
      'network.contracts_deployed',
    );
    // Reasons list (legacy surface) must mention the new check too.
    expect(report.ready.matchCommitments.reasons.join(', ')).toMatch(/contracts/);
  });

  it('network.chain_id_match: fail flips ready.matchCommitments.ok to false', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: makeApprovals({
        positionModule: 50_000_000n,
        treasuryModule: 5_000_000n,
      }),
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
      signerAddress: OWNER,
      expectedChainId: { value: 137, source: 'env-OSPEX_CHAIN_ID' },
      rpcProbe: { ...HAPPY_RPC_PROBE, chainId: 80002 },
      contractCheck: HAPPY_CONTRACT_CHECK,
      meta: STUB_META,
    });
    expect(report.ready.matchCommitments.ok).toBe(false);
    expect(report.summary.byCapability.matchCommitments.blockingChecks).toContain(
      'network.chain_id_match',
    );
  });

  it('happy chain + happy balances → ready.matchCommitments.ok is true (positive control)', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: makeApprovals({
        positionModule: 50_000_000n,
        treasuryModule: 5_000_000n,
        oracleModule: 2n * 10n ** 18n,
      }),
      balances: makeBalances({
        native: 10n ** 18n,
        usdc: 10_000_000n,
        link: 2n * 10n ** 18n,
      }),
      signerAddress: OWNER,
      meta: STUB_META,
      ...HAPPY_CHAIN_PROBES,
    });
    expect(report.ready.matchCommitments.ok).toBe(true);
    expect(report.ready.createContests.ok).toBe(true);
  });

  it('PR 2 fallback suggestion fires when matchCommitments is blocked but PR 1 picker has nothing', () => {
    // PR 1 picker conditions all satisfied (API ok, POL/USDC funded,
    // PositionModule approved) — without the fallback, suggestion
    // would be null even though contracts_deployed says no-go.
    const report = buildDoctorReport({
      apiOk: true,
      approvals: makeApprovals({
        positionModule: 50_000_000n,
        treasuryModule: 5_000_000n,
        oracleModule: 2n * 10n ** 18n,
      }),
      balances: makeBalances({
        native: 10n ** 18n,
        usdc: 10_000_000n,
        link: 2n * 10n ** 18n,
      }),
      signerAddress: OWNER,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      rpcProbe: HAPPY_RPC_PROBE,
      contractCheck: {
        ok: false,
        checked: [{ name: 'OspexCore', address: '0xECD12Af197FBF4C9F706B5Eb11a19c40Cfd643db', hasCode: false }],
        missing: ['OspexCore'],
        unknown: [],
      },
      meta: STUB_META,
    });
    expect(report.suggestion).not.toBeNull();
    expect(report.suggestion?.text).toMatch(/.+/);
  });
});

// ── PR 4: signer provenance via shared auth-check walker ─────────────

describe('PR 4: signer.resolved check', () => {
  it('ok with keystore provenance/path/account when a keystore is configured', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      authResolution: HAPPY_AUTH_RESOLUTION,
    });
    const c = findCheck(checks, 'signer.resolved');
    expect(c.status).toBe('ok');
    expect(c.data?.['keystoreProvenance']).toBe('config-foundryAccount');
    expect(c.data?.['account']).toBe('maker-a');
  });

  it('fail with signer_unresolvable when no keystore exists anywhere', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: null,
      authResolution: {
        keystore: {
          provenance: 'default-legacy',
          path: '/home/agent/.ospex/keystore.json',
          account: null,
          exists: false,
        },
        password: { provenance: 'none', path: null, exists: null },
        expectedAddress: { provenance: 'none', value: null },
        foundryKeystoresDir: { provenance: 'default', value: '/home/agent/.foundry/keystores' },
      },
    });
    const c = findCheck(checks, 'signer.resolved');
    expect(c.status).toBe('fail');
    expect(c.error?.code).toBe('signer_unresolvable');
    expect(c.blockingFor).toEqual(['matchCommitments', 'submitCommitments', 'createContests']);
  });

  it('ok when keystore is missing BUT a fresh session cache will unlock', () => {
    // `loadSigner`'s path-2 uses session.privateKey without touching the
    // keystore file — so `keystore.exists: false` is fine here.
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      authResolution: {
        keystore: {
          provenance: 'default-legacy',
          path: '/home/agent/.ospex/keystore.json',
          account: null,
          exists: false,
        },
        password: { provenance: 'session-cache', path: null, exists: null },
        expectedAddress: { provenance: 'none', value: null },
        foundryKeystoresDir: { provenance: 'default', value: '/home/agent/.foundry/keystores' },
      },
    });
    const c = findCheck(checks, 'signer.resolved');
    expect(c.status).toBe('ok');
  });
});

describe('PR 4: signer.address_known check is enriched with provenance', () => {
  it('exposes keystoreProvenance + passwordProvenance in data when the walker ran', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      authResolution: HAPPY_AUTH_RESOLUTION,
    });
    const c = findCheck(checks, 'signer.address_known');
    expect(c.status).toBe('ok');
    expect(c.data?.['keystoreProvenance']).toBe('config-foundryAccount');
    expect(c.data?.['passwordProvenance']).toBe('config-passwordFile');
  });

  it('reports fail with password_source_missing when signerAddress is null in --json mode', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: null,
      signerAddressError: 'cannot derive without unlock',
      authResolution: HAPPY_AUTH_RESOLUTION,
    });
    const c = findCheck(checks, 'signer.address_known');
    expect(c.status).toBe('fail');
    expect(c.error?.code).toBe('password_source_missing');
  });
});

describe('PR 4: signer.password_source check', () => {
  it('ok when a non-interactive password source is configured', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      authResolution: HAPPY_AUTH_RESOLUTION,
    });
    const c = findCheck(checks, 'signer.password_source');
    expect(c.status).toBe('ok');
    expect(c.data?.['passwordProvenance']).toBe('config-passwordFile');
    expect(c.blockingFor).toEqual([]); // informational
  });

  it('warn with none provenance — informational, never blocks', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      authResolution: {
        ...HAPPY_AUTH_RESOLUTION,
        password: { provenance: 'none', path: null, exists: null },
      },
    });
    const c = findCheck(checks, 'signer.password_source');
    expect(c.status).toBe('warn');
    expect(c.blockingFor).toEqual([]);
    expect(c.remediation).toMatch(/use-foundry/);
  });

  it('ok with session-cache — annotates legacy posture in details', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      authResolution: {
        ...HAPPY_AUTH_RESOLUTION,
        password: { provenance: 'session-cache', path: null, exists: null },
      },
    });
    const c = findCheck(checks, 'signer.password_source');
    expect(c.status).toBe('ok');
    expect(c.details).toMatch(/session/);
  });
});

describe('PR 4: signer.password_file_perms check', () => {
  it('ok when mode is 0600', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      passwordFilePermissions: HAPPY_PASSWORD_FILE_PERMS,
    });
    const c = findCheck(checks, 'signer.password_file_perms');
    expect(c.status).toBe('ok');
  });

  it('warn when loose by default (not --strict)', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      passwordFilePermissions: {
        checked: true,
        platformSkipped: false,
        mode: 0o644,
        octal: '644',
        loose: true,
      },
    });
    const c = findCheck(checks, 'signer.password_file_perms');
    expect(c.status).toBe('warn');
    expect(c.blockingFor).toEqual([]);
    expect(c.details).toMatch(/644/);
  });

  // Hermes PR 52 / spec §15 PR 4: the legacy `--strict` early-exit
  // is gone; the structured check is the new source of truth. Under
  // --strict, loose perms become a hard fail that blocks every
  // capability, so the rollup drives the exit-1 outcome.
  it('fail with password_file_perms_loose when loose + --strict — blocks every capability', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      strict: true,
      passwordFilePermissions: {
        checked: true,
        platformSkipped: false,
        mode: 0o644,
        octal: '644',
        loose: true,
      },
    });
    const c = findCheck(checks, 'signer.password_file_perms');
    expect(c.status).toBe('fail');
    expect(c.error?.code).toBe('password_file_perms_loose');
    expect(c.blockingFor).toEqual([
      'matchCommitments',
      'submitCommitments',
      'createContests',
    ]);
  });

  it('skip on non-POSIX host (platformSkipped)', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      passwordFilePermissions: {
        checked: false,
        platformSkipped: true,
        mode: null,
        octal: null,
        loose: null,
      },
    });
    const c = findCheck(checks, 'signer.password_file_perms');
    expect(c.status).toBe('skip');
  });
});

// Locked-in rollup behaviour for --strict: the readiness derivation
// must flip `matchCommitments.ok` to false when password_file_perms
// is fail, since `signer.password_file_perms` then declares
// `blockingFor: [all-three]`. This is what makes the exit code reach 1
// without the legacy early-exit gate.
describe('PR 4: --strict + loose pw-file drives exit-1 via rollup', () => {
  it('summary.byCapability.matchCommitments.ok flips false under --strict + loose', () => {
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
      strict: true,
      passwordFilePermissions: {
        checked: true,
        platformSkipped: false,
        mode: 0o644,
        octal: '644',
        loose: true,
      },
    });
    const s = buildSummary(checks);
    expect(s.byCapability.matchCommitments.ok).toBe(false);
    expect(s.byCapability.matchCommitments.blockingChecks).toContain(
      'signer.password_file_perms',
    );
  });
});

// ── PR 3: URL provenance ──────────────────────────────────────────────

describe('PR 3: config.api_url check', () => {
  it('ok with source=default when no env/config supplied', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      apiUrl: { value: 'https://api.ospex.org', source: 'default' },
    });
    const c = findCheck(checks, 'config.api_url');
    expect(c.status).toBe('ok');
    expect(c.data?.['source']).toBe('default');
    // Never blocks — API URL has a documented default.
    expect(c.blockingFor).toEqual([]);
  });

  it('ok with source=env-OSPEX_API_URL when set via env', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      apiUrl: { value: 'https://staging.api.ospex.org', source: 'env-OSPEX_API_URL' },
    });
    const c = findCheck(checks, 'config.api_url');
    expect(c.status).toBe('ok');
    expect(c.data?.['source']).toBe('env-OSPEX_API_URL');
  });

  it('skip when apiUrl input is not supplied (PR 2-era callers)', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
    });
    const c = findCheck(checks, 'config.api_url');
    expect(c.status).toBe('skip');
  });
});

describe('PR 3: config.rpc_url check', () => {
  it('ok with source provenance when configured', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      rpcUrl: {
        value: 'https://polygon-mainnet.g.alchemy.com/v2/abc',
        source: 'env-OSPEX_RPC_URL',
      },
    });
    const c = findCheck(checks, 'config.rpc_url');
    expect(c.status).toBe('ok');
    expect(c.data?.['source']).toBe('env-OSPEX_RPC_URL');
  });

  it('fail with config_not_set when value is null', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      rpcUrl: { value: null, source: 'unset' },
    });
    const c = findCheck(checks, 'config.rpc_url');
    expect(c.status).toBe('fail');
    expect(c.error?.code).toBe('config_not_set');
    expect(c.error?.retryable).toBe(false);
    expect(c.blockingFor).toEqual([
      'matchCommitments',
      'submitCommitments',
      'createContests',
    ]);
    expect(c.remediation).toMatch(/`ospex init`/);
  });

  it('connectivity.rpc skips with dependsOn config.rpc_url when rpcUrl is unset', () => {
    const checks = runDoctorChecks({
      apiOk: true,
      balances: null,
      approvals: null,
      signerAddress: OWNER,
      rpcUrl: { value: null, source: 'unset' },
    });
    const rpc = findCheck(checks, 'connectivity.rpc');
    expect(rpc.status).toBe('skip');
    expect(rpc.dependsOn).toEqual(['config.rpc_url']);
  });
});

describe('PR 3: config.{apiUrl,rpcUrl} envelope field — UrlField with redaction', () => {
  it('emits a UrlField with redactedValue, host, fingerprint for apiUrl', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
      ...HAPPY_CHAIN_PROBES,
    });
    expect(report.config.apiUrl).not.toBeNull();
    expect(report.config.apiUrl?.source).toBe('default');
    expect(report.config.apiUrl?.host).toBe('api.ospex.org');
    expect(report.config.apiUrl?.fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('redacts an Alchemy-style RPC URL in the envelope', () => {
    const raw = 'https://polygon-mainnet.g.alchemy.com/v2/abcdef0123456789abcdef0123456789';
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      apiUrl: HAPPY_API_URL,
      rpcUrl: { value: raw, source: 'env-OSPEX_RPC_URL' },
      rpcProbe: HAPPY_RPC_PROBE,
      contractCheck: HAPPY_CONTRACT_CHECK,
    });
    expect(report.config.rpcUrl).not.toBeNull();
    expect(report.config.rpcUrl?.redactedValue).toBe(
      'https://polygon-mainnet.g.alchemy.com/v2/[redacted]',
    );
    expect(report.config.rpcUrl?.host).toBe('polygon-mainnet.g.alchemy.com');
    // The raw value MUST NOT appear in the envelope (the credential
    // leak Hermes flagged in v2 §10).
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('abcdef0123456789abcdef0123456789');
  });

  it('rpcUrl is null in envelope when the URL is unset', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
      apiUrl: HAPPY_API_URL,
      rpcUrl: { value: null, source: 'unset' },
    });
    expect(report.config.rpcUrl).toBeNull();
  });

  it('no raw API key from any URL source leaks into the JSON envelope', () => {
    // Cover every credential surface the redactor handles: userinfo,
    // path key, query secret. The serialized envelope must contain
    // none of the raw secret material.
    const rawSecrets = [
      'topsecretpasswordstring',
      'rawalchemyhexkey0123456789abcdefxx',
      'querysecretvaluestring',
    ];
    const compositeRpcUrl = `https://user:${rawSecrets[0]}@rpc.example.com/v2/${rawSecrets[1]}?apikey=${rawSecrets[2]}`;
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
      expectedChainId: HAPPY_EXPECTED_CHAIN_ID,
      apiUrl: HAPPY_API_URL,
      rpcUrl: { value: compositeRpcUrl, source: 'env-OSPEX_RPC_URL' },
      rpcProbe: HAPPY_RPC_PROBE,
      contractCheck: HAPPY_CONTRACT_CHECK,
    });
    const serialized = JSON.stringify(report);
    for (const secret of rawSecrets) {
      expect(serialized, `raw secret "${secret}" must not appear in envelope`).not.toContain(secret);
    }
  });
});

describe('PR 4: config.signer envelope field', () => {
  it('emits keystore/password provenance + perms in the envelope when walker ran', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
      ...HAPPY_CHAIN_PROBES,
    });
    expect(report.config.signer).not.toBeNull();
    expect(report.config.signer?.keystoreProvenance).toBe('config-foundryAccount');
    expect(report.config.signer?.account).toBe('maker-a');
    expect(report.config.signer?.address).toBe(OWNER);
    expect(report.config.signer?.addressKnownWithoutUnlock).toBe(true);
    expect(report.config.signer?.passwordProvenance).toBe('config-passwordFile');
    expect(report.config.signer?.passwordFilePermissions.octal).toBe('600');
  });

  it('signer envelope is null when the walker was not run', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: OWNER,
      meta: STUB_META,
    });
    expect(report.config.signer).toBeNull();
  });

  it('addressKnownWithoutUnlock is false when signerAddress is null', () => {
    const report = buildDoctorReport({
      apiOk: true,
      approvals: null,
      balances: null,
      signerAddress: null,
      signerAddressError: 'no source',
      meta: STUB_META,
      authResolution: HAPPY_AUTH_RESOLUTION,
    });
    expect(report.config.signer?.address).toBeNull();
    expect(report.config.signer?.addressKnownWithoutUnlock).toBe(false);
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
