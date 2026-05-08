/**
 * Unit tests for the pure preview-model builder. Covers:
 *   - moneyline: economics math + 2-row outcomes (no push)
 *   - total over/under: line display, integer-line push branch
 *   - spread: home/away inversion of selected line, integer push branch,
 *     half-point no-push branch, line display includes selected-side sign
 *   - approvals[] reflects USDC allowance delta
 *   - raw block carries the full EIP-712 fields (maker, chainId,
 *     verifyingContract, speculationKey)
 */

import { describe, expect, it } from 'vitest';
import {
  buildSubmitPreview,
  type BuildSubmitPreviewArgs,
} from '../src/commitments/buildSubmitPreview.js';
import type { ResolveSideResult } from '../src/commitments/resolveSide.js';

const MAKER = '0x'.padEnd(42, '0') as `0x${string}`;
const MM = '0x'.padEnd(42, '1') as `0x${string}`;
const PM = '0x'.padEnd(42, '2') as `0x${string}`;
const SCORER = '0x'.padEnd(42, '3') as `0x${string}`;

const baseArgs = (overrides: Partial<BuildSubmitPreviewArgs> = {}): BuildSubmitPreviewArgs => ({
  contestId: 42n,
  awayTeam: 'Los Angeles Lakers',
  homeTeam: 'Denver Nuggets',
  awayTeamId: 'lakers-uuid',
  homeTeamId: 'nuggets-uuid',
  sport: 'nba',
  matchTime: '2026-05-08T02:00:00Z',
  market: 'moneyline',
  scorer: SCORER,
  lineTicks: 0,
  speculation: { mode: 'lazy', speculationId: null, speculationKey: '0xabcd' },
  resolvedSide: {
    positionType: 0,
    resolvedLabel: 'Los Angeles Lakers',
    role: 'away',
    resolutionSource: 'exact',
  },
  sideInput: 'lakers',
  oddsTick: 250,
  riskWei6: 1_000_000n,
  maker: MAKER,
  chainId: 137,
  matchingModuleAddress: MM,
  expirySec: 1778281200n,
  nonce: 17_000_000_001n,
  positionModuleAddress: PM,
  usdcCurrentAllowanceWei6: 0n,
  ...overrides,
});

describe('buildSubmitPreview — economics', () => {
  it('computes profit / return / counterparty risk from oddsTick + risk', () => {
    // 1 USDC at 2.50 odds: profit = 1 * (250-100)/100 = 1.5; return = 2.5
    const p = buildSubmitPreview(baseArgs());
    expect(p.economics.riskUSDC).toBe('1.000000');
    expect(p.economics.profitUSDC).toBe('1.500000');
    expect(p.economics.returnUSDC).toBe('2.500000');
    expect(p.economics.counterpartyRiskUSDC).toBe('1.500000');
    expect(p.economics.oddsDecimal).toBe('2.50');
    expect(p.economics.oddsTick).toBe(250);
  });

  it('handles fractional risk amounts at lot-size minimum', () => {
    // 0.0001 USDC = 100 wei6 at 1.91 odds: profit = 100 * 91/100 = 91 wei6
    const p = buildSubmitPreview(baseArgs({ riskWei6: 100n, oddsTick: 191 }));
    expect(p.economics.riskUSDC).toBe('0.000100');
    expect(p.economics.profitUSDC).toBe('0.000091');
    expect(p.economics.returnUSDC).toBe('0.000191');
  });
});

