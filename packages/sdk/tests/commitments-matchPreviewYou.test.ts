/**
 * Tests for the agent-facing `you` / `counterparty` / `outcomes` view
 * on `MatchPreview` plus the `computeMatchYouView` backfill helper.
 *
 * The math is anchored by the existing `commitments-buildMatchPreview`
 * suite; here we assert the new agent-facing shape — first-person
 * framing, counterparty mirror, taker-perspective outcomes — across
 * the same fixtures.
 */

import { describe, expect, it } from 'vitest';
import { buildMatchPreview } from '../src/commitments/buildMatchPreview.js';
import { computeMatchYouView } from '../src/commitments/youView.js';
import type { BuildMatchPreviewArgs, MatchPreview } from '../src/types/matchPreview.js';
import type { PublicVisibleCommitment } from '../src/types/commitment.js';

const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
const TAKER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
const MM = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const PM = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const TM = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const SCORER = '0x4444444444444444444444444444444444444444' as `0x${string}`;
const SPEC_KEY = '0x'.padEnd(66, 'a') as `0x${string}`;
const HASH = '0x'.padEnd(66, 'b') as `0x${string}`;

const FAR_FUTURE_ISO = '2099-05-08T02:00:00Z';

// Anchor fixture matches the staged Giants/Dodgers commitment used as
// the running example in preview-you-spec.md so the round-trip
// numbers tie back to the spec.
const AWAY = 'San Francisco Giants';
const HOME = 'Los Angeles Dodgers';

function makeCommitment(
  overrides: Partial<PublicVisibleCommitment> = {},
): PublicVisibleCommitment {
  return {
    visibility: 'visible',
    redacted: false,
    commitmentHash: HASH,
    maker: MAKER,
    contestId: '42',
    scorer: SCORER,
    lineTicks: 0,
    positionType: 0,
    oddsTick: 254,
    marketType: 'moneyline',
    riskAmount: '5000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '5000000',
    nonce: '17000000001',
    expiry: FAR_FUTURE_ISO,
    speculationKey: SPEC_KEY,
    signature: '0xsig',
    status: 'open',
    storedStatus: 'open',
    source: 'submit',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2026-05-09T00:00:00Z',
    ...overrides,
  };
}

function baseArgs(
  overrides: Partial<BuildMatchPreviewArgs> = {},
): BuildMatchPreviewArgs {
  return {
    commitment: makeCommitment(),
    chainId: 137,
    matchingModuleAddress: MM,
    taker: TAKER,
    awayTeam: AWAY,
    homeTeam: HOME,
    awayTeamId: 'sf-uuid',
    homeTeamId: 'lad-uuid',
    sport: 'mlb',
    matchTime: FAR_FUTURE_ISO,
    speculation: { mode: 'existing', speculationId: '101' },
    speculationKey: SPEC_KEY,
    speculationCreationTotalFeeWei6: 500_000n,
    takerTreasuryAllowanceWei6: 0n,
    makerTreasuryAllowanceWei6: 0n,
    treasuryModuleAddress: TM,
    positionModuleAddress: PM,
    takerPositionAllowanceWei6: 0n,
    nowUnixSec: 1_700_000_000n,
    ...overrides,
  };
}

describe('MatchPreview.you — moneyline', () => {
  it('maker upper (away SF) → taker/you backs home (LAD); inverted odds', () => {
    // Staged commitment: maker on SF at +154 (tick 254), 5 USDC risk.
    // Taker (you) sees Dodgers at -154 (decimal 1.65), risks 7.70 USDC
    // to win 5.00 USDC (full fill).
    //   takerRiskWei6 = (5_000_000 * (254 - 100)) / 100 = 7_700_000
    //   takerOddsTick = round(100 * 254 / 154) = 165
    const p = buildMatchPreview(baseArgs());
    expect(p.you).toBeDefined();
    expect(p.you?.role).toBe('taker');
    expect(p.you?.address).toBe(TAKER);
    expect(p.you?.backing).toBe(HOME);
    expect(p.you?.odds).toEqual({
      decimal: '1.65',
      american: '-154',
      oddsTick: 165,
    });
    expect(p.you?.risk).toEqual({ wei6: '7700000', usdc: '7.700000' });
    expect(p.you?.profit).toEqual({ wei6: '5000000', usdc: '5.000000' });
    expect(p.you?.totalReturn).toEqual({
      wei6: '12700000',
      usdc: '12.700000',
    });
  });

  it('counterparty mirrors the maker side at canonical odds', () => {
    const p = buildMatchPreview(baseArgs());
    expect(p.counterparty?.role).toBe('maker');
    expect(p.counterparty?.address).toBe(MAKER);
    expect(p.counterparty?.backing).toBe(AWAY);
    expect(p.counterparty?.odds).toEqual({
      decimal: '2.54',
      american: '+154',
      oddsTick: 254,
    });
    // Maker's risk on this fill = fillMakerRiskWei6 (5 USDC full fill).
    expect(p.counterparty?.risk).toEqual({
      wei6: '5000000',
      usdc: '5.000000',
    });
    // Zero-vig: counterparty's profit on win = taker's risk.
    expect(p.counterparty?.profit).toEqual({
      wei6: '7700000',
      usdc: '7.700000',
    });
  });

  it('maker lower (home LAD) → taker/you backs away (SF)', () => {
    const p = buildMatchPreview(
      baseArgs({ commitment: makeCommitment({ positionType: 1 }) }),
    );
    expect(p.you?.backing).toBe(AWAY);
    expect(p.counterparty?.backing).toBe(HOME);
  });
});

