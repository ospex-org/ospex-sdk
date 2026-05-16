/**
 * Unit tests for `ospex doctor --json`'s v1 → v2 envelope transform.
 *
 * Pins the wire-contract fix Hermes flagged on PR-67:
 *   - `payload.schemaVersion` MUST be absent (the outer v2 envelope
 *     is the only schemaVersion marker).
 *   - `ok` is hoisted from `report.ready.matchCommitments.ok` so the
 *     envelope's `ok` and the action's `process.exit(...)` agree.
 *   - `wallet` / `walletRole` derive from the resolved address.
 *
 * Mirrors `auth-check-v2-transform.test.ts`'s structure so all
 * command transforms share one test idiom.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDoctorReport,
  type DoctorReportInputs,
} from '../src/lib/doctorRender.js';
import { toAgentEnvelope, type DoctorPayload } from '../src/commands/doctor.js';
import type { AgentEnvelope, ApprovalsSnapshot, BalancesSnapshot, Hex } from '@ospex/sdk';

const OWNER: Hex = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const POSITION_MODULE = '0x0DCd42f8609cd7884ddBa3481b03a78dfc88366c' as const;
const TREASURY_MODULE = '0xCB56CD2c509301e888965DD3A2E5C486Fe03a56e' as const;
const ORACLE_MODULE = '0x7e1397eD5b4c9f606DCF2EB0281485B2296E29Bb' as const;
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as const;
const LINK = '0xb0897686c545045aFc77CF20eC7A532E3120E0F1' as const;

function makeApprovals(): ApprovalsSnapshot {
  return {
    owner: OWNER,
    chainId: 137,
    usdc: {
      address: USDC,
      allowances: {
        positionModule: { spender: POSITION_MODULE, raw: 10n ** 9n },
        treasuryModule: { spender: TREASURY_MODULE, raw: 10n ** 9n },
      },
    },
    link: {
      address: LINK,
      allowances: {
        oracleModule: { spender: ORACLE_MODULE, raw: 10n ** 18n },
      },
    },
  };
}

function makeBalances(): BalancesSnapshot {
  return {
    owner: OWNER,
    chainId: 137,
    native: 2n * 10n ** 18n,
    usdc: 10n ** 9n,
    link: 10n ** 18n,
  };
}

function buildHappyReport(): ReturnType<typeof buildDoctorReport> {
  const inputs: DoctorReportInputs = {
    apiOk: true,
    approvals: makeApprovals(),
    balances: makeBalances(),
  };
  return buildDoctorReport(inputs);
}

describe('toAgentEnvelope (doctor v1 → v2)', () => {
  it('does NOT retain payload.schemaVersion (Hermes PR-67 blocker)', () => {
    const report = buildHappyReport();
    expect(report.schemaVersion).toBe(1); // legacy marker present on the v1 report
    const v2 = toAgentEnvelope(report, { chainId: 137, wallet: OWNER });
    // The outer v2 envelope is the only schemaVersion marker.
    expect(v2.schemaVersion).toBe(2);
    expect('schemaVersion' in (v2.payload as Record<string, unknown>)).toBe(false);
  });

  it('hoists ok from ready.matchCommitments.ok', () => {
    const report = buildHappyReport();
    const v2 = toAgentEnvelope(report, { chainId: 137, wallet: OWNER });
    expect(v2.ok).toBe(report.ready.matchCommitments.ok);
  });

  it('emits action "doctor" and stage "read"', () => {
    const v2 = toAgentEnvelope(buildHappyReport(), { chainId: 137, wallet: OWNER });
    expect(v2.action).toBe('doctor');
    expect(v2.stage).toBe('read');
  });

  it('derives network from chainId', () => {
    expect(toAgentEnvelope(buildHappyReport(), { chainId: 137, wallet: OWNER }).network).toBe(
      'polygon',
    );
    expect(toAgentEnvelope(buildHappyReport(), { chainId: 80002, wallet: OWNER }).network).toBe(
      'amoy',
    );
  });

  it('populates wallet + signer with the resolved address', () => {
    const v2 = toAgentEnvelope(buildHappyReport(), { chainId: 137, wallet: OWNER });
    expect(v2.wallet).toBe(OWNER);
    expect(v2.signer).toBe(OWNER);
    expect(v2.walletRole).toBe('subject');
  });

  it('emits walletRole: "none" + null wallet when address could not be resolved', () => {
    const v2 = toAgentEnvelope(buildHappyReport(), { chainId: 137, wallet: null });
    expect(v2.wallet).toBeNull();
    expect(v2.signer).toBeNull();
    expect(v2.walletRole).toBe('none');
  });

  it('preserves all non-schemaVersion fields of the original report under payload', () => {
    const report = buildHappyReport();
    const v2: AgentEnvelope<DoctorPayload> = toAgentEnvelope(report, {
      chainId: 137,
      wallet: OWNER,
    });
    // Every key on the original report (minus schemaVersion) must
    // round-trip into payload unchanged. Pins the destructure-and-spread
    // strategy — if a future field gets added to JsonDoctorReport and
    // the transform forgets to forward it, this test catches it.
    const expectedKeys = Object.keys(report).filter((k) => k !== 'schemaVersion').sort();
    expect(Object.keys(v2.payload).sort()).toEqual(expectedKeys);
  });

  it('keeps warnings/errors empty under PR-2 (lifted in PR-6)', () => {
    const v2 = toAgentEnvelope(buildHappyReport(), { chainId: 137, wallet: OWNER });
    expect(v2.warnings).toEqual([]);
    expect(v2.errors).toEqual([]);
  });
});
