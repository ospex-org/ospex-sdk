/**
 * Unit tests for `mapPreviewApprovals` — the shared helper that
 * lifts v1 `PreviewApproval` rows (from `SubmitPreview` /
 * `MatchPreview`) into the v2 `ApprovalRequirement` shoulder shape.
 *
 * Pins:
 *   - tokenSymbol + spenderLabel symbolic annotations
 *   - token address resolution from `getAddresses(chainId)`
 *   - requiredHuman / currentHuman formatting (USDC 6dp via SDK;
 *     LINK 18dp via viem.formatUnits)
 *   - lowercased spender address
 *   - unknown spender throws (forward-compat policy)
 */

import { describe, expect, it } from 'vitest';
import type { PreviewApproval } from '@ospex/sdk';
import { getAddresses } from '@ospex/sdk';
import {
  formatTokenAmount,
  mapPreviewApprovals,
  spenderLabelFor,
} from '../src/lib/agentEnvelope.js';

const POLYGON = 137 as const;
const AMOY = 80002 as const;

describe('mapPreviewApprovals', () => {
  it('maps a USDC → PositionModule row with full annotations', () => {
    const addresses = getAddresses(POLYGON);
    const row: PreviewApproval = {
      token: 'USDC',
      spender: addresses.positionModule,
      required: '25000000',
      current: '0',
      needsApproval: true,
      purpose: 'commitment-risk',
    };
    const [out] = mapPreviewApprovals([row], POLYGON);
    expect(out).toEqual({
      token: addresses.usdc.toLowerCase(),
      tokenSymbol: 'USDC',
      spender: addresses.positionModule.toLowerCase(),
      spenderLabel: 'PositionModule',
      purpose: 'commitment-risk',
      requiredWei: '25000000',
      requiredHuman: '25.000000',
      currentWei: '0',
      currentHuman: '0.000000',
      needsApproval: true,
    });
  });

  it('maps a USDC → TreasuryModule row (lazy-creation-fee)', () => {
    const addresses = getAddresses(POLYGON);
    const row: PreviewApproval = {
      token: 'USDC',
      spender: addresses.treasuryModule,
      required: '250000',
      current: '250000',
      needsApproval: false,
      purpose: 'lazy-creation-fee',
    };
    const [out] = mapPreviewApprovals([row], POLYGON);
    expect(out?.spenderLabel).toBe('TreasuryModule');
    expect(out?.purpose).toBe('lazy-creation-fee');
    expect(out?.needsApproval).toBe(false);
    expect(out?.requiredHuman).toBe('0.250000');
    expect(out?.currentHuman).toBe('0.250000');
  });

  it('uses the network-correct token address (Amoy ≠ Polygon)', () => {
    const polygon = getAddresses(POLYGON);
    const amoy = getAddresses(AMOY);
    const baseRow = (chainAddresses: typeof polygon): PreviewApproval => ({
      token: 'USDC',
      spender: chainAddresses.positionModule,
      required: '1000000',
      current: '0',
      needsApproval: true,
      purpose: 'commitment-risk',
    });
    const [pOut] = mapPreviewApprovals([baseRow(polygon)], POLYGON);
    const [aOut] = mapPreviewApprovals([baseRow(amoy)], AMOY);
    expect(pOut?.token).toBe(polygon.usdc.toLowerCase());
    expect(aOut?.token).toBe(amoy.usdc.toLowerCase());
    expect(pOut?.token).not.toBe(aOut?.token);
  });

  it('lowercases the spender address even when input is mixed-case', () => {
    const addresses = getAddresses(POLYGON);
    // Force a mixed-case spender to confirm the mapper normalizes.
    const mixed = addresses.positionModule.replace('0x', '0X').toUpperCase() as `0x${string}`;
    const row: PreviewApproval = {
      token: 'USDC',
      spender: mixed,
      required: '1000000',
      current: '0',
      needsApproval: true,
      purpose: 'commitment-risk',
    };
    const [out] = mapPreviewApprovals([row], POLYGON);
    expect(out?.spender).toBe(addresses.positionModule.toLowerCase());
  });

  it('preserves order and length', () => {
    const a = getAddresses(POLYGON);
    const rows: PreviewApproval[] = [
      {
        token: 'USDC',
        spender: a.positionModule,
        required: '1',
        current: '0',
        needsApproval: true,
        purpose: 'commitment-risk',
      },
      {
        token: 'USDC',
        spender: a.treasuryModule,
        required: '2',
        current: '0',
        needsApproval: true,
        purpose: 'lazy-creation-fee',
      },
    ];
    const out = mapPreviewApprovals(rows, POLYGON);
    expect(out).toHaveLength(2);
    expect(out[0]?.spenderLabel).toBe('PositionModule');
    expect(out[1]?.spenderLabel).toBe('TreasuryModule');
  });

  it('throws on unknown spender (forward-compat policy)', () => {
    const row: PreviewApproval = {
      token: 'USDC',
      spender: '0x000000000000000000000000000000000000dead',
      required: '1000000',
      current: '0',
      needsApproval: true,
      purpose: 'commitment-risk',
    };
    expect(() => mapPreviewApprovals([row], POLYGON)).toThrow(/unknown spender/i);
  });
});

describe('spenderLabelFor', () => {
  it('returns PositionModule / TreasuryModule / OracleModule for known spenders', () => {
    const a = getAddresses(POLYGON);
    expect(spenderLabelFor(a.positionModule.toLowerCase() as `0x${string}`, POLYGON)).toBe(
      'PositionModule',
    );
    expect(spenderLabelFor(a.treasuryModule.toLowerCase() as `0x${string}`, POLYGON)).toBe(
      'TreasuryModule',
    );
    expect(spenderLabelFor(a.oracleModule.toLowerCase() as `0x${string}`, POLYGON)).toBe(
      'OracleModule',
    );
  });
});

describe('formatTokenAmount', () => {
  it('USDC: 6 fractional digits via SDK wei6ToDecimalUSDC', () => {
    expect(formatTokenAmount('USDC', '25000000')).toBe('25.000000');
    expect(formatTokenAmount('USDC', '0')).toBe('0.000000');
    expect(formatTokenAmount('USDC', '1')).toBe('0.000001');
  });
  it('LINK: 18 fractional digits via viem.formatUnits', () => {
    expect(formatTokenAmount('LINK', '1000000000000000000')).toBe('1');
    expect(formatTokenAmount('LINK', '500000000000000000')).toBe('0.5');
    expect(formatTokenAmount('LINK', '0')).toBe('0');
  });
});
