/**
 * Tests for the `ospex approvals show` rendering layer. The actual SDK
 * call (`client.approvals.read`) is exercised in the SDK suite —
 * here we just verify the CLI's human + JSON formatting on synthetic
 * snapshots.
 */

import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { ApprovalsSnapshot } from '@ospex/sdk';
import {
  isMaxAllowance,
  renderApprovalsSnapshot,
  snapshotToJson,
} from '../src/lib/approvalsRender.js';
import { isValidAddress } from '../src/lib/walletAddress.js';

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

const MAX_UINT256 = (1n << 256n) - 1n;

function makeSnapshot(overrides: {
  positionModule?: bigint;
  treasuryModule?: bigint;
  oracleModule?: bigint;
  chainId?: number;
} = {}): ApprovalsSnapshot {
  return {
    owner: OWNER as `0x${string}`,
    chainId: overrides.chainId ?? 137,
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

describe('renderApprovalsSnapshot', () => {
  it('renders headings, formatted USDC values, and the LINK section', () => {
    const sink = new StringSink();
    renderApprovalsSnapshot(
      makeSnapshot({ positionModule: 50_000_000n, treasuryModule: 5_000_000n }),
      sink,
    );
    expect(sink.buf).toContain('Wallet:');
    expect(sink.buf).toContain(OWNER);
    expect(sink.buf).toContain('Polygon mainnet');
    expect(sink.buf).toContain('USDC allowances');
    expect(sink.buf).toContain('PositionModule');
    expect(sink.buf).toContain('TreasuryModule');
    expect(sink.buf).toContain('50.000000 USDC');
    expect(sink.buf).toContain('5.000000 USDC');
    expect(sink.buf).toContain('LINK allowances');
  });

  it('hints at LINK being optional when the oracle allowance is zero', () => {
    const sink = new StringSink();
    renderApprovalsSnapshot(makeSnapshot(), sink);
    expect(sink.buf).toContain('only needed if you create or score contests');
  });

  it('omits the LINK hint when the oracle allowance is non-zero', () => {
    const sink = new StringSink();
    renderApprovalsSnapshot(makeSnapshot({ oracleModule: 10n ** 18n }), sink);
    expect(sink.buf).not.toContain('only needed if you create or score contests');
  });

  it('renders an unlimited (max) approval as such instead of a 78-digit number', () => {
    const sink = new StringSink();
    renderApprovalsSnapshot(makeSnapshot({ positionModule: MAX_UINT256 }), sink);
    expect(sink.buf).toContain('unlimited (max) USDC');
    expect(sink.buf).not.toMatch(/[0-9]{30,}/);
  });

  it('labels chain id 80002 as Polygon Amoy', () => {
    const sink = new StringSink();
    renderApprovalsSnapshot(makeSnapshot({ chainId: 80002 }), sink);
    expect(sink.buf).toContain('Polygon Amoy');
  });
});

describe('snapshotToJson', () => {
  it('serialises bigint allowances as decimal strings + formatted USDC', () => {
    const json = snapshotToJson(
      makeSnapshot({ positionModule: 50_000_000n, treasuryModule: 5_000_000n }),
    );
    expect(json.usdc.allowances.positionModule.raw).toBe('50000000');
    expect(json.usdc.allowances.positionModule.formatted).toBe('50');
    expect(json.usdc.allowances.positionModule.isMax).toBe(false);
    expect(json.usdc.allowances.treasuryModule.raw).toBe('5000000');
    expect(json.usdc.allowances.treasuryModule.formatted).toBe('5');
  });

  it('flags max approvals with isMax=true', () => {
    const json = snapshotToJson(makeSnapshot({ positionModule: MAX_UINT256 }));
    expect(json.usdc.allowances.positionModule.isMax).toBe(true);
  });

  it('preserves owner / chainId / token addresses', () => {
    const json = snapshotToJson(makeSnapshot());
    expect(json.owner).toBe(OWNER);
    expect(json.chainId).toBe(137);
    expect(json.usdc.address).toBe(USDC);
    expect(json.link.address).toBe(LINK);
    expect(json.usdc.allowances.positionModule.spender).toBe(POSITION_MODULE);
    expect(json.link.allowances.oracleModule.spender).toBe(ORACLE_MODULE);
  });

  it('round-trips through JSON.stringify with no BigInt errors', () => {
    const json = snapshotToJson(makeSnapshot({ positionModule: MAX_UINT256 }));
    expect(() => JSON.stringify(json)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(json));
    expect(parsed.usdc.allowances.positionModule.isMax).toBe(true);
  });
});

describe('isMaxAllowance', () => {
  it('treats uint256 max as max', () => {
    expect(isMaxAllowance(MAX_UINT256)).toBe(true);
  });

  it('treats values past the 2^248 threshold as max', () => {
    expect(isMaxAllowance(1n << 248n)).toBe(true);
    expect(isMaxAllowance((1n << 248n) + 1n)).toBe(true);
  });

  it('does not treat realistic bet sizes as max', () => {
    expect(isMaxAllowance(0n)).toBe(false);
    expect(isMaxAllowance(50_000_000n)).toBe(false); // 50 USDC
    expect(isMaxAllowance(10n ** 24n)).toBe(false); // 1M USDC, far above any real bet
  });
});

describe('isValidAddress', () => {
  it('accepts a 0x-prefixed 20-byte hex address', () => {
    expect(isValidAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')).toBe(true);
    expect(isValidAddress('0x' + 'A'.repeat(40))).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(isValidAddress('abcdefabcdefabcdefabcdefabcdefabcdefabcd')).toBe(false); // no 0x
    expect(isValidAddress('0xshort')).toBe(false);
    expect(isValidAddress('0x' + 'g'.repeat(40))).toBe(false); // non-hex char
    expect(isValidAddress('')).toBe(false);
  });
});
