/**
 * Tests for the `ospex approvals setup` planner, parsers, and renderer.
 * Covers:
 *
 *   - parseUsdcInput strict parsing rules, incl. the explicit-zero refusal
 *   - buildSetupPlan dimension orthogonality, skip-already-approved,
 *     skip-not-requested, max handling, no-op detection
 *   - renderSetupPlan / setupPlanToJson output shapes
 *
 * (R5/CRE: USDC is the only approval token — the LINK / OracleModule
 * dimension was retired with the Functions oracle, so the planner now
 * has two dimensions: PositionModule (risk) + TreasuryModule (fees).)
 *
 * The CLI command itself is exercised end-to-end via the manual
 * smoke test (real Polygon mainnet read).
 */

import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { maxUint256 } from 'viem';
import { OspexValidationError, type ApprovalsSnapshot } from '@ospex/sdk';
import {
  buildSetupPlan,
  parseUsdcInput,
} from '../src/lib/approvalsPlan.js';
import {
  buildSetupPreviewEnvelope,
  buildSetupResultEnvelope,
  renderSetupPlan,
  setupPlanToJson,
} from '../src/lib/approvalsRender.js';

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
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

function makeSnapshot(overrides: {
  positionModule?: bigint;
  treasuryModule?: bigint;
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
  };
}

describe('parseUsdcInput', () => {
  it('parses decimal USDC into wei6 bigint', () => {
    expect(parseUsdcInput('5')).toEqual({ kind: 'amount', raw: 5_000_000n });
    expect(parseUsdcInput('0.25')).toEqual({ kind: 'amount', raw: 250_000n });
    expect(parseUsdcInput('50.000001')).toEqual({ kind: 'amount', raw: 50_000_001n });
  });

  it('parses "max" as max-uint sentinel', () => {
    expect(parseUsdcInput('max')).toEqual({ kind: 'max' });
  });

  it('returns skip for undefined, empty string, and "skip"', () => {
    expect(parseUsdcInput(undefined)).toEqual({ kind: 'skip' });
    expect(parseUsdcInput('')).toEqual({ kind: 'skip' });
    expect(parseUsdcInput(' ')).toEqual({ kind: 'skip' });
    expect(parseUsdcInput('skip')).toEqual({ kind: 'skip' });
  });

  it('REFUSES an explicit zero rather than collapsing it into skip', () => {
    // The regression this command shipped with: an explicit 0 parsed to
    // `skip`, so `--risk-usdc 0 --fee-usdc 0 --yes --json` returned a
    // green zero-send envelope while both allowances stayed live.
    for (const zero of ['0', '0.0', '0.000000', ' 0 ']) {
      expect(() => parseUsdcInput(zero)).toThrow(OspexValidationError);
      expect(() => parseUsdcInput(zero)).toThrow(/is not a revocation/);
    }
  });

  it('names the originating flag in the refusal when one is supplied', () => {
    expect(() => parseUsdcInput('0', '--fee-usdc')).toThrow(/`--fee-usdc 0` is not a revocation/);
    expect(() => parseUsdcInput('0', '--fee-usdc')).toThrow(/omit --fee-usdc \(or pass "skip"\)/);
  });

  it('tells an interactive caller to answer "skip", not to omit a flag', () => {
    expect(() => parseUsdcInput('0')).toThrow(/answer "skip"/);
    expect(() => parseUsdcInput('0')).not.toThrow(/omit --/);
  });

  it('points the refusal at both real revocation surfaces', () => {
    // PositionModule has a CLI revoke; TreasuryModule does not, so the
    // message must not imply `approvals setup` can do either.
    expect(() => parseUsdcInput('0')).toThrow(/ospex commitments approve 0/);
    expect(() => parseUsdcInput('0')).toThrow(/approve\(TreasuryModule, 0\)/);
  });

  it('throws typed OspexValidationError (not a bare Error) on bad shape', () => {
    expect(() => parseUsdcInput('nope')).toThrow(OspexValidationError);
  });

  it('rejects negatives, exponents, commas, more than 6 decimals', () => {
    expect(() => parseUsdcInput('-5')).toThrow();
    expect(() => parseUsdcInput('1e3')).toThrow();
    expect(() => parseUsdcInput('5,000')).toThrow();
    expect(() => parseUsdcInput('+5')).toThrow();
    expect(() => parseUsdcInput('5.1234567')).toThrow();
    expect(() => parseUsdcInput('NaN')).toThrow();
    expect(() => parseUsdcInput('Infinity')).toThrow();
  });
});

