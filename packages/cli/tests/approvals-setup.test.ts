/**
 * Tests for the `ospex approvals setup` planner, parsers, and renderer.
 * Covers:
 *
 *   - parseUsdcInput / parseLinkInput strict parsing rules
 *   - buildSetupPlan auto-include rule, skip-already-approved,
 *     skip-not-requested, max handling, no-op detection
 *   - renderSetupPlan / setupPlanToJson output shapes
 *
 * The CLI command itself is exercised end-to-end via the manual
 * smoke test (real Polygon mainnet read).
 */

import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { maxUint256 } from 'viem';
import type { ApprovalsSnapshot } from '@ospex/sdk';
import {
  buildSetupPlan,
  parseLinkInput,
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
const ORACLE_MODULE = '0x7e1397eD5b4c9f606DCF2EB0281485B2296E29Bb';
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const LINK = '0xb0897686c545045aFc77CF20eC7A532E3120E0F1';

function makeSnapshot(overrides: {
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

describe('parseUsdcInput', () => {
  it('parses decimal USDC into wei6 bigint', () => {
    expect(parseUsdcInput('5')).toEqual({ kind: 'amount', raw: 5_000_000n });
    expect(parseUsdcInput('0.25')).toEqual({ kind: 'amount', raw: 250_000n });
    expect(parseUsdcInput('50.000001')).toEqual({ kind: 'amount', raw: 50_000_001n });
  });

  it('parses "max" as max-uint sentinel', () => {
    expect(parseUsdcInput('max')).toEqual({ kind: 'max' });
  });

  it('returns skip for undefined, empty string, "skip", and "0"', () => {
    expect(parseUsdcInput(undefined)).toEqual({ kind: 'skip' });
    expect(parseUsdcInput('')).toEqual({ kind: 'skip' });
    expect(parseUsdcInput(' ')).toEqual({ kind: 'skip' });
    expect(parseUsdcInput('skip')).toEqual({ kind: 'skip' });
    expect(parseUsdcInput('0')).toEqual({ kind: 'skip' });
    expect(parseUsdcInput('0.0')).toEqual({ kind: 'skip' });
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

describe('parseLinkInput', () => {
  it('parses LINK at 18 decimals', () => {
    expect(parseLinkInput('2')).toEqual({ kind: 'amount', raw: 2n * 10n ** 18n });
    expect(parseLinkInput('0.5')).toEqual({ kind: 'amount', raw: 5n * 10n ** 17n });
  });

  it('rejects > 18 decimals', () => {
    expect(() => parseLinkInput('0.' + '0'.repeat(18) + '1')).toThrow();
  });
});

describe('buildSetupPlan — auto-include rule', () => {
  it('auto-includes a 1 USDC fee budget when --risk-usdc is set alone', () => {
    const plan = buildSetupPlan({ riskUsdc: '50' }, makeSnapshot());
    expect(plan.willSendCount).toBe(2);
    const treasury = plan.items.find((i) => i.spenderModule === 'treasuryModule')!;
    expect(treasury.action.kind).toBe('send');
    if (treasury.action.kind === 'send') {
      expect(treasury.action.targetRaw).toBe(1_000_000n);
    }
    expect(treasury.autoIncluded).toBe(true);
  });

  it('does NOT auto-include when --fee-usdc is explicitly "0"', () => {
    const plan = buildSetupPlan({ riskUsdc: '50', feeUsdc: '0' }, makeSnapshot());
    expect(plan.willSendCount).toBe(1);
    const treasury = plan.items.find((i) => i.spenderModule === 'treasuryModule')!;
    expect(treasury.action.kind).toBe('skip-not-requested');
    expect(treasury.autoIncluded).toBe(false);
  });

  it('does NOT auto-include when only --fee-usdc / --link is set (no risk)', () => {
    const planFee = buildSetupPlan({ feeUsdc: '5' }, makeSnapshot());
    expect(planFee.items.find((i) => i.spenderModule === 'treasuryModule')!.autoIncluded).toBe(false);

    const planLink = buildSetupPlan({ link: '2' }, makeSnapshot());
    expect(planLink.items.find((i) => i.spenderModule === 'treasuryModule')!.autoIncluded).toBe(false);
    expect(planLink.items.find((i) => i.spenderModule === 'treasuryModule')!.action.kind).toBe(
      'skip-not-requested',
    );
  });

  // Regression: the auto-include rule must NOT trigger when --link is
  // set (the casual-bettor exemption applies only when riskUsdc is the
  // ONLY dimension). A user passing --risk-usdc + --link is in
  // operator territory and should be explicit about every dimension —
  // surprise USDC approvals next to a contest-creation setup is a
  // financial-UX bug.
  it('does NOT auto-include fee when --risk-usdc + --link are set together', () => {
    const plan = buildSetupPlan({ riskUsdc: '50', link: '2' }, makeSnapshot());
    const treasury = plan.items.find((i) => i.spenderModule === 'treasuryModule')!;
    expect(treasury.action.kind).toBe('skip-not-requested');
    expect(treasury.autoIncluded).toBe(false);
    // Sanity: the two dimensions the user DID set are still send.
    const position = plan.items.find((i) => i.spenderModule === 'positionModule')!;
    const oracle = plan.items.find((i) => i.spenderModule === 'oracleModule')!;
    expect(position.action.kind).toBe('send');
    expect(oracle.action.kind).toBe('send');
    expect(plan.willSendCount).toBe(2);
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

  it('still auto-includes fee even if Position already covered', () => {
    const plan = buildSetupPlan(
      { riskUsdc: '50' },
      makeSnapshot({ positionModule: 100_000_000n }),
    );
    const treasury = plan.items.find((i) => i.spenderModule === 'treasuryModule')!;
    expect(treasury.autoIncluded).toBe(true);
    expect(treasury.action.kind).toBe('send');
  });

  it('skips fee when current >= auto-included target', () => {
    const plan = buildSetupPlan(
      { riskUsdc: '50' },
      makeSnapshot({ treasuryModule: 5_000_000n }),
    );
    const treasury = plan.items.find((i) => i.spenderModule === 'treasuryModule')!;
    expect(treasury.action.kind).toBe('skip-already-approved');
    expect(treasury.autoIncluded).toBe(true);
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

describe('buildSetupPlan — three-dimension flag mode', () => {
  it('handles all three dimensions explicitly', () => {
    const plan = buildSetupPlan(
      { riskUsdc: '50', feeUsdc: '5', link: '2' },
      makeSnapshot(),
    );
    expect(plan.willSendCount).toBe(3);
    expect(plan.items[0]!.spenderModule).toBe('positionModule');
    expect(plan.items[1]!.spenderModule).toBe('treasuryModule');
    expect(plan.items[2]!.spenderModule).toBe('oracleModule');
  });

  it('orders items consistently (position, treasury, oracle)', () => {
    const plan = buildSetupPlan({ link: '2' }, makeSnapshot());
    expect(plan.items.map((i) => i.spenderModule)).toEqual([
      'positionModule',
      'treasuryModule',
      'oracleModule',
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
    const plan = buildSetupPlan({ riskUsdc: '50' }, makeSnapshot());
    renderSetupPlan(plan, sink);
    expect(sink.buf).toContain('Approval setup plan for ');
    expect(sink.buf).toContain('Polygon mainnet');
    expect(sink.buf).toContain('PositionModule');
    expect(sink.buf).toContain('TreasuryModule');
    expect(sink.buf).toContain('OracleModule');
    expect(sink.buf).toContain('Send');
    expect(sink.buf).toContain('Skip');
    expect(sink.buf).toContain('50.000000 USDC');
    expect(sink.buf).toContain('1.000000 USDC');
  });

  it('flags an auto-included fee with "auto-included alongside --risk-usdc"', () => {
    const sink = new StringSink();
    const plan = buildSetupPlan({ riskUsdc: '50' }, makeSnapshot());
    renderSetupPlan(plan, sink);
    expect(sink.buf).toContain('auto-included alongside --risk-usdc');
    expect(sink.buf).toContain('--fee-usdc 0 to skip');
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
      'oracleModule',
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
    const plan = buildSetupPlan({ riskUsdc: '50' }, makeSnapshot());
    const env = buildSetupPreviewEnvelope(plan);
    expect(env.schemaVersion).toBe(1);
    expect(env.plan).toBeDefined();
    expect(env.plan.willSendCount).toBe(2);
    expect((env.plan as Record<string, unknown>).schemaVersion).toBeUndefined();
    expect((env as Record<string, unknown>).results).toBeUndefined();
  });

  it('result envelope shape: { schemaVersion: 1, plan: {...}, results: [...] }', () => {
    const plan = buildSetupPlan({ riskUsdc: '50' }, makeSnapshot());
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
    expect((env.plan as Record<string, unknown>).schemaVersion).toBeUndefined();
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
