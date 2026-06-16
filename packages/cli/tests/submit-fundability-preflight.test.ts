/**
 * Unit tests for the `commitments submit` fundability-preflight helpers.
 *
 * The load-bearing logic is `selectBlockingSubmitReasons`: the submit approve-loop
 * (or a manual `approve`) remediates the maker's ALLOWANCE shortfalls, so those
 * must NOT block (blocking would regress the normal approve-on-submit flow); only
 * the non-remediable USDC BALANCE shortfall blocks. `EXISTING_LAZY_FEE_UNDETERMINED`
 * and `FUNDABILITY_UNKNOWN` are advisory.
 */

import { describe, expect, it } from 'vitest';
import {
  SUBMIT_REMEDIABLE_REASON_CODES,
  buildSubmitRefusedEnvelope,
  computeSubmitRemediatedReasonCodes,
  hasRemediableShortfall,
  renderSubmitFundabilityNotice,
  renderSubmitPreflightRefusal,
  selectBlockingSubmitReasons,
  submitFundabilityReasonMessage,
} from '../src/lib/submitFundabilityPreflight.js';
import type {
  CheckSubmitFundabilityResult,
  SubmitFundabilityReason,
  SubmitFundabilityReasonCode,
  Hex,
} from '@ospex/sdk';

const USDC = '0x3333333333333333333333333333333333333333' as Hex;
const POSITION = '0x2222222222222222222222222222222222222222' as Hex;
const TREASURY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;

function reason(code: SubmitFundabilityReasonCode, extra: Partial<SubmitFundabilityReason> = {}): SubmitFundabilityReason {
  return { code, ...extra };
}

function makeResult(reasons: SubmitFundabilityReason[]): CheckSubmitFundabilityResult {
  const hasBlocking = reasons.some((r) => r.code === 'MAKER_USDC_BALANCE_INSUFFICIENT');
  const hasUnknown = reasons.some(
    (r) => r.code === 'FUNDABILITY_UNKNOWN' || r.code === 'EXISTING_LAZY_FEE_UNDETERMINED',
  );
  const outcome = hasBlocking || (reasons.length > 0 && !hasUnknown)
    ? 'not-fundable'
    : hasUnknown
      ? 'unknown'
      : 'fundable';
  return {
    maker: MAKER,
    fundableNow: outcome === 'fundable',
    outcome,
    scope: 'visible-book-only',
    coverage: { visible: 'included', hidden: 'excluded', source: 'public-commitments' },
    advisory: true,
    checkedAtBlock: 73_491_234n,
    reasons,
  };
}

const codes = (rs: SubmitFundabilityReason[]): SubmitFundabilityReasonCode[] => rs.map((r) => r.code);

describe('selectBlockingSubmitReasons', () => {
  it('blocks ONLY on the non-remediable USDC balance shortfall', () => {
    expect(codes(selectBlockingSubmitReasons([reason('MAKER_USDC_BALANCE_INSUFFICIENT')]))).toEqual([
      'MAKER_USDC_BALANCE_INSUFFICIENT',
    ]);
  });

  it('does NOT block on maker-allowance reasons (approve / the submit approve-loop remediates them)', () => {
    for (const code of SUBMIT_REMEDIABLE_REASON_CODES) {
      expect(selectBlockingSubmitReasons([reason(code)])).toHaveLength(0);
    }
    // Sanity: the remediable set is exactly the two maker-allowance codes.
    expect([...SUBMIT_REMEDIABLE_REASON_CODES].sort()).toEqual([
      'MAKER_POSITION_ALLOWANCE_INSUFFICIENT',
      'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT',
    ]);
  });

  it('does NOT block on EXISTING_LAZY_FEE_UNDETERMINED, FUNDABILITY_UNKNOWN, or HIDDEN_EXPOSURE_UNKNOWN (advisory)', () => {
    expect(selectBlockingSubmitReasons([reason('EXISTING_LAZY_FEE_UNDETERMINED')])).toHaveLength(0);
    expect(selectBlockingSubmitReasons([reason('FUNDABILITY_UNKNOWN')])).toHaveLength(0);
    // whole-book mode couldn't read hidden exposure → unknown, not a refusal.
    expect(selectBlockingSubmitReasons([reason('HIDDEN_EXPOSURE_UNKNOWN')])).toHaveLength(0);
  });

  it('still blocks the balance shortfall even when a HIDDEN_EXPOSURE_UNKNOWN rides alongside it', () => {
    // whole-book own-state failed (→ HIDDEN_EXPOSURE_UNKNOWN) AND the visible/new
    // lower bound is a definite shortfall: the shortfall must still refuse-before-sign.
    const mixed = [
      reason('MAKER_USDC_BALANCE_INSUFFICIENT', { requiredWei6: 3_000_000n, actualWei6: 1_000_000n }),
      reason('HIDDEN_EXPOSURE_UNKNOWN'),
    ];
    expect(codes(selectBlockingSubmitReasons(mixed))).toEqual(['MAKER_USDC_BALANCE_INSUFFICIENT']);
  });

  it('keeps only the blocking reason from a mixed set', () => {
    const mixed = [
      reason('MAKER_USDC_BALANCE_INSUFFICIENT', { requiredWei6: 3_000_000n, actualWei6: 1_000_000n }),
      reason('MAKER_POSITION_ALLOWANCE_INSUFFICIENT', { requiredWei6: 3_000_000n, actualWei6: 0n }),
      reason('EXISTING_LAZY_FEE_UNDETERMINED', { requiredWei6: 500_000n }),
    ];
    expect(codes(selectBlockingSubmitReasons(mixed))).toEqual(['MAKER_USDC_BALANCE_INSUFFICIENT']);
  });

  it('returns empty for a fundable verdict', () => {
    expect(selectBlockingSubmitReasons([])).toHaveLength(0);
  });
});