describe('buildSetupPlan — the two dimensions are orthogonal', () => {
  it('--risk-usdc alone touches PositionModule ONLY (no implied fee approval)', () => {
    const plan = buildSetupPlan({ riskUsdc: '50' }, makeSnapshot());
    expect(plan.willSendCount).toBe(1);
    const position = plan.items.find((i) => i.spenderModule === 'positionModule')!;
    const treasury = plan.items.find((i) => i.spenderModule === 'treasuryModule')!;
    expect(position.action.kind).toBe('send');
    expect(treasury.action.kind).toBe('skip-not-requested');
  });

  it('--fee-usdc alone touches TreasuryModule ONLY', () => {
    const plan = buildSetupPlan({ feeUsdc: '5' }, makeSnapshot());
    expect(plan.willSendCount).toBe(1);
    const position = plan.items.find((i) => i.spenderModule === 'positionModule')!;
    const treasury = plan.items.find((i) => i.spenderModule === 'treasuryModule')!;
    expect(position.action.kind).toBe('skip-not-requested');
    expect(treasury.action.kind).toBe('send');
  });

  it('an omitted dimension never sends, regardless of the other dimension', () => {
    // Cross-dimension defaulting is exactly what was removed: no input
    // to one flag can ever produce a send on the other spender.
    for (const input of [{ riskUsdc: 'max' }, { riskUsdc: '0.000001' }, {}]) {
      const treasury = buildSetupPlan(input, makeSnapshot()).items.find(
        (i) => i.spenderModule === 'treasuryModule',
      )!;
      expect(treasury.action.kind).toBe('skip-not-requested');
    }
  });

  it('refuses an explicit zero on either dimension instead of planning a no-op', () => {
    expect(() => buildSetupPlan({ riskUsdc: '0' }, makeSnapshot())).toThrow(
      OspexValidationError,
    );
    expect(() => buildSetupPlan({ feeUsdc: '0' }, makeSnapshot())).toThrow(
      OspexValidationError,
    );
    // The reported repro: both explicit zeros, against live allowances.
    expect(() =>
      buildSetupPlan(
        { riskUsdc: '0', feeUsdc: '0' },
        makeSnapshot({ positionModule: 100_000_000n, treasuryModule: 5_000_000n }),
      ),
    ).toThrow(/is not a revocation/);
  });
});

describe('buildSetupPlan — skip-already-approved', () => {
  it('skips Position when current >= requested', () => {
    const plan = buildSetupPlan(
      { riskUsdc: '50' },
      makeSnapshot({ positionModule: 100_000_000n }),
    );
    const position = plan.items.find((i) => i.spenderModule === 'positionModule')!;
    expect(position.action.kind).toBe('skip-already-approved');
  });

  it('skips fee when current >= requested', () => {
    const plan = buildSetupPlan(
      { riskUsdc: '50', feeUsdc: '1' },
      makeSnapshot({ treasuryModule: 5_000_000n }),
    );
    const treasury = plan.items.find((i) => i.spenderModule === 'treasuryModule')!;
    expect(treasury.action.kind).toBe('skip-already-approved');
  });

  it('distinguishes skip-already-approved from skip-not-requested', () => {
    // Both render as "Skip" but mean different things: one was asked for
    // and is already covered, the other was never asked for at all.
    const plan = buildSetupPlan(
      { riskUsdc: '50' },
      makeSnapshot({ positionModule: 100_000_000n, treasuryModule: 5_000_000n }),
    );
    expect(plan.items.find((i) => i.spenderModule === 'positionModule')!.action.kind).toBe(
      'skip-already-approved',
    );
    expect(plan.items.find((i) => i.spenderModule === 'treasuryModule')!.action.kind).toBe(
      'skip-not-requested',
    );
    expect(plan.willSendCount).toBe(0);
  });

  it('detects no-op when nothing needs to send', () => {
    const plan = buildSetupPlan(
      { riskUsdc: '50', feeUsdc: '5' },
      makeSnapshot({ positionModule: 100_000_000n, treasuryModule: 10_000_000n }),
    );
    expect(plan.willSendCount).toBe(0);
  });
});

