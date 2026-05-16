/**
 * Tests for the `ospex commitments match` command and its preview
 * renderer. Two layers:
 *
 *   1. Command structure — verify the flag surface (--risk-usdc /
 *      --yes / --approve-max / --json) and the absence of the dropped
 *      --risk wei6 flag.
 *
 *   2. Preview renderer — verify the rendered text contains the
 *      load-bearing lines (both takerRisk AND fillMakerRisk; lazy
 *      approval row; self-match warning; expires-soon and partial-fill
 *      warnings; both-perspective odds; the maker-treasury-allowance-
 *      insufficient block when applicable). Renderer output goes to
 *      stderr; full action invocation lives in the manual integration
 *      playbook.
 */

import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { commitmentsMatchCommand } from '../src/commands/commitments/match.js';
import { renderMatchPreview } from '../src/lib/matchPreviewRender.js';
import { buildMatchPreview, type Hex } from '@ospex/sdk';
import type { Commitment } from '@ospex/sdk';

const FAR_FUTURE_ISO = '2099-05-08T02:00:00Z';
const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
const TAKER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const SCORER = '0x4444444444444444444444444444444444444444' as Hex;
const HASH = '0x'.padEnd(66, 'b') as Hex;
const SPEC_KEY = '0x'.padEnd(66, 'a') as Hex;
const MM = '0x1111111111111111111111111111111111111111' as Hex;
const PM = '0x2222222222222222222222222222222222222222' as Hex;
const TM = '0x3333333333333333333333333333333333333333' as Hex;

function makeCommitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    commitmentHash: HASH,
    maker: MAKER,
    contestId: '42',
    scorer: SCORER,
    lineTicks: 0,
    positionType: 0,
    oddsTick: 250,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '17000000001',
    expiry: FAR_FUTURE_ISO,
    speculationKey: SPEC_KEY,
    signature: '0xsig',
    status: 'open',
    source: 'submit',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2026-05-09T00:00:00Z',
    ...overrides,
  };
}

function buildExisting(opts: Partial<Parameters<typeof buildMatchPreview>[0]> = {}) {
  return buildMatchPreview({
    commitment: makeCommitment(),
    chainId: 137,
    matchingModuleAddress: MM,
    taker: TAKER,
    awayTeam: 'Los Angeles Lakers',
    homeTeam: 'Denver Nuggets',
    awayTeamId: 'lakers-uuid',
    homeTeamId: 'nuggets-uuid',
    sport: 'nba',
    matchTime: FAR_FUTURE_ISO,
    speculation: { mode: 'existing', speculationId: '101' },
    speculationKey: SPEC_KEY,
    speculationCreationTotalFeeWei6: 500_000n,
    takerTreasuryAllowanceWei6: 0n,
    makerTreasuryAllowanceWei6: 500_000n,
    treasuryModuleAddress: TM,
    positionModuleAddress: PM,
    takerPositionAllowanceWei6: 0n,
    nowUnixSec: 1_700_000_000n,
    ...opts,
  });
}

function captureRender(
  preview: ReturnType<typeof buildExisting>,
  opts: { raw?: boolean } = {},
): string {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  renderMatchPreview(preview, sink, opts);
  return chunks.join('');
}

