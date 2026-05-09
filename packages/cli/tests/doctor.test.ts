/**
 * Tests for `ospex doctor` — readiness logic, suggestion ranking, and
 * report rendering. The actual SDK reads (`approvals.read`,
 * `balances.read`, `health.check`) are exercised in the SDK suite;
 * here we test the CLI's pure transforms on synthetic snapshots.
 */

import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { maxUint256 } from 'viem';
import type { ApprovalsSnapshot, BalancesSnapshot } from '@ospex/sdk';
import {
  buildDoctorReport,
  computeReadiness,
  pickNextSuggestion,
  renderDoctorReport,
} from '../src/lib/doctorRender.js';

class StringSink extends Writable {
  buf = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.buf += chunk.toString();
    cb();
  }
}

const OWNER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const POSITION_MODULE = '0x0DCd42f8609cd7884ddBa3481b03a78dfc88366c';
const TREASURY_MODULE = '0xCB56CD2c509301e888965DD3A2E5C486Fe03a56e';
const ORACLE_MODULE = '0x7e1397eD5b4c9f606DCF2EB0281485B2296E29Bb';
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const LINK = '0xb0897686c545045aFc77CF20eC7A532E3120E0F1';

function makeApprovals(overrides: {
  positionModule?: bigint;
  treasuryModule?: bigint;
  oracleModule?: bigint;
} = {}): ApprovalsSnapshot {
  return {
    owner: OWNER as `0x${string}`,
    chainId: 137,
    usdc: {
      address: USDC as `0x${string}`,
      decimals: 6,
      allowances: {
        positionModule: {
          spender: POSITION_MODULE as `0x${string}`,
          spenderModule: 'positionModule',
          raw: overrides.positionModule ?? 0n,
        },
        treasuryModule: {
          spender: TREASURY_MODULE as `0x${string}`,
          spenderModule: 'treasuryModule',
          raw: overrides.treasuryModule ?? 0n,
        },
      },
    },
    link: {
      address: LINK as `0x${string}`,
      decimals: 18,
      allowances: {
        oracleModule: {
          spender: ORACLE_MODULE as `0x${string}`,
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
    owner: OWNER as `0x${string}`,
    chainId: overrides.chainId ?? 137,
    native: overrides.native ?? 0n,
    usdc: overrides.usdc ?? 0n,
    link: overrides.link ?? 0n,
    usdcAddress: USDC as `0x${string}`,
    linkAddress: LINK as `0x${string}`,
  };
}

describe('computeReadiness', () => {
  it('reports yes for matching when POL + USDC + PositionModule are all present', () => {
    const r = computeReadiness({
      approvals: makeApprovals({ positionModule: 50_000_000n }),
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
    });
    expect(r.matchCommitments.ok).toBe(true);
    expect(r.matchCommitments.reasons).toEqual([]);
  });

  it('reports no for matching with each missing primitive enumerated', () => {
    const r = computeReadiness({
      approvals: makeApprovals(),
      balances: makeBalances(),
    });
    expect(r.matchCommitments.ok).toBe(false);
    expect(r.matchCommitments.reasons).toEqual([
      'no POL balance for gas',
      'no USDC balance',
      'PositionModule USDC not approved',
    ]);
  });

  it('treats submitting and matching as the same baseline (TreasuryModule is conditional)', () => {
    const r = computeReadiness({
      approvals: makeApprovals({ positionModule: 50_000_000n }),
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
    });
    expect(r.submitCommitments.ok).toBe(true);
  });

  it('reports no for create when LINK or Oracle is missing', () => {
    const r = computeReadiness({
      approvals: makeApprovals({
        positionModule: 50_000_000n,
        treasuryModule: 5_000_000n,
      }),
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
    });
    expect(r.createContests.ok).toBe(false);
    expect(r.createContests.reasons).toContain('no LINK balance');
    expect(r.createContests.reasons).toContain('OracleModule LINK not approved');
  });

  it('reports yes for all three when every primitive is satisfied', () => {
    const r = computeReadiness({
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
    });
    expect(r.matchCommitments.ok).toBe(true);
    expect(r.submitCommitments.ok).toBe(true);
    expect(r.createContests.ok).toBe(true);
  });

  it('any positive native balance counts as gas-ok (no minimum threshold)', () => {
    const r = computeReadiness({
      approvals: makeApprovals({ positionModule: 1n }),
      balances: makeBalances({ native: 1n, usdc: 1n }),
    });
    expect(r.matchCommitments.ok).toBe(true);
  });
});

describe('pickNextSuggestion', () => {
  it('points at funding POL when native balance is zero', () => {
    const inputs = { approvals: makeApprovals(), balances: makeBalances() };
    const r = computeReadiness(inputs);
    const sug = pickNextSuggestion(inputs, r);
    expect(sug?.text).toMatch(/POL/);
    expect(sug?.audience).toBe('bettor');
  });

  it('points at funding USDC when POL is present but USDC is zero', () => {
    const inputs = {
      approvals: makeApprovals(),
      balances: makeBalances({ native: 10n ** 18n }),
    };
    const r = computeReadiness(inputs);
    const sug = pickNextSuggestion(inputs, r);
    expect(sug?.text).toMatch(/USDC/);
  });

  it('points at `ospex approvals setup --risk-usdc` when balances are present but Position is unapproved', () => {
    const inputs = {
      approvals: makeApprovals(),
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
    };
    const r = computeReadiness(inputs);
    const sug = pickNextSuggestion(inputs, r);
    expect(sug?.command).toBe('ospex approvals setup --risk-usdc 50');
    expect(sug?.audience).toBe('bettor');
  });

  it('returns the operator hint when bettor path is fully ready but contest path is not', () => {
    const inputs = {
      approvals: makeApprovals({
        positionModule: 50_000_000n,
        treasuryModule: 5_000_000n,
      }),
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
    };
    const r = computeReadiness(inputs);
    const sug = pickNextSuggestion(inputs, r);
    expect(sug?.audience).toBe('operator');
    expect(sug?.command).toContain('--link');
  });

  it('returns null when every capability is satisfied', () => {
    const inputs = {
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
    };
    const r = computeReadiness(inputs);
    expect(pickNextSuggestion(inputs, r)).toBeNull();
  });
});

describe('buildDoctorReport (JSON envelope)', () => {
  it('produces { schemaVersion: 1, ... } at top level', () => {
    const report = buildDoctorReport({
      approvals: makeApprovals(),
      balances: makeBalances(),
      apiOk: true,
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.network.chainId).toBe(137);
    expect(report.network.label).toBe('Polygon mainnet');
    expect(report.api.ok).toBe(true);
    expect(report.wallet.address).toBe(OWNER);
  });

  it('serialises bigints as decimal strings + formatted human-readable companions', () => {
    const report = buildDoctorReport({
      approvals: makeApprovals({ positionModule: 50_000_000n }),
      balances: makeBalances({ native: 2n * 10n ** 18n, usdc: 42_120_000n }),
      apiOk: true,
    });
    expect(report.balances.native.raw).toBe((2n * 10n ** 18n).toString());
    expect(report.balances.native.formatted).toBe('2');
    expect(report.balances.usdc.raw).toBe('42120000');
    expect(report.balances.usdc.formatted).toBe('42.12');
    expect(report.allowances.usdcPositionModule.raw).toBe('50000000');
    expect(report.allowances.usdcPositionModule.formatted).toBe('50');
  });

  it('round-trips through JSON.stringify with no BigInt errors', () => {
    const report = buildDoctorReport({
      approvals: makeApprovals({
        positionModule: maxUint256,
        oracleModule: 2n * 10n ** 18n,
      }),
      balances: makeBalances({ native: 10n ** 18n, link: 5n * 10n ** 18n }),
      apiOk: false,
    });
    expect(() => JSON.stringify(report)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.api.ok).toBe(false);
  });

  it('embeds the readiness matrix and the suggestion in the same envelope', () => {
    const report = buildDoctorReport({
      approvals: makeApprovals({ positionModule: 50_000_000n, treasuryModule: 5_000_000n }),
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
      apiOk: true,
    });
    expect(report.ready.matchCommitments.ok).toBe(true);
    expect(report.ready.createContests.ok).toBe(false);
    expect(report.suggestion?.audience).toBe('operator');
  });
});

describe('renderDoctorReport (human)', () => {
  it('writes section headers + the Ready-to matrix', () => {
    const sink = new StringSink();
    const report = buildDoctorReport({
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
      apiOk: true,
    });
    renderDoctorReport(report, sink);
    expect(sink.buf).toContain('Network:');
    expect(sink.buf).toContain('Polygon mainnet');
    expect(sink.buf).toContain('Core API:');
    expect(sink.buf).toContain('Wallet:');
    expect(sink.buf).toContain('Balances');
    expect(sink.buf).toContain('Allowances');
    expect(sink.buf).toContain('Ready to:');
    expect(sink.buf).toContain('match existing commitments');
    expect(sink.buf).toContain('submit new commitments');
    expect(sink.buf).toContain('create contests');
  });

  it('annotates a zero LINK balance as not-needed-for-most-users', () => {
    const sink = new StringSink();
    const report = buildDoctorReport({
      approvals: makeApprovals({ positionModule: 50_000_000n }),
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
      apiOk: true,
    });
    renderDoctorReport(report, sink);
    expect(sink.buf).toContain('only needed for contest creation');
  });

  it('flags a zero POL balance with a hard-blocker hint', () => {
    const sink = new StringSink();
    const report = buildDoctorReport({
      approvals: makeApprovals(),
      balances: makeBalances(),
      apiOk: true,
    });
    renderDoctorReport(report, sink);
    expect(sink.buf).toContain('no gas');
  });

  it('renders unlimited (max) approvals legibly instead of a 78-digit number', () => {
    const sink = new StringSink();
    const report = buildDoctorReport({
      approvals: makeApprovals({ positionModule: maxUint256 }),
      balances: makeBalances({ native: 10n ** 18n, usdc: 10_000_000n }),
      apiOk: true,
    });
    renderDoctorReport(report, sink);
    expect(sink.buf).toContain('unlimited (max) USDC');
    expect(sink.buf).not.toMatch(/[0-9]{30,}/);
  });

  it('writes the next-step suggestion when one exists', () => {
    const sink = new StringSink();
    const report = buildDoctorReport({
      approvals: makeApprovals(),
      balances: makeBalances(),
      apiOk: true,
    });
    renderDoctorReport(report, sink);
    expect(sink.buf).toContain('Next step:');
  });

  it('omits the next-step section when everything is satisfied', () => {
    const sink = new StringSink();
    const report = buildDoctorReport({
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
      apiOk: true,
    });
    renderDoctorReport(report, sink);
    expect(sink.buf).not.toContain('Next step:');
  });

  it('reports api unreachable when apiOk=false', () => {
    const sink = new StringSink();
    const report = buildDoctorReport({
      approvals: makeApprovals(),
      balances: makeBalances({ native: 10n ** 18n }),
      apiOk: false,
    });
    renderDoctorReport(report, sink);
    expect(sink.buf).toContain('unreachable');
  });

  it('labels Polygon Amoy correctly', () => {
    const sink = new StringSink();
    const report = buildDoctorReport({
      approvals: makeApprovals(),
      balances: makeBalances({ chainId: 80002 }),
      apiOk: true,
    });
    renderDoctorReport(report, sink);
    expect(sink.buf).toContain('Polygon Amoy');
  });
});