describe('buildSetupPlan — max handling', () => {
  it('translates "max" to maxUint256 send', () => {
    const plan = buildSetupPlan({ riskUsdc: 'max' }, makeSnapshot());
    const position = plan.items.find((i) => i.spenderModule === 'positionModule')!;
    expect(position.action.kind).toBe('send');
    if (position.action.kind === 'send') {
      expect(position.action.targetRaw).toBe(maxUint256);
      expect(position.action.targetIsMax).toBe(true);
    }
  });

  it('skip-already-approved if current is already max', () => {
    const plan = buildSetupPlan(
      { riskUsdc: 'max' },
      makeSnapshot({ positionModule: maxUint256 }),
    );
    const position = plan.items.find((i) => i.spenderModule === 'positionModule')!;
    expect(position.action.kind).toBe('skip-already-approved');
  });
});

describe('buildSetupPlan — two-dimension flag mode', () => {
  it('handles both dimensions explicitly', () => {
    const plan = buildSetupPlan(
      { riskUsdc: '50', feeUsdc: '5' },
      makeSnapshot(),
    );
    expect(plan.willSendCount).toBe(2);
    expect(plan.items[0]!.spenderModule).toBe('positionModule');
    expect(plan.items[1]!.spenderModule).toBe('treasuryModule');
  });

  it('orders items consistently (position, treasury)', () => {
    const plan = buildSetupPlan({ feeUsdc: '5' }, makeSnapshot());
    expect(plan.items.map((i) => i.spenderModule)).toEqual([
      'positionModule',
      'treasuryModule',
    ]);
  });

  it('preserves the snapshot owner + chainId on the plan', () => {
    const snapshot = makeSnapshot();
    const plan = buildSetupPlan({ riskUsdc: '50' }, snapshot);
    expect(plan.owner).toBe(snapshot.owner);
    expect(plan.chainId).toBe(snapshot.chainId);
  });
});

describe('renderSetupPlan', () => {
  it('renders Send / Skip lines and module labels', () => {
    const sink = new StringSink();
    // risk send + fee omitted → one Send, one Skip.
    const plan = buildSetupPlan({ riskUsdc: '50' }, makeSnapshot());
    renderSetupPlan(plan, sink);
    expect(sink.buf).toContain('Approval setup plan for ');
    expect(sink.buf).toContain('Polygon mainnet');
    expect(sink.buf).toContain('PositionModule');
    expect(sink.buf).toContain('TreasuryModule');
    expect(sink.buf).toContain('Send');
    expect(sink.buf).toContain('Skip');
    expect(sink.buf).toContain('50.000000 USDC');
  });

  it('never advertises an auto-include or a zero opt-out', () => {
    // Negative control for the removed behaviour: the renderer used to
    // print "(auto-included alongside --risk-usdc; pass --fee-usdc 0 to
    // skip)", which is the idiom that taught operators `0` means skip.
    const sink = new StringSink();
    renderSetupPlan(buildSetupPlan({ riskUsdc: '50' }, makeSnapshot()), sink);
    expect(sink.buf).not.toContain('auto-included');
    expect(sink.buf).not.toContain('--fee-usdc 0');
  });

  it('renders the "no-op" message when no items send', () => {
    const sink = new StringSink();
    const plan = buildSetupPlan(
      { riskUsdc: '50', feeUsdc: '5' },
      makeSnapshot({ positionModule: 100_000_000n, treasuryModule: 10_000_000n }),
    );
    renderSetupPlan(plan, sink);
    expect(sink.buf).toContain('Nothing to do');
  });

  it('renders unlimited (max) instead of a 78-digit number', () => {
    const sink = new StringSink();
    const plan = buildSetupPlan({ riskUsdc: 'max' }, makeSnapshot());
    renderSetupPlan(plan, sink);
    expect(sink.buf).toContain('unlimited (max) USDC');
    expect(sink.buf).not.toMatch(/[0-9]{30,}/);
  });

  it('shows max USDC exposure when there is at least one send', () => {
    const sink = new StringSink();
    const plan = buildSetupPlan({ riskUsdc: '50', feeUsdc: '5' }, makeSnapshot());
    renderSetupPlan(plan, sink);
    expect(sink.buf).toContain('Max USDC exposure');
    expect(sink.buf).toContain('55.000000 USDC');
  });

  it('renders skip-already-approved with the current value', () => {
    const sink = new StringSink();
    const plan = buildSetupPlan(
      { riskUsdc: '50' },
      makeSnapshot({ positionModule: 100_000_000n }),
    );
    renderSetupPlan(plan, sink);
    expect(sink.buf).toContain('already at 100.000000 USDC');
  });
});