describe('commitments match — command structure', () => {
  it('accepts --risk-usdc / --yes / --approve-max / --json', () => {
    const help = commitmentsMatchCommand.helpInformation();
    expect(help).toMatch(/--risk-usdc/);
    expect(help).toMatch(/--yes/);
    expect(help).toMatch(/--approve-max/);
    expect(help).toMatch(/--json/);
  });

  it('drops --risk (raw wei6) — clean rename to --risk-usdc for parity with submit', () => {
    const help = commitmentsMatchCommand.helpInformation();
    // Look for the bare flag pattern; --risk-usdc is allowed.
    expect(help).not.toMatch(/--risk\s/);
    expect(help).not.toMatch(/--risk\b(?!-usdc)/);
  });

  it('positional accepts hash-or-prefix, not just full hash', () => {
    const help = commitmentsMatchCommand.helpInformation();
    expect(help).toMatch(/<hash-or-prefix>/);
  });

  it('--risk-usdc help text describes it as taker desired risk / max outlay', () => {
    const help = commitmentsMatchCommand.helpInformation();
    // Crucial UX disambiguation — the flag means the taker's risk,
    // NOT the maker risk to fill.
    expect(help.toLowerCase()).toMatch(/taker desired risk/);
    expect(help.toLowerCase()).toMatch(/max outlay/);
  });

  it('--json help text spells out the preview-vs-execute pairing with --yes', () => {
    const help = commitmentsMatchCommand.helpInformation();
    // --json alone = preview only; --yes --json = execute.
    expect(help).toMatch(/--json/);
    expect(help).toMatch(/preview only|preview-only|MatchPreviewEnvelope/i);
  });

  it('exposes the shared signer option group (PR 2)', () => {
    // The non-interactive Foundry signer flags should be available on
    // every write command, including match. See lib/signer-options.ts
    // and the spec §17.
    const help = commitmentsMatchCommand.helpInformation();
    expect(help).toMatch(/--account/);
    expect(help).toMatch(/--keystore-path/);
    expect(help).toMatch(/--password-file/);
    expect(help).toMatch(/--password-stdin/);
    expect(help).toMatch(/--expected-address/);
  });
});

describe('commitments match — preview renderer (--raw, existing speculation)', () => {
  it('renders BOTH takerRisk AND fillMakerRisk lines', () => {
    const preview = buildExisting();
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/taker risks:\s+\d+\.\d{6}\s+USDC/);
    expect(out).toMatch(/maker fill:\s+\d+\.\d{6}\s+USDC/);
  });

  it('renders both maker- AND taker-perspective odds', () => {
    const preview = buildExisting({
      commitment: makeCommitment({ oddsTick: 260 }),
    });
    const out = captureRender(preview, { raw: true });
    // tick 260 → maker decimal 2.60, American +160; taker decimal 1.63
    // (162.5 rounds to 163 → "1.63"), American -159.
    expect(out).toMatch(/maker 2\.60 \/ \+160/);
    expect(out).toMatch(/taker 1\.63 \/ -159/);
  });

  it('does not show a lazy approval block when speculation is existing', () => {
    const preview = buildExisting();
    const out = captureRender(preview, { raw: true });
    expect(out).not.toMatch(/lazy/i);
    expect(out).not.toMatch(/creation fee/i);
  });

  it('shows the full commitment hash on the commitment: line', () => {
    const preview = buildExisting();
    const out = captureRender(preview, { raw: true });
    expect(out).toContain(HASH);
  });

  it('shows the contest label (away @ home, date — sport)', () => {
    const preview = buildExisting();
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/Los Angeles Lakers @ Denver Nuggets/);
    expect(out).toMatch(/NBA/);
  });
});

describe('commitments match — preview renderer (--raw, lazy speculation)', () => {
  it('shows the lazy creation fee block with taker-share and maker-share', () => {
    const preview = buildExisting({
      speculation: { mode: 'lazy' },
      speculationCreationTotalFeeWei6: 500_000n,
    });
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/speculation:\s+lazy/);
    expect(out).toMatch(/creation fee:.*0\.250000 USDC taker share/);
    expect(out).toMatch(/0\.250000 USDC maker share/);
  });

  it('self-match shows the FULL fee on a single line (same wallet pays both halves)', () => {
    const preview = buildExisting({
      taker: MAKER,
      speculation: { mode: 'lazy' },
      speculationCreationTotalFeeWei6: 500_000n,
    });
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/⚠ self-match/);
    expect(out).toMatch(/creation fee:\s*\+0\.500000 USDC \(self-match/);
  });

  it('emits a maker-allowance warning when the maker treasury allowance is short', () => {
    const preview = buildExisting({
      speculation: { mode: 'lazy' },
      speculationCreationTotalFeeWei6: 500_000n,
      makerTreasuryAllowanceWei6: 0n, // < maker share
    });
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/maker's TreasuryModule allowance.*below the maker's share/);
    expect(out).toMatch(/match will revert.*taker cannot fix this/);
  });

  it('emits an Approvals required block listing the lazy-creation-fee row when needed', () => {
    const preview = buildExisting({
      speculation: { mode: 'lazy' },
      speculationCreationTotalFeeWei6: 500_000n,
      // Both taker allowances are zero by default — both rows will be
      // needsApproval: true.
    });
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/Approvals required/);
    expect(out).toMatch(/\[commitment-risk\]/);
    expect(out).toMatch(/\[lazy-creation-fee\]/);
  });
});