describe('submitFundabilityReasonMessage', () => {
  it('includes the required-vs-actual amounts for funding reasons', () => {
    const msg = submitFundabilityReasonMessage(
      reason('MAKER_USDC_BALANCE_INSUFFICIENT', { token: USDC, requiredWei6: 3_000_000n, actualWei6: 1_000_000n }),
    );
    expect(msg).toMatch(/needs 3\.000000 USDC, has 1\.000000/);
  });

  it('spells out that the balance shortfall is not fixable by approving', () => {
    expect(submitFundabilityReasonMessage(reason('MAKER_USDC_BALANCE_INSUFFICIENT'))).toMatch(/approving won't help/i);
  });

  it('tells the maker to approve for an allowance shortfall', () => {
    expect(submitFundabilityReasonMessage(reason('MAKER_POSITION_ALLOWANCE_INSUFFICIENT'))).toMatch(/approve/i);
    expect(submitFundabilityReasonMessage(reason('MAKER_TREASURY_ALLOWANCE_INSUFFICIENT'))).toMatch(/approve/i);
  });

  it('explains the existing-lazy-fee uncertainty', () => {
    const msg = submitFundabilityReasonMessage(reason('EXISTING_LAZY_FEE_UNDETERMINED', { requiredWei6: 500_000n }));
    expect(msg).toMatch(/creation fee/i);
    expect(msg).toMatch(/up to 0\.500000 USDC/);
  });

  it('explains that whole-book hidden exposure could not be read (HIDDEN_EXPOSURE_UNKNOWN)', () => {
    const msg = submitFundabilityReasonMessage(reason('HIDDEN_EXPOSURE_UNKNOWN'));
    expect(msg).toMatch(/hidden/i);
    expect(msg).toMatch(/whole-book/i);
  });
});

describe('buildSubmitRefusedEnvelope', () => {
  const blocking = [
    reason('MAKER_USDC_BALANCE_INSUFFICIENT', {
      token: USDC,
      requiredWei6: 3_000_000n,
      actualWei6: 1_000_000n,
    }),
  ];
  const env = buildSubmitRefusedEnvelope(makeResult(blocking), blocking, { chainId: 137, wallet: MAKER });

  it('is a not-OK execute envelope for the submit action (off-chain → no tx)', () => {
    expect(env.ok).toBe(false);
    expect(env.action).toBe('commitments.submit');
    expect(env.stage).toBe('execute');
    expect(env.walletRole).toBe('signer');
    expect(env.wallet).toBe(MAKER);
    expect(env.requiresTransaction).toBe(false);
  });

  it('carries the full advisory verdict + the refused-before-sign marker in the payload', () => {
    expect(env.payload.action).toBe('refused-before-sign');
    expect(env.payload.fundability.outcome).toBe('not-fundable');
    expect(env.payload.fundability.reasons).toEqual(blocking);
  });

  it('surfaces each blocking reason as a blocking warning that blocks `submit`', () => {
    expect(env.warnings).toHaveLength(1);
    const w = env.warnings[0]!;
    expect(w.code).toBe('MAKER_USDC_BALANCE_INSUFFICIENT');
    expect(w.severity).toBe('blocking');
    expect(w.blockingFor).toEqual(['submit']);
  });

  it('records no effects (nothing was signed or posted)', () => {
    expect(env.effects).toHaveLength(0);
  });
});

describe('renderSubmitPreflightRefusal / renderSubmitFundabilityNotice', () => {
  it('refusal block names the reason and points at the bypass flags', () => {
    const text = renderSubmitPreflightRefusal([reason('MAKER_USDC_BALANCE_INSUFFICIENT')]);
    expect(text).toMatch(/nothing signed/i);
    expect(text).toMatch(/approving won't help/i);
    expect(text).toMatch(/--skip-fundability-preflight/);
    expect(text).toMatch(/--force/);
  });

  it('advisory notice is empty for a clean verdict and lists reasons otherwise', () => {
    expect(renderSubmitFundabilityNotice(makeResult([]))).toBe('');
    const notice = renderSubmitFundabilityNotice(makeResult([reason('MAKER_POSITION_ALLOWANCE_INSUFFICIENT')]));
    expect(notice).toMatch(/advisory/i);
    expect(notice).toMatch(/PositionModule/);
  });
});

describe('computeSubmitRemediatedReasonCodes', () => {
  it('returns codes present pre but absent post, scoped to remediable set', () => {
    const pre = makeResult([
      reason('MAKER_POSITION_ALLOWANCE_INSUFFICIENT'),
      reason('MAKER_TREASURY_ALLOWANCE_INSUFFICIENT'),
    ]);
    const post = makeResult([reason('MAKER_TREASURY_ALLOWANCE_INSUFFICIENT')]);
    expect(computeSubmitRemediatedReasonCodes(pre, post)).toEqual([
      'MAKER_POSITION_ALLOWANCE_INSUFFICIENT',
    ]);
  });

  it('returns empty when post still has all the same remediable reasons (approve loop did not help)', () => {
    const pre = makeResult([reason('MAKER_POSITION_ALLOWANCE_INSUFFICIENT')]);
    const post = makeResult([reason('MAKER_POSITION_ALLOWANCE_INSUFFICIENT')]);
    expect(computeSubmitRemediatedReasonCodes(pre, post)).toEqual([]);
  });

  it('returns empty when post is unknown — we do not claim "resolved" from a degraded read', () => {
    const pre = makeResult([reason('MAKER_POSITION_ALLOWANCE_INSUFFICIENT')]);
    const post = makeResult([reason('FUNDABILITY_UNKNOWN')]);
    expect(computeSubmitRemediatedReasonCodes(pre, post)).toEqual([]);
  });

  it('ignores non-remediable codes that may have changed across pre/post', () => {
    const pre = makeResult([
      reason('MAKER_POSITION_ALLOWANCE_INSUFFICIENT'),
      reason('MAKER_USDC_BALANCE_INSUFFICIENT'),
    ]);
    const post = makeResult([]);
    expect(computeSubmitRemediatedReasonCodes(pre, post)).toEqual([
      'MAKER_POSITION_ALLOWANCE_INSUFFICIENT',
    ]);
  });
});

describe('hasRemediableShortfall (submit)', () => {
  it('true when the verdict has any maker-allowance reason', () => {
    expect(hasRemediableShortfall(makeResult([reason('MAKER_POSITION_ALLOWANCE_INSUFFICIENT')]))).toBe(true);
    expect(hasRemediableShortfall(makeResult([reason('MAKER_TREASURY_ALLOWANCE_INSUFFICIENT')]))).toBe(true);
  });

  it('false when the verdict is clean', () => {
    expect(hasRemediableShortfall(makeResult([]))).toBe(false);
  });

  it('false when the verdict only has non-remediable / advisory reasons', () => {
    expect(hasRemediableShortfall(makeResult([reason('MAKER_USDC_BALANCE_INSUFFICIENT')]))).toBe(false);
    expect(hasRemediableShortfall(makeResult([reason('FUNDABILITY_UNKNOWN')]))).toBe(false);
  });
});
