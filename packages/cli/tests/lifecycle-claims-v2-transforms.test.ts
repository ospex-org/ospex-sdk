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
  it('settled: one confirmed settle-speculation effect, ok true', () => {
    const env = toSettleAgentEnvelope(
      { speculationId: 101n, outcome: 'settled', winSide: 'away', txHash: '0xtx', blockNumber: 1000n },
      { chainId: POLYGON, signerAddress: SIGNER, speculationId: 101n },
    );
    expect(env.action).toBe('settle');
    expect(env.stage).toBe('execute');
    expect(env.ok).toBe(true);
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('settle-speculation');
    expect(env.effects[0]?.status).toBe('confirmed');
    expect(env.warnings).toEqual([]);
    expect(env.payload.outcome).toBe('settled');
    expect(env.payload.txHash).toBe('0xtx');
    expect(env.payload.winSide).toBe('away');
    expect(env.payload.speculationId).toBe('101');
  });

  it('alreadySettled: no effect, info warning, ok true, no txHash in payload', () => {
    const env = toSettleAgentEnvelope(
      { speculationId: 101n, outcome: 'alreadySettled', winSide: 'home' },
      { chainId: POLYGON, signerAddress: SIGNER, speculationId: 101n },
    );
    expect(env.ok).toBe(true);
    expect(env.effects).toEqual([]);
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0]?.code).toBe('settle-skipped-already-settled');
    expect(env.warnings[0]?.severity).toBe('info');
    expect(env.payload.outcome).toBe('alreadySettled');
    expect(env.payload.txHash).toBeNull();
    expect(env.payload.winSide).toBe('home');
  });

  it('recovered via pre-send (no broadcast): info warning, no effect', () => {
    const env = toSettleAgentEnvelope(
      { speculationId: 101n, outcome: 'recovered', winSide: 'over' },
      { chainId: POLYGON, signerAddress: SIGNER, speculationId: 101n },
    );
    expect(env.ok).toBe(true);
    expect(env.effects).toEqual([]);
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0]?.code).toBe('projection-lag-recovered');
    expect(env.payload.outcome).toBe('recovered');
    expect(env.payload.revertedTxHash).toBeNull();
  });

  it('recovered with a reverted broadcast: reverted settle effect + info warning, ok true', () => {
    const env = toSettleAgentEnvelope(
      { speculationId: 101n, outcome: 'recovered', winSide: 'under', revertedTxHash: '0xreverted' },
      { chainId: POLYGON, signerAddress: SIGNER, speculationId: 101n },
    );
    expect(env.ok).toBe(true); // entry recovered → settled → ok
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('settle-speculation');
    expect(env.effects[0]?.ok).toBe(false);
    expect(env.effects[0]?.status).toBe('reverted');
    expect(env.effects[0]?.txHash).toBe('0xreverted');
    expect(env.warnings[0]?.code).toBe('projection-lag-recovered');
    expect(env.payload.revertedTxHash).toBe('0xreverted');
  });
});