describe('commitments match — preview renderer (--raw, warnings)', () => {
  it('partial-fill warning when fillMakerRisk < remaining', () => {
    const preview = buildExisting({
      // 0.5 USDC of taker risk against a 1 USDC maker @ 2.50 odds
      // partially fills.
      takerDesiredRiskWei6: 500_000n,
    });
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/⚠ partial fill/);
  });

  it('expires-soon warning fires when expiry is within 5 min', () => {
    const now = 1_700_000_000n;
    const expirySec = now + 120n; // 2 min
    const expiryISO = new Date(Number(expirySec) * 1000).toISOString();
    const preview = buildExisting({
      commitment: makeCommitment({ expiry: expiryISO }),
      nowUnixSec: now,
    });
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/⚠ expires in ~2 min/);
  });

  it('expired warning fires when expiry is past now', () => {
    const preview = buildExisting({
      commitment: makeCommitment({ expiry: '2020-01-01T00:00:00Z' }),
      nowUnixSec: 1_700_000_000n,
    });
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/⚠ commitment is past expiry/);
  });

  it('nonce-invalidated warning fires when commitment.nonceInvalidated is true', () => {
    const preview = buildExisting({
      commitment: makeCommitment({ nonceInvalidated: true, isLive: false }),
    });
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/⚠ commitment's nonce is invalidated/);
  });
});

describe('commitments match — --raw self-match wallet stake clarifier', () => {
  it('self-match: shows wallet stake = takerRisk + fillMakerRisk', () => {
    const preview = buildExisting({ taker: MAKER });
    expect(preview.selfMatch).toBe(true);
    const out = captureRender(preview, { raw: true });
    // baseArgs default at oddsTick 250 → fillMakerRisk 1.0, takerRisk 1.5.
    // Sum = 2.5 USDC.
    expect(out).toMatch(
      /⚠ self-match wallet stake: 2\.500000 USDC \(maker fill \+ taker risk paid by the same wallet\)/,
    );
  });

  it('non-self-match: does not show the wallet-stake clarifier', () => {
    const preview = buildExisting();
    expect(preview.selfMatch).toBe(false);
    const out = captureRender(preview, { raw: true });
    expect(out).not.toMatch(/self-match wallet stake/);
  });
});

describe('commitments match — --raw spread / total line displays', () => {
  it('spread shows BOTH maker and taker line perspectives', () => {
    const preview = buildExisting({
      commitment: makeCommitment({
        marketType: 'spread',
        lineTicks: -35, // away favored 3.5
        positionType: 0, // maker on away
      }),
    });
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/maker Los Angeles Lakers -3\.5/);
    expect(out).toMatch(/taker Denver Nuggets \+3\.5/);
  });

  it('total: maker over → taker under, magnitudes preserved', () => {
    const preview = buildExisting({
      commitment: makeCommitment({
        marketType: 'total',
        lineTicks: 85,
        positionType: 0,
      }),
    });
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/maker Over 8\.5/);
    expect(out).toMatch(/taker Under 8\.5/);
  });
});

// ── Default (first-person) layout ─────────────────────────────────────
//
// The new default render — proven against Hermes's review item #3
// (`request.md`): maker/taker leakage and Upper/Lower terminology are
// hidden; the executing party always reads as "You" and the maker
// becomes "Counterparty". `--raw` (above) preserves the protocol-native
// dual layout for debugging.