describe('setupPlanToJson', () => {
  it('serialises bigints to decimal strings + formatted human-readable companions', () => {
    const plan = buildSetupPlan({ riskUsdc: '50', feeUsdc: '5' }, makeSnapshot());
    const json = setupPlanToJson(plan);
    expect(json.willSendCount).toBe(2);
    const position = json.items.find((i) => i.spenderModule === 'positionModule')!;
    expect(position.action.kind).toBe('send');
    if (position.action.kind === 'send') {
      expect(position.action.targetRaw).toBe('50000000');
      expect(position.action.targetFormatted).toBe('50');
      expect(position.action.targetIsMax).toBe(false);
    }
  });

  it('marks a max approval with targetIsMax=true', () => {
    const plan = buildSetupPlan({ riskUsdc: 'max' }, makeSnapshot());
    const json = setupPlanToJson(plan);
    const position = json.items.find((i) => i.spenderModule === 'positionModule')!;
    if (position.action.kind === 'send') {
      expect(position.action.targetIsMax).toBe(true);
    } else {
      throw new Error('expected send action for max approval');
    }
  });

  it('round-trips through JSON.stringify with no BigInt errors', () => {
    const plan = buildSetupPlan({ riskUsdc: 'max' }, makeSnapshot());
    const json = setupPlanToJson(plan);
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it('includes the spenderModule name on every item', () => {
    const plan = buildSetupPlan({}, makeSnapshot());
    const json = setupPlanToJson(plan);
    expect(json.items.map((i) => i.spenderModule).sort()).toEqual([
      'positionModule',
      'treasuryModule',
    ]);
  });
});

describe('setup envelope shape', () => {
  // Regression: the JSON contract for `--json` (preview) and
  // `--yes --json` (executed) must be { schemaVersion, plan, [results] }
  // — schemaVersion at the envelope level, NOT inside the plan body.
  it('preview envelope shape: { schemaVersion: 1, plan: {...} }', () => {
    const plan = buildSetupPlan({ riskUsdc: '50', feeUsdc: '5' }, makeSnapshot());
    const env = buildSetupPreviewEnvelope(plan);
    expect(env.schemaVersion).toBe(1);
    expect(env.plan).toBeDefined();
    expect(env.plan.willSendCount).toBe(2);
    expect((env.plan as unknown as Record<string, unknown>).schemaVersion).toBeUndefined();
    expect((env as unknown as Record<string, unknown>).results).toBeUndefined();
  });

  it('result envelope shape: { schemaVersion: 1, plan: {...}, results: [...] }', () => {
    const plan = buildSetupPlan({ riskUsdc: '50', feeUsdc: '5' }, makeSnapshot());
    const env = buildSetupResultEnvelope(plan, [
      {
        spenderModule: 'positionModule',
        txHash: '0xtx',
        blockNumber: '12345',
        status: 'success',
      },
    ]);
    expect(env.schemaVersion).toBe(1);
    expect(env.plan.willSendCount).toBe(2);
    expect(env.results).toHaveLength(1);
    expect(env.results[0]!.spenderModule).toBe('positionModule');
    expect((env.plan as unknown as Record<string, unknown>).schemaVersion).toBeUndefined();
  });

  it('result envelope tolerates an empty results array (idempotent re-run)', () => {
    const plan = buildSetupPlan(
      { riskUsdc: '50', feeUsdc: '5' },
      makeSnapshot({ positionModule: 100_000_000n, treasuryModule: 10_000_000n }),
    );
    const env = buildSetupResultEnvelope(plan, []);
    expect(env.schemaVersion).toBe(1);
    expect(env.plan.willSendCount).toBe(0);
    expect(env.results).toEqual([]);
  });

  it('round-trips both envelopes through JSON.stringify', () => {
    const plan = buildSetupPlan({ riskUsdc: 'max' }, makeSnapshot());
    expect(() => JSON.stringify(buildSetupPreviewEnvelope(plan))).not.toThrow();
    expect(() =>
      JSON.stringify(
        buildSetupResultEnvelope(plan, [
          { spenderModule: 'positionModule', txHash: '0xab', blockNumber: '1', status: 'success' },
        ]),
      ),
    ).not.toThrow();
  });
});
