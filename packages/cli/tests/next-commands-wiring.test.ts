/**
 * Per-command wiring tests for the PR-7 nextCommands registry.
 *
 * Pins:
 *   - Each migrated command's success-envelope transform emits the
 *     expected template ID(s).
 *   - `deriveRemediationNextCommands` maps OspexAllowanceError into
 *     the correct remediate-approve-* template based on the
 *     spender address.
 *
 * The end-to-end argv-roundtrip test (every template's argv parses
 * through commander) lives in `next-commands-argv-roundtrip.test.ts`.
 * The template metadata tests (safeToAutoRun rules, kebab-case IDs)
 * live there too.
 */

import { describe, expect, it } from 'vitest';
import {
  OspexAllowanceError,
  buildSubmitPreview,
  getAddresses,
  type BuildSubmitPreviewArgs,
  type Commitment,
  type Hex,
} from '@ospex/sdk';
import {
  toSubmitExecuteEnvelope,
} from '../src/commands/commitments/submit.js';
import { toClaimAgentEnvelope } from '../src/commands/positions/claim.js';
import { toSettleAgentEnvelope } from '../src/commands/positions/settle.js';
import {
  toCancelAllDryRunEnvelope,
  toCancelAllExecuteEnvelope,
} from '../src/commands/commitments/cancel-all.js';
import { toCancelOnchainAgentEnvelope } from '../src/commands/commitments/cancel-onchain.js';
import {
  toContestCreateAgentEnvelope,
} from '../src/commands/contests/create.js';
import { toContestScoreAgentEnvelope } from '../src/commands/contests/score.js';
import { toContestUpdateMarketsAgentEnvelope } from '../src/commands/contests/update-markets.js';
import { deriveRemediationNextCommands } from '../src/lib/nextCommandTemplates.js';

const POLYGON = 137 as const;
const SIGNER: Hex = '0xaabbccddeeff00112233445566778899aabbccdd';
const MAKER: Hex = SIGNER;
const HASH = ('0x' + 'cd'.repeat(32)) as Hex;
const SPEC_KEY = ('0x' + 'ab'.repeat(32)) as Hex;

function makeCommitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    commitmentHash: HASH,
    maker: SIGNER,
    contestId: '42',
    scorer: getAddresses(POLYGON).scorers.moneyline,
    lineTicks: 0,
    positionType: 0,
    oddsTick: 250,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '17000000001',
    expiry: '2099-05-08T02:00:00Z',
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

function makeSubmitPreviewArgs(): BuildSubmitPreviewArgs {
  const addresses = getAddresses(POLYGON);
  return {
    contestId: 42n,
    awayTeam: 'Los Angeles Lakers',
    homeTeam: 'Denver Nuggets',
    awayTeamId: 'lakers-uuid',
    homeTeamId: 'nuggets-uuid',
    sport: 'nba',
    matchTime: '2099-05-08T02:00:00Z',
    market: 'moneyline',
    scorer: addresses.scorers.moneyline,
    lineTicks: 0,
    speculation: { mode: 'lazy', speculationId: null, speculationKey: SPEC_KEY },
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
    chainId: POLYGON,
    matchingModuleAddress: addresses.matchingModule,
    expirySec: 1778281200n,
    expirySource: 'default-match-time',
    matchTimeSec: 1778281200n,
    makerCreationFeeWei6: 250_000n,
    treasuryModuleAddress: addresses.treasuryModule,
    treasuryUsdcCurrentAllowanceWei6: 0n,
    nonce: 17_000_000_001n,
    positionModuleAddress: addresses.positionModule,
    usdcCurrentAllowanceWei6: 0n,
  };
}

describe('PR-7 wiring: success envelopes carry the right verify suggestions', () => {
  it('commitments.submit execute → verify-commitment with the new hash', () => {
    const preview = buildSubmitPreview(makeSubmitPreviewArgs());
    const env = toSubmitExecuteEnvelope(
      preview,
      { hash: '0xnewhash', commitment: makeCommitment() },
      { chainId: POLYGON },
    );
    expect(env.nextCommands).toHaveLength(1);
    expect(env.nextCommands[0]?.id).toBe('verify-commitment');
    expect(env.nextCommands[0]?.argv).toContain('0xnewhash');
    expect(env.nextCommands[0]?.safeToAutoRun).toBe(true);
  });

  it('claim → verify-position-status with the signer address', () => {
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
    expect(env.nextCommands[0]?.id).toBe('verify-position-status');
    expect(env.nextCommands[0]?.argv).toContain(SIGNER);
  });

  it('settle → verify-position-status', () => {
    const env = toSettleAgentEnvelope(
      {
        txHash: '0xtx',
        blockNumber: 1000n,
        winSide: 'away',
        receipt: { status: 'success', blockNumber: 1000n } as never,
      },
      { chainId: POLYGON, signerAddress: SIGNER, speculationId: 101n },
    );
    expect(env.nextCommands[0]?.id).toBe('verify-position-status');
  });

  it('cancel-onchain → verify-commitment with the cancelled hash', () => {
    const env = toCancelOnchainAgentEnvelope(
      {
        txHash: '0xtx',
        commitmentHash: HASH,
        receipt: { status: 'success', blockNumber: 1000n } as never,
      },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, explorer: 'https://x' },
    );
    expect(env.nextCommands[0]?.id).toBe('verify-commitment');
    expect(env.nextCommands[0]?.argv).toContain(HASH);
  });

  it('contests.create → verify-contest + complete-wait-verified when verification is null', () => {
    const env = toContestCreateAgentEnvelope(
      {
        contestId: 9001n,
        txHash: '0xcreate',
        receipt: { status: 'success', blockNumber: 1000n } as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, verification: null },
    );
    const ids = env.nextCommands.map((c) => c.id);
    expect(ids).toContain('verify-contest');
    expect(ids).toContain('complete-contests-wait-verified');
  });

  it('contests.create → verify-contest only when verification already landed', () => {
    const env = toContestCreateAgentEnvelope(
      {
        contestId: 9001n,
        txHash: '0xcreate',
        receipt: { status: 'success', blockNumber: 1000n } as never,
      } as never,
      {
        chainId: POLYGON,
        signerAddress: SIGNER,
        verification: { contestId: '9001', status: 'verified' },
      },
    );
    expect(env.nextCommands).toHaveLength(1);
    expect(env.nextCommands[0]?.id).toBe('verify-contest');
  });

  it('contests.score → verify-contest', () => {
    const env = toContestScoreAgentEnvelope(
      {
        contestId: 9001n,
        txHash: '0xscore',
        receipt: { status: 'success', blockNumber: 1000n } as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER },
    );
    expect(env.nextCommands[0]?.id).toBe('verify-contest');
  });

  it('contests.update-markets → verify-contest-odds', () => {
    const env = toContestUpdateMarketsAgentEnvelope(
      {
        contestId: 9001n,
        requestNonce: 3n,
        txHash: '0xupdate',
        receipt: { status: 'success', blockNumber: 1000n } as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER },
    );
    expect(env.nextCommands[0]?.id).toBe('verify-contest-odds');
  });
});

