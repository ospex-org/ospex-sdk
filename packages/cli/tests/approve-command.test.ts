/**
 * Tests for `ospex commitments approve` (decimal USDC) and
 * `ospex commitments approve-raw` (6-decimal-units integer). Two
 * layers:
 *
 *   1. Parser semantics — exercise the strict shape rules on each
 *      command's argument parser.
 *   2. Command wiring — verify both commands are registered with the
 *      expected option surface (--yes, --json) and the right
 *      argument descriptions.
 *
 * Full action flows hit the chain and live in the manual integration
 * playbook (§4.1).
 */

import { describe, expect, it } from 'vitest';
import { maxUint256 } from 'viem';
import {
  commitmentsApproveCommand,
  parseHumanUsdc,
} from '../src/commands/commitments/approve.js';
import {
  commitmentsApproveRawCommand,
  parseRawWei6,
} from '../src/commands/commitments/approve-raw.js';

describe('parseHumanUsdc', () => {
  it('parses decimal USDC into wei6 bigint', () => {
    expect(parseHumanUsdc('5')).toBe(5_000_000n);
    expect(parseHumanUsdc('0.25')).toBe(250_000n);
    expect(parseHumanUsdc('50.000001')).toBe(50_000_001n);
  });

  it('parses "max" as the literal sentinel', () => {
    expect(parseHumanUsdc('max')).toBe('max');
  });

  it('treats "0" / "0.000000" as a valid revoke (zero approval)', () => {
    // USDC.approve(spender, 0) is a legal no-op approve; approvalsPlan
    // treats 0 as "skip the dimension" because it's a multi-dimension
    // planner, but here a literal 0 is the user explicitly requesting
    // a revoke and we honor it.
    expect(parseHumanUsdc('0')).toBe(0n);
    expect(parseHumanUsdc('0.000000')).toBe(0n);
  });

  it('rejects exponents, commas, leading sign, > 6 fractional digits', () => {
    expect(() => parseHumanUsdc('5e3')).toThrow(/Invalid USDC amount/);
    expect(() => parseHumanUsdc('1e3')).toThrow();
    expect(() => parseHumanUsdc('5,000')).toThrow();
    expect(() => parseHumanUsdc('+5')).toThrow();
    expect(() => parseHumanUsdc('-5')).toThrow();
    expect(() => parseHumanUsdc('5.1234567')).toThrow();
    expect(() => parseHumanUsdc('NaN')).toThrow();
    expect(() => parseHumanUsdc(' 5 ')).toThrow();
  });

  it('directs the user to approve-raw when the input is suspect', () => {
    // The error message should at least mention the raw escape hatch
    // so a confused user has a path forward.
    expect(() => parseHumanUsdc('foo')).toThrow(/approve-raw/);
  });
});

describe('parseRawWei6', () => {
  it('parses an integer string into bigint', () => {
    expect(parseRawWei6('5000000')).toBe(5_000_000n);
    expect(parseRawWei6('0')).toBe(0n);
    expect(parseRawWei6('1')).toBe(1n);
  });

  it('parses "max" as the literal sentinel', () => {
    expect(parseRawWei6('max')).toBe('max');
  });

  it('rejects any non-integer input', () => {
    expect(() => parseRawWei6('5.0')).toThrow(/Invalid wei6 amount/);
    expect(() => parseRawWei6('5e6')).toThrow();
    expect(() => parseRawWei6('5,000,000')).toThrow();
    expect(() => parseRawWei6('-1')).toThrow();
    expect(() => parseRawWei6('+1')).toThrow();
    expect(() => parseRawWei6('foo')).toThrow();
  });

  it('directs the user to `approve` when the input is suspect', () => {
    expect(() => parseRawWei6('5.0')).toThrow(/`ospex commitments approve`/);
  });
});

describe('command surface', () => {
  it('registers the human-USDC primary command with --yes and --json', () => {
    const opts = commitmentsApproveCommand.options.map((o) => o.long);
    expect(opts).toContain('--yes');
    expect(opts).toContain('--json');
  });

  it('registers approve-raw with --yes and --json', () => {
    const opts = commitmentsApproveRawCommand.options.map((o) => o.long);
    expect(opts).toContain('--yes');
    expect(opts).toContain('--json');
  });

  it('approve description points at decimal USDC and references approve-raw', () => {
    const desc = commitmentsApproveCommand.description();
    expect(desc).toMatch(/decimal USDC/);
    expect(desc).toMatch(/approve-raw/);
  });

  it('approve-raw description points at the integer form and references approve', () => {
    const desc = commitmentsApproveRawCommand.description();
    expect(desc).toMatch(/raw 6-decimal-units/);
    expect(desc).toMatch(/`ospex commitments approve <n>`/);
  });
});

describe('parser sanity bounds', () => {
  // approve-raw can produce maxUint256-style values; verify they fit.
  it('parses a maxUint256 wei6 string without overflow', () => {
    const max = maxUint256.toString();
    expect(parseRawWei6(max)).toBe(maxUint256);
  });
});