describe('commitments match — default first-person renderer', () => {
  it('hides protocol-native terminology (no maker side / taker side / Upper / Lower)', () => {
    const preview = buildExisting();
    const out = captureRender(preview);
    expect(out).not.toMatch(/maker side:/);
    expect(out).not.toMatch(/taker side:/);
    expect(out).not.toMatch(/positionType=Upper/);
    expect(out).not.toMatch(/positionType=Lower/);
    expect(out).not.toMatch(/oddsTick=/);
  });

  it('renders "You back: <team> at <american>" and "Counterparty: <team> at <american>"', () => {
    // Maker on away (Lakers) at +150 (tick 250, decimal 2.50). Taker
    // (you) backs home (Nuggets) at inverted -149 (tick 167, decimal
    // 1.67) — the 2dp tick precision is why "-149" rather than the
    // symmetric-looking "-150".
    const preview = buildExisting();
    const out = captureRender(preview);
    expect(out).toMatch(/You back:\s+Denver Nuggets at -149/);
    expect(out).toMatch(/Counterparty:\s+Los Angeles Lakers at \+150/);
  });

  it('includes the maker address suffix on the Counterparty line', () => {
    const preview = buildExisting();
    const out = captureRender(preview);
    expect(out).toMatch(/maker 0xaaaa…aaaa/);
  });

  it('frames risk + profit in first person with the win condition', () => {
    const preview = buildExisting();
    const out = captureRender(preview);
    // baseArgs default: tick 250 → fillMaker 1.0, taker risk 1.5, profit 1.0.
    expect(out).toMatch(/Your risk:\s+1\.500000 USDC/);
    expect(out).toMatch(/Your profit:\s+\+1\.000000 USDC\s+if Denver Nuggets wins/);
  });

  it('annotates full fill vs partial fill on the Maker fill line', () => {
    const full = captureRender(buildExisting());
    expect(full).toMatch(/Maker fill:\s+1\.000000 USDC of 1\.000000 USDC remaining\s+\(full fill\)/);

    const partial = captureRender(
      buildExisting({ takerDesiredRiskWei6: 500_000n }),
    );
    expect(partial).toMatch(/\(partial fill\)/);
    expect(partial).toMatch(/leaves capacity on the maker commitment/);
  });

  it('renders Outcomes block from the taker perspective', () => {
    const preview = buildExisting();
    const out = captureRender(preview);
    expect(out).toMatch(/Outcomes:/);
    expect(out).toMatch(/Denver Nuggets wins → you win 1\.000000 USDC/);
    expect(out).toMatch(/Los Angeles Lakers wins → you lose 1\.500000 USDC/);
  });

  it('renders approval rows in USDC (not raw wei6) with a module label', () => {
    const preview = buildExisting();
    const out = captureRender(preview);
    // commitment-risk row should show "current 0.000000 USDC, need 1.500000 USDC".
    expect(out).toMatch(
      /USDC → 0x2222…2222 \(PositionModule\)\s+current 0\.000000 USDC, need 1\.500000 USDC\s+\[commitment-risk\]/,
    );
    expect(out).not.toMatch(/current 0\s+,/); // no bare wei6 forms
  });

  it('still shows the full commitment hash (debug pointer)', () => {
    const preview = buildExisting();
    const out = captureRender(preview);
    expect(out).toContain(HASH);
  });

  it('still surfaces the contest label and market header', () => {
    const preview = buildExisting();
    const out = captureRender(preview);
    expect(out).toMatch(/Los Angeles Lakers @ Denver Nuggets/);
    expect(out).toMatch(/market:\s+moneyline/);
  });
});

