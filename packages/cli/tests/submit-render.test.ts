/**
 * Tests for the `commitments submit` preview renderer
 * (`packages/cli/src/lib/previewRender.ts`). Focused on the PR E
 * cleanup: default mode hides the `positionType=Upper/Lower` debug
 * tag; `--raw` restores it. The renderer's other content (outcomes,
 * approvals, lazy speculation block) is exercised against the
 * structured `SubmitPreview` from the SDK suite.
 */

import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { commitmentsSubmitCommand } from '../src/commands/commitments/submit.js';
import { renderPreview } from '../src/lib/previewRender.js';
import {
  buildSubmitPreview,
  type BuildSubmitPreviewArgs,
  type Hex,
} from '@ospex/sdk';

const MAKER = '0x'.padEnd(42, '0') as Hex;
const MM = '0x'.padEnd(42, '1') as Hex;
const PM = '0x'.padEnd(42, '2') as Hex;
const SCORER = '0x'.padEnd(42, '3') as Hex;

const baseArgs = (
  overrides: Partial<BuildSubmitPreviewArgs> = {},
): BuildSubmitPreviewArgs => ({
  contestId: 42n,
  awayTeam: 'Los Angeles Lakers',
  homeTeam: 'Denver Nuggets',
  awayTeamId: 'lakers-uuid',
  homeTeamId: 'nuggets-uuid',
  sport: 'nba',
  matchTime: '2099-05-08T02:00:00Z',
  market: 'moneyline',
  scorer: SCORER,
  lineTicks: 0,
  speculation: { mode: 'existing', speculationId: '101' },
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
  expirySec: 4_081_888_800n,
  expirySource: 'default-match-time',
  matchTimeSec: 4_081_888_800n,
  makerCreationFeeWei6: 0n,
  treasuryModuleAddress: '0x'.padEnd(42, '4') as Hex,
  treasuryUsdcCurrentAllowanceWei6: 0n,
  nonce: 17_000_000_001n,
  positionModuleAddress: PM,
  usdcCurrentAllowanceWei6: 0n,
  ...overrides,
});

function captureRender(
  preview: ReturnType<typeof buildSubmitPreview>,
  opts: { raw?: boolean } = {},
): string {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  renderPreview(preview, sink, opts);
  return chunks.join('');
}

describe('commitments submit — default render', () => {
  it('drops positionType=Upper/Lower from the [sideTags] bracket', () => {
    const preview = buildSubmitPreview(baseArgs());
    const out = captureRender(preview);
    expect(out).not.toMatch(/positionType=Upper/);
    expect(out).not.toMatch(/positionType=Lower/);
  });

  it("preserves the scorer + source tags (they're informational, not protocol-leakage)", () => {
    const preview = buildSubmitPreview(baseArgs());
    const out = captureRender(preview);
    expect(out).toMatch(/scorer=0x3333/);
    expect(out).toMatch(/source=exact/);
  });

  it('still renders the side line itself (label + role)', () => {
    const preview = buildSubmitPreview(baseArgs());
    const out = captureRender(preview);
    expect(out).toMatch(/side:\s+Los Angeles Lakers \(away\)/);
  });

  it('still renders Outcomes block (you win / you lose / push)', () => {
    const preview = buildSubmitPreview(baseArgs());
    const out = captureRender(preview);
    expect(out).toMatch(/Outcomes:/);
    expect(out).toMatch(/Los Angeles Lakers wins → you win 1\.500000 USDC/);
  });
});

describe('commitments submit — --raw render', () => {
  it('restores the positionType=Upper tag for an Upper side', () => {
    const preview = buildSubmitPreview(baseArgs());
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/positionType=Upper/);
  });

  it('shows positionType=Lower when the maker is on the lower side', () => {
    const preview = buildSubmitPreview(
      baseArgs({
        resolvedSide: {
          positionType: 1,
          resolvedLabel: 'Denver Nuggets',
          role: 'home',
          resolutionSource: 'exact',
        },
      }),
    );
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/positionType=Lower/);
  });

  it('keeps scorer + source tags alongside positionType', () => {
    const preview = buildSubmitPreview(baseArgs());
    const out = captureRender(preview, { raw: true });
    expect(out).toMatch(/\[positionType=Upper, scorer=0x3333.*, source=exact\]/);
  });
});

describe('commitments submit — --raw flag wiring', () => {
  it('command help mentions --raw and its scope', () => {
    const help = commitmentsSubmitCommand.helpInformation();
    expect(help).toMatch(/--raw/);
    expect(help.toLowerCase()).toMatch(/protocol-native|positionType|debug/);
  });
});