describe('MatchPreview.you — spread', () => {
  it('maker -3.5 away favored → taker/you backs home +3.5', () => {
    // Stored lineTicks=-35 (away favored). Maker on away (positionType=0)
    // → "Lakers -3.5". Taker on home → "Nuggets +3.5".
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'spread',
          lineTicks: -35,
          positionType: 0,
        }),
      }),
    );
    expect(p.you?.backing).toBe(`${HOME} +3.5`);
    expect(p.counterparty?.backing).toBe(`${AWAY} -3.5`);
  });

  it('maker on home flips taker to away (same -3.5 line)', () => {
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'spread',
          lineTicks: -35,
          positionType: 1,
        }),
      }),
    );
    expect(p.you?.backing).toBe(`${AWAY} -3.5`);
    expect(p.counterparty?.backing).toBe(`${HOME} +3.5`);
  });

  it("spread pick'em (lineTicks=0): both perspectives show ±0.0", () => {
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'spread',
          lineTicks: 0,
          positionType: 0,
        }),
      }),
    );
    expect(p.you?.backing).toBe(`${HOME} +0.0`);
    expect(p.counterparty?.backing).toBe(`${AWAY} +0.0`);
  });
});

describe('MatchPreview.you — total', () => {
  it('maker over → taker/you backs under at same line', () => {
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'total',
          lineTicks: 85,
          positionType: 0,
        }),
      }),
    );
    expect(p.you?.backing).toBe('Under 8.5');
    expect(p.counterparty?.backing).toBe('Over 8.5');
  });

  it('maker under → taker/you backs over', () => {
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'total',
          lineTicks: 85,
          positionType: 1,
        }),
      }),
    );
    expect(p.you?.backing).toBe('Over 8.5');
    expect(p.counterparty?.backing).toBe('Under 8.5');
  });
});

describe('MatchPreview.you — partial fill', () => {
  it('you.risk shrinks with takerDesiredRisk; counterparty.risk shrinks symmetrically', () => {
    // Same Giants commitment (5 USDC at 254), taker wants only 1 USDC.
    //   fillMakerRisk = ceil(1_000_000 * 100 / 154) - mod  = round-down to lot
    //                 = ceil(649350.6) = 649351, then 649351 - (649351 % 100) = 649300
    //   takerRisk     = 649300 * 154 / 100 = 999922 (clamps to ≤ desired 1_000_000)
    const p = buildMatchPreview(
      baseArgs({ takerDesiredRiskWei6: 1_000_000n }),
    );
    expect(p.warnings).toContain('partial-fill');
    expect(p.you?.risk.usdc).toBe('0.999922');
    expect(p.you?.profit.usdc).toBe('0.649300');
    expect(p.counterparty?.risk.usdc).toBe('0.649300');
    expect(p.counterparty?.profit.usdc).toBe('0.999922');
  });
});

describe('MatchPreview.you — self-match', () => {
  it("self-match keeps you.role === 'taker' (no third role)", () => {
    const p = buildMatchPreview(baseArgs({ taker: MAKER }));
    expect(p.selfMatch).toBe(true);
    expect(p.you?.role).toBe('taker');
    expect(p.counterparty?.role).toBe('maker');
    // Both sides addressable to the same wallet.
    expect(p.you?.address).toBe(MAKER.toLowerCase());
    expect(p.counterparty?.address).toBe(MAKER.toLowerCase());
  });
});