describe('toClaimAgentEnvelope', () => {
  const base = { chainId: POLYGON, signerAddress: SIGNER, speculationId: 101n, positionType: 0 as const };

  it('claimed: payout shoulder + one confirmed claim-position effect, ok true', () => {
    const env = toClaimAgentEnvelope(
      {
        speculationId: 101n,
        positionType: 0,
        outcome: 'claimed',
        txHash: '0xtx',
        blockNumber: 1000n,
        payoutWei6: 5_000_000n,
        payoutUSDC: 5,
      },
      base,
    );
    expect(env.action).toBe('claim');
    expect(env.ok).toBe(true);
    expect(env.payout?.profit.usdc).toBe('5.000000');
    expect(env.payout?.totalReturn.wei6).toBe('5000000');
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('claim-position');
    expect(env.effects[0]?.status).toBe('confirmed');
    expect(env.warnings).toEqual([]);
    expect(env.payload.outcome).toBe('claimed');
    expect(env.payload.txHash).toBe('0xtx');
    expect(env.payload.payoutWei6).toBe('5000000');
  });

  it('alreadyClaimed: no effect, no payout, info warning, ok true', () => {
    const env = toClaimAgentEnvelope(
      { speculationId: 101n, positionType: 1, outcome: 'alreadyClaimed' },
      { ...base, positionType: 1 },
    );
    expect(env.ok).toBe(true);
    expect(env.effects).toEqual([]);
    expect(env.payout).toBeNull();
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0]?.code).toBe('claim-skipped-already-claimed');
    expect(env.warnings[0]?.severity).toBe('info');
    expect(env.payload.outcome).toBe('alreadyClaimed');
    expect(env.payload.txHash).toBeNull();
    expect(env.payload.payoutWei6).toBeNull();
  });

  it('recovered via pre-send (no broadcast): info warning, no effect, no payout', () => {
    const env = toClaimAgentEnvelope(
      { speculationId: 101n, positionType: 0, outcome: 'recovered' },
      base,
    );
    expect(env.ok).toBe(true);
    expect(env.effects).toEqual([]);
    expect(env.payout).toBeNull();
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0]?.code).toBe('claim-recovered-already-claimed');
    expect(env.payload.outcome).toBe('recovered');
    expect(env.payload.revertedTxHash).toBeNull();
  });

  it('recovered with a reverted broadcast: reverted claim effect + info warning, ok true', () => {
    const env = toClaimAgentEnvelope(
      { speculationId: 101n, positionType: 0, outcome: 'recovered', revertedTxHash: '0xreverted' },
      base,
    );
    expect(env.ok).toBe(true); // entry recovered → claimed → ok
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('claim-position');
    expect(env.effects[0]?.ok).toBe(false);
    expect(env.effects[0]?.status).toBe('reverted');
    expect(env.effects[0]?.txHash).toBe('0xreverted');
    expect(env.warnings[0]?.code).toBe('claim-recovered-already-claimed');
    expect(env.payload.revertedTxHash).toBe('0xreverted');
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
      // Explicit step record — the mapper drives effects/warnings off
      // this, never off bucket+index. Tests overriding txHashes must
      // override steps to match.
      steps: [
        { name: 'claimPosition', outcome: 'sent', txHash: '0xclaim1', payoutWei6: '5000000', payoutUSDC: 5 },
      ],
      payoutUSDC: 5,
      payoutWei6: '5000000',
      winSide: 'away',
      error: undefined,
      ...overrides,
    };
  }

  // Hermes PR-70 blocker 1: the SDK intentionally returns
  // `success: false` for dry-runs (because no live sweep happened),
  // but the v2 envelope's top-level `ok` is COMMAND/envelope success,
  // not domain-level "claimed at least one thing". Dry-runs and live
  // no-op sweeps must emit ok:true. The SDK's dry-run shape uses
  // `success:false` + `totals.failed:0`, so envelope.ok now keys off
  // `totals.failed` instead of `result.success`.
  it('dry-run with success:false from SDK still emits envelope.ok=true', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: false, // SDK dry-run shape
        totals: {
          claimed: 1,
          failed: 0,
          totalPayoutWei6: '5000000',
          totalPayoutUSDC: 5,
        } as never,
        entries: [makeEntry({ success: true })] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: true },
    );
    expect(env.stage).toBe('dry-run');
    expect(env.requiresSignature).toBe(true);
    expect(env.requiresTransaction).toBe(true);
    expect(env.effects).toEqual([]);
    expect(env.ok).toBe(true); // dry-run completed successfully
  });

  it('live no-op (no entries) emits envelope.ok=true even though result.success is false', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: false, // SDK: success requires entries.length > 0
        totals: {
          claimed: 0,
          failed: 0,
          totalPayoutWei6: '0',
          totalPayoutUSDC: 0,
        } as never,
        entries: [] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.ok).toBe(true);
    expect(env.effects).toEqual([]);
    expect(env.payout).toBeNull();
  });

  it('execute: one effect per recorded tx; pendingSettle entries produce settle + claim in order', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: true,
        totals: {
          claimed: 2,
          failed: 0,
          totalPayoutWei6: '10000000',
          totalPayoutUSDC: 10,
        } as never,
        entries: [
          makeEntry({
            bucket: 'pendingSettle',
            txHashes: ['0xsettle', '0xclaim'],
            steps: [
              { name: 'settleSpeculation', outcome: 'sent', txHash: '0xsettle', winSide: 'away' },
              { name: 'claimPosition', outcome: 'sent', txHash: '0xclaim', payoutWei6: '5000000', payoutUSDC: 5 },
            ],
          }),
          makeEntry({
            bucket: 'claimable',
            txHashes: ['0xc2'],
            steps: [{ name: 'claimPosition', outcome: 'sent', txHash: '0xc2' }],
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.stage).toBe('execute');
    expect(env.effects).toHaveLength(3);
    expect(env.effects[0]?.purpose).toBe('settle-speculation');
    expect(env.effects[0]?.txHash).toBe('0xsettle');
    expect(env.effects[0]?.status).toBe('confirmed');
    expect(env.effects[1]?.purpose).toBe('claim-position');
    expect(env.effects[1]?.txHash).toBe('0xclaim');
    expect(env.effects[2]?.purpose).toBe('claim-position');
    expect(env.effects[2]?.txHash).toBe('0xc2');
    expect(env.ok).toBe(true);
  });

  // Hermes PR-70 blocker 2: recorded txHashes are confirmed-
  // successful (SDK throws on revert before pushing). A partial
  // pendingSettle (settle landed, claim failed) MUST emit the settle
  // tx as confirmed and the claim as a separate failure effect, not
  // mislabel the settle as reverted.
  it('partial pendingSettle (settle confirmed, claim failed): settle ok=true, separate claim failure effect', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: false,
        totals: {
          claimed: 0,
          failed: 1,
          totalPayoutWei6: '0',
          totalPayoutUSDC: 0,
        } as never,
        entries: [
          makeEntry({
            bucket: 'pendingSettle',
            success: false,
            txHashes: ['0xsettle'],
            steps: [
              { name: 'settleSpeculation', outcome: 'sent', txHash: '0xsettle', winSide: 'away' },
              {
                name: 'claimPosition',
                outcome: 'failed',
                errorCode: 'CHAIN_ERROR',
                txHash: '0xrevertedclaim',
                txStatus: 'reverted',
              },
            ],
            payoutUSDC: undefined,
            payoutWei6: undefined,
            error: {
              code: 'CHAIN_ERROR',
              message: 'claim reverted',
              txHash: '0xrevertedclaim',
            },
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.effects).toHaveLength(2);
    // The settle tx was confirmed — earlier mistake collapsed this
    // to ok=false/reverted.
    expect(env.effects[0]?.purpose).toBe('settle-speculation');
    expect(env.effects[0]?.txHash).toBe('0xsettle');
    expect(env.effects[0]?.ok).toBe(true);
    expect(env.effects[0]?.status).toBe('confirmed');
    // The claim step failed; recorded as a separate failure effect.
    // When the chain-error carries a txHash (reverted send), it is
    // surfaced with status: 'reverted'.
    expect(env.effects[1]?.purpose).toBe('claim-position');
    expect(env.effects[1]?.ok).toBe(false);
    expect(env.effects[1]?.txHash).toBe('0xrevertedclaim');
    expect(env.effects[1]?.status).toBe('reverted');
    expect(env.effects[1]?.errorCode).toBe('CHAIN_ERROR');
    expect(env.ok).toBe(false);
  });

  // PR #98 review round 2: a failed claim step whose tx CONFIRMED on-chain
  // (a claim that landed but whose POSITION_CLAIMED event was unparseable)
  // must surface as status:'confirmed', NEVER 'reverted'. The tx did not
  // revert; mislabeling it would tell agents the wrong on-chain outcome.
  it('failed step with a CONFIRMED tx (txStatus confirmed) maps to status confirmed, not reverted', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: false,
        totals: { claimed: 0, failed: 1, totalPayoutWei6: '0', totalPayoutUSDC: 0 } as never,
        entries: [
          makeEntry({
            bucket: 'claimable',
            success: false,
            txHashes: [],
            payoutUSDC: undefined,
            payoutWei6: undefined,
            steps: [
              {
                name: 'claimPosition',
                outcome: 'failed',
                errorCode: 'CHAIN_ERROR',
                txHash: '0xconfirmedbutunparseable',
                txStatus: 'confirmed',
              },
            ],
            error: { code: 'CHAIN_ERROR', message: 'no matching POSITION_CLAIMED event' },
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('claim-position');
    expect(env.effects[0]?.ok).toBe(false);
    expect(env.effects[0]?.txHash).toBe('0xconfirmedbutunparseable');
    expect(env.effects[0]?.status).toBe('confirmed'); // NOT 'reverted'
    expect(env.effects[0]?.errorCode).toBe('CHAIN_ERROR');
    expect(env.ok).toBe(false);
  });

  it('failed step with a tx hash but UNKNOWN status omits status (never guesses reverted)', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: false,
        totals: { claimed: 0, failed: 1, totalPayoutWei6: '0', totalPayoutUSDC: 0 } as never,
        entries: [
          makeEntry({
            bucket: 'claimable',
            success: false,
            txHashes: [],
            payoutUSDC: undefined,
            payoutWei6: undefined,
            // txHash present, but no txStatus → on-chain outcome unknown.
            steps: [
              { name: 'claimPosition', outcome: 'failed', errorCode: 'CHAIN_ERROR', txHash: '0xunknown' },
            ],
            error: { code: 'CHAIN_ERROR', message: 'boom' },
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.txHash).toBe('0xunknown');
    expect(env.effects[0]?.status).toBeUndefined(); // honest: no guess
    expect(env.effects[0]?.ok).toBe(false);
  });

  it('failed claimable entry with no recorded tx emits one failure claim-position effect (no txHash)', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: false,
        totals: {
          claimed: 0,
          failed: 1,
          totalPayoutWei6: '0',
          totalPayoutUSDC: 0,
        } as never,
        entries: [
          makeEntry({
            bucket: 'claimable',
            success: false,
            txHashes: [],
            steps: [{ name: 'claimPosition', outcome: 'failed', errorCode: 'API_ERROR' }],
            payoutUSDC: undefined,
            payoutWei6: undefined,
            error: { code: 'API_ERROR', message: 'precheck failed' },
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('claim-position');
    expect(env.effects[0]?.ok).toBe(false);
    expect(env.effects[0]?.txHash).toBeUndefined();
    expect(env.effects[0]?.errorCode).toBe('API_ERROR');
  });

  // Fallback: an entry failed but recorded no typed step (e.g. an
  // unrecognized future txParams.method threw before any step). The
  // mapper emits one generic claim-position failure effect from the
  // entry-level error so the failure isn't silently dropped.
  it('failed entry with empty steps emits one generic failure effect from entry.error', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: false,
        totals: { claimed: 0, failed: 1, totalPayoutWei6: '0', totalPayoutUSDC: 0 } as never,
        entries: [
          makeEntry({
            success: false,
            txHashes: [],
            steps: [],
            payoutUSDC: undefined,
            payoutWei6: undefined,
            error: { code: 'CHAIN_ERROR', message: 'unrecognized txParams.method "futureStep"' },
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('claim-position');
    expect(env.effects[0]?.ok).toBe(false);
    expect(env.effects[0]?.txHash).toBeUndefined();
    expect(env.effects[0]?.errorCode).toBe('CHAIN_ERROR');
  });

  // Headline + regression: a skipped settle (already settled on a
  // pre-flight read) sends NO settle tx. The lone claim tx must be
  // labeled claim-position — the old bucket+index mapper mislabeled
  // it settle-speculation. The skip surfaces as an info warning.
  it('skipped settle: info warning + the lone tx is labeled claim, not settle', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: true,
        totals: { claimed: 1, failed: 0, totalPayoutWei6: '5000000', totalPayoutUSDC: 5 } as never,
        entries: [
          makeEntry({
            bucket: 'pendingSettle',
            txHashes: ['0xclaimonly'],
            winSide: 'home',
            steps: [
              { name: 'settleSpeculation', outcome: 'skippedAlreadySettled', winSide: 'home' },
              { name: 'claimPosition', outcome: 'sent', txHash: '0xclaimonly', payoutWei6: '5000000', payoutUSDC: 5 },
            ],
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.ok).toBe(true);
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('claim-position'); // NOT settle-speculation
    expect(env.effects[0]?.txHash).toBe('0xclaimonly');
    expect(env.effects[0]?.status).toBe('confirmed');
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0]?.code).toBe('settle-skipped-already-settled');
    expect(env.warnings[0]?.severity).toBe('info');
    expect((env.warnings[0]?.details as { winSide?: string })?.winSide).toBe('home');
  });

  it('recovered settle via pre-send revert (no tx broadcast): warning, claim effect only', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: true,
        totals: { claimed: 1, failed: 0, totalPayoutWei6: '5000000', totalPayoutUSDC: 5 } as never,
        entries: [
          makeEntry({
            bucket: 'pendingSettle',
            txHashes: ['0xclaimonly'],
            winSide: 'under',
            steps: [
              // No txHash — recovery came via pre-flight read or pre-send revert.
              { name: 'settleSpeculation', outcome: 'recoveredAlreadySettled', winSide: 'under' },
              { name: 'claimPosition', outcome: 'sent', txHash: '0xclaimonly', payoutWei6: '5000000', payoutUSDC: 5 },
            ],
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.ok).toBe(true);
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('claim-position');
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0]?.code).toBe('projection-lag-recovered');
    expect(env.warnings[0]?.severity).toBe('info');
  });

  // Hermes #93 blocker (related): a recovered inclusion-time race where
  // this wallet DID broadcast a settle that reverted must surface the
  // reverted tx — the entry recovered, but gas was spent.
  it('recovered settle that broadcast a reverted tx: reverted settle effect + claim effect + warning', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: true,
        totals: { claimed: 1, failed: 0, totalPayoutWei6: '5000000', totalPayoutUSDC: 5 } as never,
        entries: [
          makeEntry({
            bucket: 'pendingSettle',
            txHashes: ['0xclaimonly'],
            winSide: 'under',
            steps: [
              {
                name: 'settleSpeculation',
                outcome: 'recoveredAlreadySettled',
                winSide: 'under',
                txHash: '0xrevertedsettle',
              },
              { name: 'claimPosition', outcome: 'sent', txHash: '0xclaimonly', payoutWei6: '5000000', payoutUSDC: 5 },
            ],
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.ok).toBe(true); // entry recovered → envelope ok
    expect(env.effects).toHaveLength(2);
    // The reverted settle tx is surfaced, not hidden.
    expect(env.effects[0]?.purpose).toBe('settle-speculation');
    expect(env.effects[0]?.ok).toBe(false);
    expect(env.effects[0]?.txHash).toBe('0xrevertedsettle');
    expect(env.effects[0]?.status).toBe('reverted');
    expect(env.effects[1]?.purpose).toBe('claim-position');
    expect(env.effects[1]?.status).toBe('confirmed');
    expect(env.warnings[0]?.code).toBe('projection-lag-recovered');
  });

  // Hermes #93 blocker (primary): a genuine settle receipt revert must
  // emit the settle tx hash with status:'reverted' — previously dropped
  // because the failed settle step didn't carry err.txHash.
  it('failed settle step with a revert tx hash emits a reverted settle-speculation effect', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: false,
        totals: { claimed: 0, failed: 1, totalPayoutWei6: '0', totalPayoutUSDC: 0 } as never,
        entries: [
          makeEntry({
            bucket: 'pendingSettle',
            success: false,
            txHashes: [],
            payoutUSDC: undefined,
            payoutWei6: undefined,
            steps: [
              {
                name: 'settleSpeculation',
                outcome: 'failed',
                errorCode: 'CHAIN_ERROR',
                txHash: '0xrevertedsettle',
                txStatus: 'reverted',
              },
            ],
            error: { code: 'CHAIN_ERROR', message: 'Transaction reverted on-chain.', txHash: '0xrevertedsettle' },
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('settle-speculation');
    expect(env.effects[0]?.ok).toBe(false);
    expect(env.effects[0]?.txHash).toBe('0xrevertedsettle');
    expect(env.effects[0]?.status).toBe('reverted');
    expect(env.effects[0]?.errorCode).toBe('CHAIN_ERROR');
    expect(env.ok).toBe(false);
  });

  // Hermes PR-70 blocker 3: payout shoulder must preserve exact
  // wei6 from the SDK's totals.totalPayoutWei6. Going through
  // totalPayoutUSDC (a JS number) loses precision past 2^53.
  it('payout shoulder uses exact totalPayoutWei6 (no number round-trip)', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: true,
        totals: {
          claimed: 1,
          failed: 0,
          totalPayoutWei6: '1000000000000000001',
          totalPayoutUSDC: 1e12, // lossy approximation
        } as never,
        entries: [
          makeEntry({
            payoutWei6: '1000000000000000001',
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    // The shoulder must carry the EXACT wei6 string from the SDK.
    expect(env.payout?.profit.wei6).toBe('1000000000000000001');
    expect(env.payout?.totalReturn.wei6).toBe('1000000000000000001');
  });

  it('envelope.ok=false only when execute has failed entries (totals.failed > 0)', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: false,
        totals: {
          claimed: 1,
          failed: 1,
          totalPayoutWei6: '5000000',
          totalPayoutUSDC: 5,
        } as never,
        entries: [
          makeEntry({ success: true }),
          makeEntry({
            success: false,
            txHashes: [],
            steps: [{ name: 'claimPosition', outcome: 'failed', errorCode: 'CHAIN_ERROR' }],
            error: { code: 'CHAIN_ERROR', message: 'boom' },
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.ok).toBe(false);
    expect(env.payload.entries[1]?.error).toBe('boom');
  });

  // Claim-leg idempotency (v0.4.3): an already-claimed claim sends NO tx and
  // is NOT a failure — it surfaces as a distinct claim-specific info warning,
  // never as a fake claim effect or a payout.
  it('skipped claim (already claimed): info warning, no effect, ok true', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: true,
        totals: {
          claimed: 1,
          failed: 0,
          claimedFresh: 0,
          alreadyClaimed: 1,
          recoveredAlreadyClaimed: 0,
          totalPayoutWei6: '0',
          totalPayoutUSDC: 0,
        } as never,
        entries: [
          makeEntry({
            bucket: 'claimable',
            txHashes: [],
            payoutUSDC: undefined,
            payoutWei6: undefined,
            steps: [{ name: 'claimPosition', outcome: 'skippedAlreadyClaimed' }],
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.ok).toBe(true);
    expect(env.effects).toEqual([]); // no tx sent — no fake claim effect
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0]?.code).toBe('claim-skipped-already-claimed');
    expect(env.warnings[0]?.severity).toBe('info');
  });

  it('recovered claim that broadcast a reverted tx: reverted claim effect + claim-specific warning', () => {
    const env = toClaimAllAgentEnvelope(
      {
        address: SIGNER,
        success: true,
        totals: {
          claimed: 1,
          failed: 0,
          claimedFresh: 0,
          alreadyClaimed: 0,
          recoveredAlreadyClaimed: 1,
          totalPayoutWei6: '0',
          totalPayoutUSDC: 0,
        } as never,
        entries: [
          makeEntry({
            bucket: 'claimable',
            txHashes: [],
            payoutUSDC: undefined,
            payoutWei6: undefined,
            steps: [{ name: 'claimPosition', outcome: 'recoveredAlreadyClaimed', txHash: '0xrevertedclaim' }],
          }),
        ] as never,
      } as never,
      { chainId: POLYGON, signerAddress: SIGNER, dryRun: false },
    );
    expect(env.ok).toBe(true); // entry recovered → claimed → ok
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('claim-position');
    expect(env.effects[0]?.ok).toBe(false);
    expect(env.effects[0]?.status).toBe('reverted');
    expect(env.effects[0]?.txHash).toBe('0xrevertedclaim');
    expect(env.warnings[0]?.code).toBe('claim-recovered-already-claimed');
  });
});
