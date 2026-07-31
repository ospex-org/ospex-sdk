/**
 * Cross-envelope contract test: WHICH emitted USDC decimal strings carry a
 * paired integer field, and which do not.
 *
 * The public docs tell agents to decode a USDC amount by reading its paired
 * integer with `BigInt()`. That rule has exceptions, and the exception set is
 * PER ENVELOPE — `MatchPreview` and `SubmitPreview` do not agree. Stating a
 * single global exception list is what put this claim wrong repeatedly, so
 * each envelope's set is measured and pinned here instead of asserted in
 * prose. A new unpaired field fails this test and forces the docs to change.
 *
 * Deliberately NOT a global claim: the top-level agent envelope uses a third
 * naming convention (`requiredWei` / `requiredHuman` on `ApprovalRequirement`)
 * that this classifier does not even recognise as a pair. The docs therefore
 * state a non-exhaustive rule and scope every exhaustive table to the envelope
 * it was measured on.
 */

import { describe, expect, it } from 'vitest';
import { buildMatchPreview } from '../src/commitments/buildMatchPreview.js';
import { buildSubmitPreview } from '../src/commitments/buildSubmitPreview.js';
import { usdcDecimalToAmountWei6, wei6ToDecimalUSDC } from '../src/commitments/decimals.js';

const FAR_FUTURE_ISO = '2099-05-08T02:00:00Z';
const A40 = (c: string) => `0x${c.repeat(40)}` as `0x${string}`;
const A64 = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;

/** A USDC string is "paired" when its integer twin sits beside it. */
function classify(
  node: unknown,
  path: string,
  paired: Set<string>,
  unpaired: Set<string>,
): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const v of node) classify(v, `${path}[*]`, paired, unpaired);
    return;
  }
  if (typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  const keys = Object.keys(rec);
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && (k.endsWith('USDC') || k === 'usdc')) {
      const twin = k === 'usdc' ? 'wei6' : `${k.slice(0, -4)}Wei6`;
      const has = keys.includes(twin) && typeof rec[twin] === 'string';
      (has ? paired : unpaired).add(`${path}.${k}`);
    } else {
      classify(v, `${path}.${k}`, paired, unpaired);
    }
  }
}

function split(objs: unknown[]): { paired: string[]; unpaired: string[] } {
  const paired = new Set<string>();
  const unpaired = new Set<string>();
  for (const o of objs) classify(o, '$', paired, unpaired);
  return { paired: [...paired].sort(), unpaired: [...unpaired].sort() };
}

// ── MatchPreview fixtures ─────────────────────────────────────────────

const commitment = (o: Record<string, unknown> = {}) => ({
  visibility: 'visible', redacted: false, commitmentHash: A64('b'), maker: A40('a'),
  contestId: '42', scorer: A40('4'), lineTicks: 0, positionType: 0, oddsTick: 250,
  marketType: 'moneyline', riskAmount: '1000000', filledRiskAmount: '0',
  remainingRiskAmount: '1000000', nonce: '17000000001', expiry: FAR_FUTURE_ISO,
  speculationKey: A64('a'), signature: '0xsig', status: 'open', storedStatus: 'open',
  source: 'submit', network: 'polygon', nonceInvalidated: false, isLive: true,
  createdAt: '2026-05-09T00:00:00Z', ...o,
});

const matchArgs = (o: Record<string, unknown> = {}) =>
  ({
    commitment: commitment((o.commitment as Record<string, unknown>) ?? {}),
    chainId: 137, matchingModuleAddress: A40('1'), taker: A40('c'),
    awayTeam: 'Los Angeles Lakers', homeTeam: 'Denver Nuggets',
    awayTeamId: 'lakers-uuid', homeTeamId: 'nuggets-uuid', sport: 'nba',
    matchTime: FAR_FUTURE_ISO,
    speculation: o.speculation ?? { mode: 'existing', speculationId: '101' },
    speculationKey: A64('a'), speculationCreationTotalFeeWei6: 500_000n,
    takerTreasuryAllowanceWei6: 0n, makerTreasuryAllowanceWei6: 0n,
    treasuryModuleAddress: A40('3'), positionModuleAddress: A40('2'),
    takerPositionAllowanceWei6: 0n, nowUnixSec: 1_700_000_000n,
    ...(o.extra as Record<string, unknown> | undefined),
  }) as never;