describe('MatchPreview.outcomes — taker perspective', () => {
  it('moneyline: two rows, win = taker side wins, lose = maker side wins', () => {
    const p = buildMatchPreview(baseArgs());
    expect(p.outcomes).toBeDefined();
    expect(p.outcomes).toHaveLength(2);
    expect(p.outcomes![0]).toEqual({
      condition: `${HOME} wins`,
      result: 'win',
      payoutUSDC: '5.000000',
    });
    expect(p.outcomes![1]).toEqual({
      condition: `${AWAY} wins`,
      result: 'lose',
      payoutUSDC: '-7.700000',
    });
  });

  it('spread integer line: three rows including push', () => {
    // lineTicks=-30 (away favored by 3 exactly). Maker on home (taker
    // on away). Selected taker role = away, selectedTicks = -30, points = 3.
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'spread',
          lineTicks: -30,
          positionType: 1,
        }),
      }),
    );
    expect(p.outcomes).toHaveLength(3);
    expect(p.outcomes![1]?.result).toBe('push');
    expect(p.outcomes![1]?.condition).toContain('exactly 3');
  });

  it('spread half-point line: two rows, no push', () => {
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'spread',
          lineTicks: -35,
          positionType: 0,
        }),
      }),
    );
    expect(p.outcomes).toHaveLength(2);
    expect(p.outcomes!.every((o) => o.result !== 'push')).toBe(true);
  });

  it('total integer line: three rows including push', () => {
    // lineTicks=80 (total 8 exactly).
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'total',
          lineTicks: 80,
          positionType: 0,
        }),
      }),
    );
    expect(p.outcomes).toHaveLength(3);
    expect(p.outcomes![1]?.result).toBe('push');
    expect(p.outcomes![1]?.condition).toContain('exactly 8');
  });

  it('total half-point line: two rows, no push', () => {
    const p = buildMatchPreview(
      baseArgs({
        commitment: makeCommitment({
          marketType: 'total',
          lineTicks: 85,
          positionType: 0,
        }),
      }),
    );
    expect(p.outcomes).toHaveLength(2);
    expect(p.outcomes!.every((o) => o.result !== 'push')).toBe(true);
  });
});

/**
 * A preview as emitted before the perspective-view fields were added: the
 * three newer keys are ABSENT, not present-and-undefined. That is what an
 * older SDK build actually produced, and `computeMatchYouView` discriminates
 * on `!== undefined`, so both spellings take the same branch.
 */
function withoutPerspectiveFields(p: MatchPreview): MatchPreview {
  const legacy = { ...p };
  delete legacy.you;
  delete legacy.counterparty;
  delete legacy.outcomes;
  return legacy;
}

describe('computeMatchYouView', () => {
  it('returns preview.you/counterparty/outcomes directly when present', () => {
    const p = buildMatchPreview(baseArgs());
    const view = computeMatchYouView(p);
    expect(view.you).toBe(p.you);
    expect(view.counterparty).toBe(p.counterparty);
    expect(view.outcomes).toBe(p.outcomes);
  });

  it('backfills you/counterparty/outcomes from legacy fields when absent', () => {
    const p = buildMatchPreview(baseArgs());
    // Simulate a legacy preview that pre-dates the perspective-view
    // addition by dropping the new fields.
    const legacy = withoutPerspectiveFields(p);
    const view = computeMatchYouView(legacy);
    // Backfill should reproduce the same shape as the freshly-built one.
    expect(view.you).toEqual(p.you);
    expect(view.counterparty).toEqual(p.counterparty);
    expect(view.outcomes).toEqual(p.outcomes);
  });

  it('backfill is consistent with the freshly-built preview across markets', () => {
    const fixtures: BuildMatchPreviewArgs[] = [
      baseArgs(),
      baseArgs({
        commitment: makeCommitment({
          marketType: 'spread',
          lineTicks: -35,
          positionType: 0,
        }),
      }),
      baseArgs({
        commitment: makeCommitment({
          marketType: 'total',
          lineTicks: 85,
          positionType: 1,
        }),
      }),
    ];
    for (const args of fixtures) {
      const built = buildMatchPreview(args);
      const legacy = withoutPerspectiveFields(built);
      const view = computeMatchYouView(legacy);
      expect(view.you).toEqual(built.you);
      expect(view.counterparty).toEqual(built.counterparty);
      expect(view.outcomes).toEqual(built.outcomes);
    }
  });
});
