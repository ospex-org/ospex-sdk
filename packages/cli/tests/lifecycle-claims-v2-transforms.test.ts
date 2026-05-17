/**
 * Unit tests for the v1 → v2 envelope transforms used by the claim
 * family of lifecycle writes:
 *   - settle
 *   - claim
 *   - claim-all (execute + --dry-run; multi-tx effects)
 */

import { describe, expect, it } from 'vitest';
import type { Hex } from '@ospex/sdk';
import { toSettleAgentEnvelope } from '../src/commands/positions/settle.js';
import { toClaimAgentEnvelope } from '../src/commands/positions/claim.js';
import { toClaimAllAgentEnvelope } from '../src/commands/positions/claim-all.js';

const POLYGON = 137 as const;
const SIGNER: Hex = '0xaabbccddeeff00112233445566778899aabbccdd';

describe('toSettleAgentEnvelope', () => {
  it('action settle, stage execute, single settle-speculation effect', () => {
    const env = toSettleAgentEnvelope(
      {
        txHash: '0xtx',
        blockNumber: 1000n,
        winSide: 'away',
        receipt: { status: 'success', blockNumber: 1000n } as never,
      },
      { chainId: POLYGON, signerAddress: SIGNER, speculationId: 101n },
    );
    expect(env.action).toBe('settle');
    expect(env.stage).toBe('execute');
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('settle-speculation');
    expect(env.effects[0]?.status).toBe('confirmed');
    expect(env.payload.winSide).toBe('away');
    expect(env.payload.speculationId).toBe('101');
  });

  it('envelope.ok reflects reverted receipt', () => {
    const env = toSettleAgentEnvelope(
      {
        txHash: '0xtx',
        blockNumber: 1000n,
        winSide: 'tbd',
        receipt: { status: 'reverted', blockNumber: 1000n } as never,
      },
      { chainId: POLYGON, signerAddress: SIGNER, speculationId: 101n },
    );
    expect(env.ok).toBe(false);
    expect(env.effects[0]?.status).toBe('reverted');
  });
});

describe('toClaimAgentEnvelope', () => {
  it('action claim, payout shoulder populated from payoutWei6', () => {
    const env = toClaimAgentEnvelope(
      {
        txHash: '0xtx',
        blockNumber: 1000n,
        payoutWei6: 5_000_000n,
        payoutUSDC: 5,
        receipt: { status: 'success', blockNumber: 1000n } as never,
      },
      {
        chainId: POLYGON,
        signerAddress: SIGNER,
        speculationId: 101n,
        positionType: 0,
      },
    );
    expect(env.action).toBe('claim');
    expect(env.payout?.profit.usdc).toBe('5.000000');
    expect(env.payout?.totalReturn.wei6).toBe('5000000');
    expect(env.effects[0]?.purpose).toBe('claim-position');
  });
});

describe('toClaimAllAgentEnvelope', () => {
  function makeEntry(overrides: Record<string, unknown> = {}) {
    return {
      positionId: '1',
      speculationId: '101',
      bucket: 'claimable',
      description: 'Lakers @ Nuggets / moneyline / Lakers',
      success: true,
      txHashes: ['0xclaim1'],
      payoutUSDC: 5,
      payoutWei6: '5000000',
      winSide: 'away',
      error: undefined,
      ...overrides,
    };
  }

  it('dry-run: stage dry-run, requiresSignature/Transaction true, no effects', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: true,
        totals: { claimed: 0, failed: 0, totalPayoutUSDC: 0 } as never,
        entries: [makeEntry()] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: true },
    );
    expect(env.stage).toBe('dry-run');
    expect(env.requiresSignature).toBe(true);
    expect(env.requiresTransaction).toBe(true);
    expect(env.effects).toEqual([]);
  });

  it('execute: one effect per tx; pendingSettle entries produce settle + claim in order', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: true,
        totals: { claimed: 2, failed: 0, totalPayoutUSDC: 10 } as never,
        entries: [
          makeEntry({
            bucket: 'pendingSettle',
            txHashes: ['0xsettle', '0xclaim'],
          }),
          makeEntry({ bucket: 'claimable', txHashes: ['0xc2'] }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.stage).toBe('execute');
    expect(env.effects).toHaveLength(3);
    // pendingSettle's first tx is the settle tx, second is the claim tx.
    expect(env.effects[0]?.purpose).toBe('settle-speculation');
    expect(env.effects[0]?.txHash).toBe('0xsettle');
    expect(env.effects[1]?.purpose).toBe('claim-position');
    expect(env.effects[1]?.txHash).toBe('0xclaim');
    // claimable entries are single-tx claim.
    expect(env.effects[2]?.purpose).toBe('claim-position');
    expect(env.effects[2]?.txHash).toBe('0xc2');
  });

  it('payout shoulder aggregates totals.totalPayoutUSDC', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: true,
        totals: { claimed: 2, failed: 0, totalPayoutUSDC: 12.5 } as never,
        entries: [makeEntry()] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.payout?.profit.usdc).toBe('12.500000');
  });

  it('envelope.ok mirrors result.success', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: false,
        totals: { claimed: 1, failed: 1, totalPayoutUSDC: 5 } as never,
        entries: [
          makeEntry({ success: false, error: { message: 'boom' } }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.ok).toBe(false);
    expect(env.payload.entries[0]?.error).toBe('boom');
  });
});