// ── SubmitPreview fixtures ────────────────────────────────────────────

const submitArgs = (o: Record<string, unknown> = {}) =>
  ({
    contestId: 42n, awayTeam: 'Los Angeles Lakers', homeTeam: 'Denver Nuggets',
    awayTeamId: 'lakers-uuid', homeTeamId: 'nuggets-uuid', sport: 'nba',
    matchTime: FAR_FUTURE_ISO, market: 'moneyline', scorer: A40('3'), lineTicks: 0,
    speculation: o.speculation ?? {
      mode: 'existing', speculationId: '100', speculationKey: '0xabcd',
    },
    resolvedSide: {
      positionType: 0, resolvedLabel: 'Los Angeles Lakers', role: 'away',
      resolutionSource: 'exact',
    },
    sideInput: 'lakers', oddsTick: 250, riskWei6: 1_000_000n, maker: A40('0'),
    chainId: 137, matchingModuleAddress: A40('1'), expirySec: 4_081_888_800n,
    expirySource: 'default-match-time', matchTimeSec: 4_081_888_800n,
    makerCreationFeeWei6: 250_000n, treasuryModuleAddress: A40('4'),
    treasuryUsdcCurrentAllowanceWei6: 0n, nonce: 17_000_000_001n,
    positionModuleAddress: A40('2'), usdcCurrentAllowanceWei6: 0n,
    ...(o.extra as Record<string, unknown> | undefined),
  }) as never;

const LAZY = { mode: 'lazy', speculationId: null, speculationKey: '0xabcd' };

// ── The pinned sets ───────────────────────────────────────────────────

/** MatchPreview: measured, not asserted. Mirrored in types/matchPreview.ts. */
const MATCH_UNPAIRED = [
  '$.economics.takerProfitOnWinUSDC',
  '$.economics.takerReturnOnWinUSDC',
  '$.outcomes[*].payoutUSDC',
];

/** SubmitPreview: a DIFFERENT and larger set. Mirrored in AGENT_CONTRACT.md. */
const SUBMIT_UNPAIRED = [
  '$.economics.counterpartyRiskUSDC',
  '$.economics.profitUSDC',
  '$.economics.returnUSDC',
  '$.market.speculation.makerCreationFeeUSDC', // lazy mode only
  '$.outcomes[*].payoutUSDC',
];

describe('USDC field pairing — MatchPreview', () => {
  const previews = [
    matchArgs(),
    matchArgs({ speculation: { mode: 'lazy' } }),
    matchArgs({ commitment: { marketType: 'spread', lineTicks: -35 } }),
    matchArgs({ commitment: { marketType: 'total', lineTicks: 85 } }),
    matchArgs({ extra: { takerDesiredRiskWei6: 150n } }),
  ].map((a) => buildMatchPreview(a));

  it('the unpaired set is exactly the three documented for MatchPreview', () => {
    const { paired, unpaired } = split(previews);
    expect(unpaired).toEqual(MATCH_UNPAIRED);
    expect(paired.length).toBeGreaterThan(10);
    // The `{ wei6, usdc }` convention counts as paired, not skipped.
    expect(paired).toContain('$.you.risk.usdc');
  });
});

describe('USDC field pairing — SubmitPreview', () => {
  it('has a DIFFERENT, larger unpaired set than MatchPreview', () => {
    const { paired, unpaired } = split([
      buildSubmitPreview(submitArgs()),
      buildSubmitPreview(submitArgs({ speculation: LAZY })),
      buildSubmitPreview(submitArgs({ extra: { market: 'spread', lineTicks: -35 } })),
      buildSubmitPreview(submitArgs({ extra: { market: 'total', lineTicks: 85 } })),
    ]);
    expect(unpaired).toEqual(SUBMIT_UNPAIRED);
    expect(paired.length).toBeGreaterThan(5);

    // The whole reason no global list can be stated: the two envelopes
    // genuinely disagree, and SubmitPreview is the bigger one.
    expect(unpaired.length).toBeGreaterThan(MATCH_UNPAIRED.length);
    expect(unpaired).not.toEqual(MATCH_UNPAIRED);
  });

  it('makerCreationFeeUSDC appears only in lazy mode', () => {
    const existing = split([buildSubmitPreview(submitArgs())]);
    expect(existing.unpaired).toEqual(
      SUBMIT_UNPAIRED.filter((p) => p !== '$.market.speculation.makerCreationFeeUSDC'),
    );
    const lazy = split([buildSubmitPreview(submitArgs({ speculation: LAZY }))]);
    expect(lazy.unpaired).toContain('$.market.speculation.makerCreationFeeUSDC');
  });
});