describe('commitments match — default renderer (warnings)', () => {
  it('expired warning fires (cross-layout invariant)', () => {
    const preview = buildExisting({
      commitment: makeCommitment({ expiry: '2020-01-01T00:00:00Z' }),
      nowUnixSec: 1_700_000_000n,
    });
    const out = captureRender(preview);
    expect(out).toMatch(/⚠ commitment is past expiry/);
  });

  it('expires-soon warning fires (cross-layout invariant)', () => {
    const now = 1_700_000_000n;
    const expirySec = now + 120n;
    const expiryISO = new Date(Number(expirySec) * 1000).toISOString();
    const preview = buildExisting({
      commitment: makeCommitment({ expiry: expiryISO }),
      nowUnixSec: now,
    });
    const out = captureRender(preview);
    expect(out).toMatch(/⚠ expires in ~2 min/);
  });

  it('nonce-invalidated warning fires (cross-layout invariant)', () => {
    const preview = buildExisting({
      commitment: makeCommitment({ nonceInvalidated: true, isLive: false }),
    });
    const out = captureRender(preview);
    expect(out).toMatch(/⚠ commitment's nonce is invalidated/);
  });
});

describe('commitments match — default renderer (self-match)', () => {
  it("self-match renders the dual-stake block with 'Position stake from your wallet'", () => {
    const preview = buildExisting({ taker: MAKER });
    const out = captureRender(preview);
    expect(out).toMatch(/⚠ Self-match: you are on both sides of this commitment/);
    expect(out).toMatch(/Maker side \(you\):.*Los Angeles Lakers at \+150/);
    // Taker side shows the inverted American — see tick-precision note
    // on the non-self-match "You back" test above.
    expect(out).toMatch(/Taker side \(you\):.*Denver Nuggets at -149/);
    expect(out).toMatch(/Position stake from your wallet:\s+2\.500000 USDC/);
  });

  it('self-match drops the "You back / Counterparty" lines (replaced by dual-stake)', () => {
    const preview = buildExisting({ taker: MAKER });
    const out = captureRender(preview);
    expect(out).not.toMatch(/You back:/);
    expect(out).not.toMatch(/Counterparty:/);
  });
});

describe('commitments match — default renderer (lazy speculation)', () => {
  it('shows "Creation fee exposure: +X via TreasuryModule" (separate from position stake)', () => {
    const preview = buildExisting({
      speculation: { mode: 'lazy' },
      speculationCreationTotalFeeWei6: 500_000n,
    });
    const out = captureRender(preview);
    expect(out).toMatch(
      /Creation fee exposure:\s*\+0\.250000 USDC via TreasuryModule\s+\(your share if this match triggers creation\)/,
    );
  });

  it('self-match + lazy shows the full fee with self-match annotation', () => {
    const preview = buildExisting({
      taker: MAKER,
      speculation: { mode: 'lazy' },
      speculationCreationTotalFeeWei6: 500_000n,
    });
    const out = captureRender(preview);
    expect(out).toMatch(
      /Creation fee exposure:\s*\+0\.500000 USDC via TreasuryModule\s+\(self-match:/,
    );
  });

  it('maker-allowance warning still fires (cross-layout invariant)', () => {
    const preview = buildExisting({
      speculation: { mode: 'lazy' },
      speculationCreationTotalFeeWei6: 500_000n,
      makerTreasuryAllowanceWei6: 0n,
    });
    const out = captureRender(preview);
    expect(out).toMatch(/maker's TreasuryModule allowance.*below the maker's share/);
  });
});

describe('commitments match — default renderer (spread / total)', () => {
  it("spread: 'You back: <team> -3.5'; 'Counterparty: <team> +3.5'", () => {
    const preview = buildExisting({
      commitment: makeCommitment({
        marketType: 'spread',
        lineTicks: -35,
        positionType: 0,
      }),
    });
    const out = captureRender(preview);
    // Maker on away -3.5 → taker (you) on home +3.5.
    expect(out).toMatch(/You back:\s+Denver Nuggets \+3\.5/);
    expect(out).toMatch(/Counterparty:\s+Los Angeles Lakers -3\.5/);
  });

  it("total: 'You back: Under N' when maker is over", () => {
    const preview = buildExisting({
      commitment: makeCommitment({
        marketType: 'total',
        lineTicks: 85,
        positionType: 0,
      }),
    });
    const out = captureRender(preview);
    expect(out).toMatch(/You back:\s+Under 8\.5/);
    expect(out).toMatch(/Counterparty:\s+Over 8\.5/);
  });
});

describe('commitments match — --raw flag wiring', () => {
  it('command help mentions --raw and its scope', () => {
    const help = commitmentsMatchCommand.helpInformation();
    expect(help).toMatch(/--raw/);
    expect(help.toLowerCase()).toMatch(/protocol-native|protocol-level|debug/);
  });
});