describe('buildSubmitPreview — raw EIP-712 block', () => {
  it('carries every field needed to sign the OspexCommitment exactly', () => {
    const p = buildSubmitPreview(baseArgs());
    expect(p.raw.maker).toBe(MAKER);
    expect(p.raw.chainId).toBe(137);
    expect(p.raw.verifyingContract).toBe(MM);
    expect(p.raw.contestId).toBe('42');
    expect(p.raw.scorer).toBe(SCORER);
    expect(p.raw.lineTicks).toBe(0);
    expect(p.raw.positionType).toBe(0);
    expect(p.raw.oddsTick).toBe(250);
    expect(p.raw.riskAmount).toBe('1000000');
    expect(p.raw.expiry).toBe('1778281200');
    expect(p.raw.nonce).toBe('17000000001');
    expect(p.raw.speculationKey).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('canonicalizes lazy market.speculation.speculationKey to match raw.speculationKey', () => {
    // Trust-model invariant: the preview readback must show the same
    // protocol key the signature binds. Caller-supplied lazy keys are
    // overridden by the canonical derivation.
    const p = buildSubmitPreview(
      baseArgs({
        speculation: {
          mode: 'lazy',
          speculationId: null,
          speculationKey: '0xdeadbeef', // intentionally wrong; should be overwritten
        },
      }),
    );
    expect(p.market.speculation).toMatchObject({
      mode: 'lazy',
      speculationId: null,
      speculationKey: p.raw.speculationKey,
    });
    expect(p.market.speculation.mode === 'lazy' && p.market.speculation.speculationKey).not.toBe(
      '0xdeadbeef',
    );
  });

  it('passes existing speculation through unchanged (already canonical)', () => {
    const p = buildSubmitPreview(
      baseArgs({
        speculation: { mode: 'existing', speculationId: '999' },
      }),
    );
    expect(p.market.speculation).toEqual({
      mode: 'existing',
      speculationId: '999',
    });
  });
});

describe('buildSubmitPreview — approvals', () => {
  it('flags needsApproval when current USDC allowance < required risk', () => {
    const p = buildSubmitPreview(baseArgs({ usdcCurrentAllowanceWei6: 0n }));
    expect(p.approvals).toHaveLength(1);
    expect(p.approvals[0]).toMatchObject({
      token: 'USDC',
      spender: PM,
      required: '1000000',
      current: '0',
      needsApproval: true,
    });
  });
  it('flags needsApproval=false when allowance is sufficient', () => {
    const p = buildSubmitPreview(baseArgs({ usdcCurrentAllowanceWei6: 1_000_000n }));
    expect(p.approvals[0]?.needsApproval).toBe(false);
  });
});

describe('buildSubmitPreview — moneyline outcomes', () => {
  it('emits two-row outcome list for the away-side selection', () => {
    const p = buildSubmitPreview(baseArgs());
    expect(p.market.displayLine).toBeNull();
    expect(p.outcomes).toEqual([
      { condition: 'Los Angeles Lakers wins', result: 'win', payoutUSDC: '1.500000' },
      { condition: 'Denver Nuggets wins', result: 'lose', payoutUSDC: '-1.000000' },
    ]);
  });
  it('emits two-row outcome list for the home-side selection', () => {
    const homeSide: ResolveSideResult = {
      positionType: 1,
      resolvedLabel: 'Denver Nuggets',
      role: 'home',
      resolutionSource: 'exact',
    };
    const p = buildSubmitPreview(baseArgs({ resolvedSide: homeSide }));
    expect(p.outcomes[0]).toMatchObject({
      condition: 'Denver Nuggets wins',
      result: 'win',
    });
    expect(p.outcomes[1]).toMatchObject({
      condition: 'Los Angeles Lakers wins',
      result: 'lose',
    });
  });
});

describe('buildSubmitPreview — total outcomes', () => {
  it('over with half-point line: two rows, no push', () => {
    const p = buildSubmitPreview(
      baseArgs({
        market: 'total',
        lineTicks: 85,
        riskWei6: 10_000_000n, // 10 USDC
        oddsTick: 195, // 1.95
        resolvedSide: {
          positionType: 0,
          resolvedLabel: 'over',
          role: 'over',
          resolutionSource: 'over',
        },
      }),
    );
    expect(p.market.displayLine).toBe('Over 8.5');
    expect(p.outcomes).toHaveLength(2);
    expect(p.outcomes[0]?.result).toBe('win');
    expect(p.outcomes[1]?.result).toBe('lose');
  });
  it('over with integer line: three rows including push', () => {
    const p = buildSubmitPreview(
      baseArgs({
        market: 'total',
        lineTicks: 80,
        riskWei6: 10_000_000n,
        oddsTick: 195,
        resolvedSide: {
          positionType: 0,
          resolvedLabel: 'over',
          role: 'over',
          resolutionSource: 'over',
        },
      }),
    );
    expect(p.market.displayLine).toBe('Over 8.0');
    expect(p.outcomes.map((o) => o.result)).toEqual(['win', 'push', 'lose']);
    expect(p.outcomes[1]?.payoutUSDC).toBe('10.000000'); // stake returned
  });
});

describe('buildSubmitPreview — spread outcomes (home/away inversion)', () => {
  it('away favored at -3.5 (line_ticks=-35): two-row no-push outcomes', () => {
    const p = buildSubmitPreview(
      baseArgs({
        market: 'spread',
        lineTicks: -35,
        riskWei6: 25_000_000n,
        oddsTick: 191,
        resolvedSide: {
          positionType: 0,
          resolvedLabel: 'Los Angeles Lakers',
          role: 'away',
          resolutionSource: 'exact',
        },
      }),
    );
    expect(p.market.displayLine).toBe('Los Angeles Lakers -3.5');
    expect(p.outcomes).toHaveLength(2);
    expect(p.outcomes[0]?.result).toBe('win');
    expect(p.outcomes[1]?.result).toBe('lose');
  });

  it('away favored at -3 (integer): three-row with push', () => {
    const p = buildSubmitPreview(
      baseArgs({
        market: 'spread',
        lineTicks: -30,
        riskWei6: 25_000_000n,
        oddsTick: 191,
        resolvedSide: {
          positionType: 0,
          resolvedLabel: 'Los Angeles Lakers',
          role: 'away',
          resolutionSource: 'exact',
        },
      }),
    );
    expect(p.market.displayLine).toBe('Los Angeles Lakers -3.0');
    expect(p.outcomes.map((o) => o.result)).toEqual(['win', 'push', 'lose']);
  });

  it('home selection inverts the line sign: home -3.5 ⇔ away +3.5', () => {
    // Stored line_ticks = +35 (away getting +3.5; home favored by 3.5)
    const p = buildSubmitPreview(
      baseArgs({
        market: 'spread',
        lineTicks: 35,
        riskWei6: 25_000_000n,
        oddsTick: 191,
        resolvedSide: {
          positionType: 1,
          resolvedLabel: 'Denver Nuggets',
          role: 'home',
          resolutionSource: 'exact',
        },
      }),
    );
    // From home's perspective, home is favored by 3.5 → display as -3.5.
    expect(p.market.displayLine).toBe('Denver Nuggets -3.5');
    // Win condition: home wins by 4 or more.
    expect(p.outcomes[0]?.condition).toMatch(/wins by 4/);
  });

  it('underdog at +3.5: win = team wins or loses by 3 or fewer', () => {
    const p = buildSubmitPreview(
      baseArgs({
        market: 'spread',
        lineTicks: 35, // away +3.5
        riskWei6: 25_000_000n,
        oddsTick: 191,
        resolvedSide: {
          positionType: 0,
          resolvedLabel: 'Los Angeles Lakers',
          role: 'away',
          resolutionSource: 'exact',
        },
      }),
    );
    expect(p.market.displayLine).toBe('Los Angeles Lakers +3.5');
    expect(p.outcomes[0]?.condition).toMatch(/wins.*OR.*loses/);
  });

  it('pickem at lineTicks=0: emits three-row outcomes including push (matches pushPossible)', () => {
    // Spread line=0 satisfies `line_ticks % 10 === 0` so pushPossible
    // returns true. The outcome generator must mirror that — never
    // collapse to the moneyline two-row shape.
    const p = buildSubmitPreview(
      baseArgs({
        market: 'spread',
        lineTicks: 0,
        riskWei6: 10_000_000n,
        oddsTick: 200,
        resolvedSide: {
          positionType: 0,
          resolvedLabel: 'Los Angeles Lakers',
          role: 'away',
          resolutionSource: 'exact',
        },
      }),
    );
    expect(p.outcomes).toHaveLength(3);
    expect(p.outcomes.map((o) => o.result)).toEqual(['win', 'push', 'lose']);
    expect(p.outcomes[1]?.condition).toMatch(/tie/);
    expect(p.outcomes[1]?.payoutUSDC).toBe('10.000000'); // stake returned
  });
});