describe('USDC field pairing — what holds across BOTH envelopes', () => {
  const all = [
    ...[matchArgs(), matchArgs({ speculation: { mode: 'lazy' } })].map((a) => buildMatchPreview(a)),
    buildSubmitPreview(submitArgs()),
    buildSubmitPreview(submitArgs({ speculation: LAZY })),
  ];

  it('outcomes[].payoutUSDC is unpaired in both, and is the only SIGNED string', () => {
    const { unpaired } = split(all);
    expect(unpaired).toContain('$.outcomes[*].payoutUSDC');

    const signed: string[] = [];
    const collect = (node: unknown, path: string): void => {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) return node.forEach((v) => collect(v, `${path}[*]`));
      if (typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (typeof v === 'string' && (k.endsWith('USDC') || k === 'usdc')) {
          if (v.startsWith('-')) signed.push(`${path}.${k}`);
        } else collect(v, `${path}.${k}`);
      }
    };
    for (const o of all) collect(o, '$');
    expect([...new Set(signed)]).toEqual(['$.outcomes[*].payoutUSDC']);
  });

  it('every unpaired field except payoutUSDC has an exact integer source elsewhere', () => {
    /**
     * This replaces sign claims. "Always positive" kept being wrong — the
     * builders accept degenerate-but-supported inputs (a zero creation fee,
     * a risk small enough that profit floors to zero) that make these fields
     * `'0.000000'`. Naming the integer SOURCE is sign-agnostic and therefore
     * cannot rot the same way.
     */
    // MatchPreview: perspective blocks carry the taker's numbers.
    for (const args of [matchArgs(), matchArgs({ speculation: { mode: 'lazy' } })]) {
      const mp = buildMatchPreview(args) as unknown as {
        economics: {
          fillMakerRiskWei6: string;
          takerProfitOnWinUSDC: string;
          takerRiskWei6: string;
          takerReturnOnWinUSDC: string;
        };
        you: { profit: { wei6: string }; totalReturn: { wei6: string } };
      };
      expect(BigInt(mp.you.profit.wei6)).toBe(BigInt(mp.economics.fillMakerRiskWei6));
      expect(usdcDecimalToAmountWei6(mp.economics.takerProfitOnWinUSDC)).toBe(
        BigInt(mp.you.profit.wei6),
      );
      expect(BigInt(mp.you.totalReturn.wei6)).toBe(
        BigInt(mp.economics.takerRiskWei6) + BigInt(mp.economics.fillMakerRiskWei6),
      );
      expect(usdcDecimalToAmountWei6(mp.economics.takerReturnOnWinUSDC)).toBe(
        BigInt(mp.you.totalReturn.wei6),
      );
    }

    // SubmitPreview, INCLUDING the degenerate cases the builder supports.
    const submitCases = [
      submitArgs({ speculation: LAZY }),
      submitArgs({ speculation: LAZY, extra: { makerCreationFeeWei6: 0n } }),
      submitArgs({ speculation: LAZY, extra: { riskWei6: 1n, oddsTick: 101 } }),
      submitArgs({ speculation: LAZY, extra: { riskWei6: 0n } }),
    ];
    let sawZero = 0;
    for (const args of submitCases) {
      const sp = buildSubmitPreview(args) as unknown as {
        economics: {
          counterpartyRiskUSDC: string;
          profitUSDC: string;
          returnUSDC: string;
        };
        you: { profit: { wei6: string }; totalReturn: { wei6: string } };
        counterparty: { risk: { wei6: string } };
        market: {
          speculation: {
            makerCreationFeeUSDC: string;
            creationFee: { makerShareWei6: string };
          };
        };
      };
      const fee = sp.market.speculation;
      const decimals = [
        sp.economics.counterpartyRiskUSDC,
        sp.economics.profitUSDC,
        sp.economics.returnUSDC,
        fee.makerCreationFeeUSDC,
      ];
      if (decimals.some((d) => d === '0.000000')) sawZero += 1;

      // The documented integer sources, asserted exactly — sign-agnostic.
      expect(sp.economics.counterpartyRiskUSDC).toBe(wei6ToDecimalUSDC(BigInt(sp.counterparty.risk.wei6)));
      expect(sp.economics.profitUSDC).toBe(wei6ToDecimalUSDC(BigInt(sp.you.profit.wei6)));
      expect(sp.economics.returnUSDC).toBe(wei6ToDecimalUSDC(BigInt(sp.you.totalReturn.wei6)));
      expect(fee.makerCreationFeeUSDC).toBe(wei6ToDecimalUSDC(BigInt(fee.creationFee.makerShareWei6)));
    }
    // Non-vacuous: the zero cases really are reachable, which is exactly why
    // the docs must not call these fields "always positive".
    expect(sawZero).toBeGreaterThan(0);
  });

  it('the supported zero inputs really do emit "0.000000" that no parser accepts', () => {
    // buildSubmitPreview explicitly allows makerCreationFeeWei6: 0n (a
    // fee-disabled chain). Pin the emission AND the refusal.
    const zeroFee = buildSubmitPreview(
      submitArgs({ speculation: LAZY, extra: { makerCreationFeeWei6: 0n } }),
    ) as unknown as { market: { speculation: { makerCreationFeeUSDC: string } } };
    expect(zeroFee.market.speculation.makerCreationFeeUSDC).toBe('0.000000');
    expect(() =>
      usdcDecimalToAmountWei6(zeroFee.market.speculation.makerCreationFeeUSDC),
    ).toThrow(/must be positive/);

    // And profit floors to zero at the protocol's minimum odds.
    const tiny = buildSubmitPreview(
      submitArgs({ speculation: LAZY, extra: { riskWei6: 1n, oddsTick: 101 } }),
    ) as unknown as {
      economics: { profitUSDC: string; counterpartyRiskUSDC: string };
    };
    expect(tiny.economics.profitUSDC).toBe('0.000000');
    expect(tiny.economics.counterpartyRiskUSDC).toBe('0.000000');
    expect(() => usdcDecimalToAmountWei6(tiny.economics.profitUSDC)).toThrow(/must be positive/);
  });

  it('an unpaired field parses IFF it is positive — only lose rows are not', () => {
    // This is what lets the docs say "follow that field's own contract"
    // rather than "you cannot decode these". Note `payoutUSDC` is signed
    // per ROW, not per field: win/push rows are positive and do parse; the
    // lose row is the single string in either envelope with no decode path.
    const seen: Array<[string, string]> = [];
    const collect = (node: unknown, path: string): void => {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) return node.forEach((v) => collect(v, `${path}[*]`));
      if (typeof node !== 'object') return;
      const rec = node as Record<string, unknown>;
      const keys = Object.keys(rec);
      for (const k of keys) {
        const v = rec[k];
        if (typeof v === 'string' && (k.endsWith('USDC') || k === 'usdc')) {
          const twin = k === 'usdc' ? 'wei6' : `${k.slice(0, -4)}Wei6`;
          if (!keys.includes(twin)) seen.push([`${path}.${k}`, v]);
        } else collect(v, `${path}.${k}`);
      }
    };
    for (const o of all) collect(o, '$');

    let parsed = 0;
    let refused = 0;
    for (const [path, value] of seen) {
      if (value.startsWith('-')) {
        expect(path, 'only a lose row should be negative').toContain('payoutUSDC');
        expect(() => usdcDecimalToAmountWei6(value), path).toThrow(/must be positive/);
        refused += 1;
      } else {
        expect(usdcDecimalToAmountWei6(value), path).toBeGreaterThan(0n);
        parsed += 1;
      }
    }
    // Both branches must be exercised, or the claim is half-tested.
    expect(parsed).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });
});
