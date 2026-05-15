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

describe('runDoctorChecks — happy path', () => {
  it('returns ok for every check when balances + allowances + apiOk are satisfied', () => {
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
    });
    const s = buildSummary(checks);
    expect(s.counts.ok).toBe(4); // address, balances.native, balances.usdc, allowances.usdc_position
    expect(s.counts.fail).toBe(4); // connectivity.api, balances.link, allowances.usdc_treasury, allowances.link_oracle
    expect(s.counts.skip).toBe(0);
    expect(s.counts.warn).toBe(0);
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