describe('PR-7 wiring: dry-run envelopes carry the right complete suggestions', () => {
  it('cancel-all dry-run → complete-cancel-all with the same contest/scorer/line + newMinNonce', () => {
    const env = toCancelAllDryRunEnvelope({
      chainId: POLYGON,
      signerAddress: SIGNER,
      contestId: 42n,
      scorer: ('0x' + '11'.repeat(20)) as Hex,
      lineTicks: -35,
      newMinNonce: 17_000_000_005n,
      invalidatedCount: 3,
      commitments: [],
    });
    expect(env.nextCommands[0]?.id).toBe('complete-cancel-all');
    expect(env.nextCommands[0]?.argv).toContain('42');
    expect(env.nextCommands[0]?.argv).toContain('-35');
    // The execute form must carry the previewed floor through verbatim —
    // anything else would silently let the maker confirm a plan against a
    // different `newMinNonce` than the dry-run priced.
    expect(env.nextCommands[0]?.argv).toEqual(
      expect.arrayContaining(['--new-min-nonce', '17000000005']),
    );
    expect(env.nextCommands[0]?.safeToAutoRun).toBe(false); // it's a write
  });

  it('cancel-all execute → verify-commitments-empty with maker + contestId', () => {
    const env = toCancelAllExecuteEnvelope(
      {
        txHash: '0xtx',
        receipt: { status: 'success', blockNumber: 1000n } as never,
        newMinNonce: 17_000_000_005n,
        invalidatedCount: 4,
      },
      {
        chainId: POLYGON,
        signerAddress: SIGNER,
        contestId: 42n,
        scorer: ('0x' + '11'.repeat(20)) as Hex,
        lineTicks: 0,
        explorer: 'https://x',
      },
    );
    expect(env.nextCommands[0]?.id).toBe('verify-commitments-empty');
    expect(env.nextCommands[0]?.argv).toContain(SIGNER);
    expect(env.nextCommands[0]?.argv).toContain('42');
  });
});

describe('PR-7 wiring: deriveRemediationNextCommands', () => {
  it('PositionModule allowance shortfall → remediate-approve-position with formatted USDC', () => {
    const addresses = getAddresses(POLYGON);
    const err = new OspexAllowanceError('short', {
      required: 25_000_000n,
      current: 0n,
      spender: addresses.positionModule,
      token: addresses.usdc,
    });
    const out = deriveRemediationNextCommands(err, POLYGON);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('remediate-approve-position');
    expect(out[0]?.argv).toContain('25.000000');
    expect(out[0]?.safeToAutoRun).toBe(false);
  });

  it('TreasuryModule allowance shortfall → remediate-approve-treasury', () => {
    const addresses = getAddresses(POLYGON);
    const err = new OspexAllowanceError('short', {
      required: 250_000n,
      current: 0n,
      spender: addresses.treasuryModule,
      token: addresses.usdc,
    });
    const out = deriveRemediationNextCommands(err, POLYGON);
    expect(out[0]?.id).toBe('remediate-approve-treasury');
    expect(out[0]?.argv).toContain('0.250000');
  });

  it('non-allowance error → empty array (no remediation known)', () => {
    const err = new Error('boom');
    const out = deriveRemediationNextCommands(err, POLYGON);
    expect(out).toEqual([]);
  });

  it('allowance error for unknown spender → empty array (no false remediation)', () => {
    const err = new OspexAllowanceError('short', {
      required: 1_000_000n,
      current: 0n,
      spender: '0x000000000000000000000000000000000000dead' as Hex,
      token: getAddresses(POLYGON).usdc,
    });
    const out = deriveRemediationNextCommands(err, POLYGON);
    expect(out).toEqual([]);
  });
});
