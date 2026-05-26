/**
 * Unit tests for the `commitments match` fillability-preflight helpers.
 *
 * The load-bearing logic is `selectBlockingMatchReasons`: the match approve-loop
 * remediates the TAKER's allowance, so a taker-allowance shortfall must NOT
 * block the match, while every non-remediable reason (maker balance/allowance,
 * taker balance, liveness, closed-spec) must. `FILLABILITY_UNKNOWN` is advisory.
 */

import { describe, expect, it } from 'vitest';
import {
  MATCH_REMEDIABLE_REASON_CODES,
  buildMatchRefusedEnvelope,
  reasonMessage,
  selectBlockingMatchReasons,
} from '../src/lib/matchFillabilityPreflight.js';
import type {
  CheckCommitmentFillabilityResult,
  FillabilityReason,
  FillabilityReasonCode,
  Hex,
} from '@ospex/sdk';

const USDC = '0x3333333333333333333333333333333333333333' as Hex;
const POSITION = '0x2222222222222222222222222222222222222222' as Hex;
const TAKER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const HASH = ('0x' + 'b'.repeat(64)) as Hex;

function reason(code: FillabilityReasonCode, extra: Partial<FillabilityReason> = {}): FillabilityReason {
  return { code, ...extra };
}

function makeResult(reasons: FillabilityReason[]): CheckCommitmentFillabilityResult {
  const outcome = reasons.some((r) => r.code === 'FILLABILITY_UNKNOWN')
    ? 'unknown'
    : reasons.length > 0
      ? 'not-fillable'
      : 'fillable';
  return {
    commitmentHash: HASH,
    fillableNow: outcome === 'fillable',
    outcome,
    advisory: true,
    checkedAtBlock: 73_491_234n,
    fill: { makerRiskWei6: 1_000_000n, takerRiskWei6: 1_500_000n, selfMatch: false },
    reasons,
  };
}

const codes = (rs: FillabilityReason[]): FillabilityReasonCode[] => rs.map((r) => r.code);

describe('selectBlockingMatchReasons', () => {
  it('blocks on every NON-remediable reason', () => {
    const nonRemediable: FillabilityReasonCode[] = [
      'MAKER_USDC_BALANCE_INSUFFICIENT',
      'MAKER_POSITION_ALLOWANCE_INSUFFICIENT',
      'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT',
      'TAKER_USDC_BALANCE_INSUFFICIENT',
      'NOT_LIVE',
      'EXPIRED',
      'NONCE_INVALIDATED',
      'NO_REMAINING_CAPACITY',
      'SPECULATION_CLOSED',
    ];
    for (const code of nonRemediable) {
      expect(codes(selectBlockingMatchReasons([reason(code)]))).toEqual([code]);
    }
  });

  it('does NOT block on taker-allowance reasons (the approve-loop remediates them)', () => {
    for (const code of MATCH_REMEDIABLE_REASON_CODES) {
      expect(selectBlockingMatchReasons([reason(code)])).toHaveLength(0);
    }
    // Sanity: the remediable set is exactly the two taker-allowance codes.
    expect([...MATCH_REMEDIABLE_REASON_CODES].sort()).toEqual([
      'TAKER_POSITION_ALLOWANCE_INSUFFICIENT',
      'TAKER_TREASURY_ALLOWANCE_INSUFFICIENT',
    ]);
  });

  it('does NOT block on FILLABILITY_UNKNOWN (advisory)', () => {
    expect(selectBlockingMatchReasons([reason('FILLABILITY_UNKNOWN')])).toHaveLength(0);
  });

  it('keeps only the blocking reasons from a mixed set', () => {
    const mixed = [
      reason('MAKER_USDC_BALANCE_INSUFFICIENT', { requiredWei6: 1_000_000n, actualWei6: 0n }),
      reason('TAKER_POSITION_ALLOWANCE_INSUFFICIENT', { requiredWei6: 1_500_000n, actualWei6: 0n }),
    ];
    expect(codes(selectBlockingMatchReasons(mixed))).toEqual(['MAKER_USDC_BALANCE_INSUFFICIENT']);
  });

  it('returns empty for a fillable verdict', () => {
    expect(selectBlockingMatchReasons([])).toHaveLength(0);
  });
});

describe('reasonMessage', () => {
  it('includes the required-vs-actual amounts for funding reasons', () => {
    const msg = reasonMessage(
      reason('TAKER_USDC_BALANCE_INSUFFICIENT', {
        account: 'taker',
        token: USDC,
        requiredWei6: 1_500_000n,
        actualWei6: 0n,
      }),
    );
    expect(msg).toMatch(/needs 1\.500000 USDC, has 0\.000000/);
  });

  it('spells out that maker-side shortfalls are not the taker’s to fix', () => {
    expect(reasonMessage(reason('MAKER_USDC_BALANCE_INSUFFICIENT'))).toMatch(/taker cannot fix/i);
    expect(reasonMessage(reason('MAKER_POSITION_ALLOWANCE_INSUFFICIENT'))).toMatch(/taker cannot fix/i);
  });
});

describe('buildMatchRefusedEnvelope', () => {
  const blocking = [
    reason('MAKER_POSITION_ALLOWANCE_INSUFFICIENT', {
      account: 'maker',
      token: USDC,
      spender: POSITION,
      requiredWei6: 1_000_000n,
      actualWei6: 0n,
    }),
  ];
  const env = buildMatchRefusedEnvelope(makeResult(blocking), blocking, {
    chainId: 137,
    wallet: TAKER,
  });

  it('is a not-OK execute envelope for the match action', () => {
    expect(env.ok).toBe(false);
    expect(env.action).toBe('commitments.match');
    expect(env.stage).toBe('execute');
    expect(env.walletRole).toBe('signer');
    expect(env.wallet).toBe(TAKER);
  });

  it('carries the full advisory verdict + the refused-before-send marker in the payload', () => {
    expect(env.payload.action).toBe('refused-before-send');
    expect(env.payload.preflight.outcome).toBe('not-fillable');
    expect(env.payload.preflight.reasons).toEqual(blocking);
  });

  it('surfaces each blocking reason as a blocking warning that blocks `match`', () => {
    expect(env.warnings).toHaveLength(1);
    const w = env.warnings[0]!;
    expect(w.code).toBe('MAKER_POSITION_ALLOWANCE_INSUFFICIENT');
    expect(w.severity).toBe('blocking');
    expect(w.blockingFor).toEqual(['match']);
  });

  it('records no effects (nothing was signed or sent)', () => {
    expect(env.effects).toHaveLength(0);
  });
});
