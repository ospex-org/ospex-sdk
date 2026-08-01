/**
 * Unit tests for the v1 → v2 envelope transforms used by the cancel
 * family of lifecycle writes:
 *   - commitments cancel (off-chain only)
 *   - commitments cancel --also-onchain (dual-phase)
 *   - commitments cancel-onchain
 *   - commitments cancel-all (execute + --dry-run)
 *
 * Mirrors PR-2/PR-4 transform-test patterns. Pins partial-success
 * handling for `cancel --also-onchain` per spec §6.
 */

import { describe, expect, it } from 'vitest';
import { OspexChainError } from '@ospex/sdk';
import type { Commitment, Hex, PublicVisibleCommitment } from '@ospex/sdk';
import {
  toCancelOffchainAgentEnvelope,
  toCancelDualAgentEnvelope,
} from '../src/commands/commitments/cancel.js';
import { toCancelOnchainAgentEnvelope } from '../src/commands/commitments/cancel-onchain.js';
import {
  toCancelAllDryRunEnvelope,
  toCancelAllExecuteEnvelope,
} from '../src/commands/commitments/cancel-all.js';

const POLYGON = 137 as const;
const SIGNER: Hex = '0xaabbccddeeff00112233445566778899aabbccdd';
const HASH = ('0x' + 'ab'.repeat(32)) as Hex;
const SCORER = ('0x' + '11'.repeat(20)) as Hex;

function makeCommitment(
  overrides: Partial<PublicVisibleCommitment> = {},
): PublicVisibleCommitment {
  return {
    visibility: 'visible',
    redacted: false,
    commitmentHash: HASH,
    maker: SIGNER,
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
    expiry: '2099-05-08T02:00:00Z',
    speculationKey: ('0x' + 'cd'.repeat(32)),
    signature: '0xsig',
    status: 'open',
    storedStatus: 'open',
    source: 'submit',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2026-05-09T00:00:00Z',
    ...overrides,
  };
}

describe('toCancelOffchainAgentEnvelope', () => {
  it('emits action commitments.cancel, stage execute, ok mirrors offchain result', () => {
    const env = toCancelOffchainAgentEnvelope(
      { ok: true },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, hash: HASH },
    );
    expect(env.action).toBe('commitments.cancel');
    expect(env.stage).toBe('execute');
    expect(env.ok).toBe(true);
  });

  it('records eip712-signature + offchain-write effects (no transaction)', () => {
    const env = toCancelOffchainAgentEnvelope(
      { ok: true },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, hash: HASH },
    );
    expect(env.effects).toHaveLength(2);
    expect(env.effects[0]?.type).toBe('eip712-signature');
    expect(env.effects[0]?.purpose).toBe('offchain-cancel');
    expect(env.effects[1]?.type).toBe('offchain-write');
  });

  it('populates commitment shoulder and walletRole=signer', () => {
    const c = makeCommitment();
    const env = toCancelOffchainAgentEnvelope(
      { ok: true },
      c,
      { chainId: POLYGON, signerAddress: SIGNER, hash: HASH },
    );
    expect(env.commitment).toBe(c);
    expect(env.walletRole).toBe('signer');
    expect(env.wallet).toBe(SIGNER);
  });
});

describe('toCancelDualAgentEnvelope (cancel --also-onchain partial-success)', () => {
  function makeOnChainResult(status: 'success' | 'reverted') {
    return {
      txHash: '0xon' as Hex,
      commitmentHash: HASH,
      receipt: { status, blockNumber: 1000n } as never,
    };
  }

  it('both phases succeed → 3 effects, all ok, envelope.ok=true', () => {
    const env = toCancelDualAgentEnvelope(
      {
        offChainResult: { ok: true },
        onChainResult: makeOnChainResult('success'),
        onChainError: null,
        explorer: 'https://polygonscan.com/tx/0xon',
      },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, hash: HASH },
    );
    expect(env.effects).toHaveLength(3);
    expect(env.effects[2]?.type).toBe('transaction');
    expect(env.effects[2]?.status).toBe('confirmed');
    expect(env.ok).toBe(true);
  });

  it('off-chain OK + on-chain reverted → ok=false with per-effect ok flags (spec §6)', () => {
    const env = toCancelDualAgentEnvelope(
      {
        offChainResult: { ok: true },
        onChainResult: makeOnChainResult('reverted'),
        onChainError: null,
        explorer: 'https://polygonscan.com/tx/0xon',
      },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, hash: HASH },
    );
    expect(env.ok).toBe(false);
    expect(env.effects[0]?.ok).toBe(true); // off-chain sig
    expect(env.effects[1]?.ok).toBe(true); // off-chain write
    expect(env.effects[2]?.ok).toBe(false); // on-chain tx reverted
    expect(env.effects[2]?.status).toBe('reverted');
  });

  it('off-chain OK + on-chain failed before send (no tx) → effects show error, reason + causeChain preserved, no status/txHash', () => {
    // Pre-send revert (NotCommitmentMaker caught at estimateGas): no tx was
    // broadcast, so the effect carries neither status nor txHash. The SDK
    // error carries the decoded `reason` AND the underlying viem revert on
    // `cause` — routing through errorToAgentError (vs the old hand-rolled
    // {code,message}) preserves BOTH in details (the M7 win).
    const cause = Object.assign(new Error('execution reverted'), {
      name: 'ContractFunctionRevertedError',
    });
    const env = toCancelDualAgentEnvelope(
      {
        offChainResult: { ok: true },
        onChainResult: null,
        onChainError: new OspexChainError(
          'cancelCommitment reverted: signer is not the commitment maker.',
          { reason: 'NotCommitmentMaker', cause },
        ),
        explorer: null,
      },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, hash: HASH },
    );
    expect(env.ok).toBe(false);
    expect(env.errors[0]?.code).toBe('CHAIN_ERROR');
    const details = env.errors[0]?.details as {
      reason?: string;
      causeChain?: Array<{ name?: string }>;
    };
    expect(details.reason).toBe('NotCommitmentMaker');
    // causeChain preserved with contents — the breadcrumb the old flattened
    // {code,message} dropped.
    expect(details.causeChain?.[0]?.name).toBe('ContractFunctionRevertedError');
    expect(env.effects[2]?.ok).toBe(false);
    expect(env.effects[2]?.errorCode).toBe('CHAIN_ERROR');
    expect(env.effects[2]?.status).toBeUndefined();
    expect(env.effects[2]?.txHash).toBeUndefined();
    expect(env.payload.txHash).toBeNull();
    expect(env.payload.onChainError?.code).toBe('CHAIN_ERROR');
  });

  it('off-chain OK + on-chain INCLUSION revert → effect carries txHash + status:reverted + details (M7)', () => {
    // The bug M7 fixes: cancelOnchain throws OspexChainError({txHash, receipt})
    // on an inclusion revert. The dual transform must preserve the hash + the
    // reverted receipt status — not flatten to {code,message}. This mirrors the
    // REAL emitted shape: broadcastSignedTx attaches no `cause` to a
    // reverted-receipt error, so a clean inclusion revert has NO causeChain.
    const env = toCancelDualAgentEnvelope(
      {
        offChainResult: { ok: true },
        onChainResult: null,
        onChainError: new OspexChainError('Transaction reverted on-chain.', {
          txHash: '0xreverted',
          receipt: { status: 'reverted', blockNumber: 4242n } as never,
        }),
        explorer: 'https://polygonscan.com/tx/0xreverted',
      },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, hash: HASH },
    );
    expect(env.ok).toBe(false);
    const txEffect = env.effects[2];
    expect(txEffect?.ok).toBe(false);
    expect(txEffect?.txHash).toBe('0xreverted');
    expect(txEffect?.status).toBe('reverted');
    expect(txEffect?.blockNumber).toBe('4242');
    expect(txEffect?.errorCode).toBe('CHAIN_ERROR');
    // errors[] now carries the structured discriminators (M3).
    const details = env.errors[0]?.details as {
      txHash?: string;
      receiptStatus?: string;
      receiptBlockNumber?: string;
      causeChain?: unknown[];
    };
    expect(details.txHash).toBe('0xreverted');
    expect(details.receiptStatus).toBe('reverted');
    expect(details.receiptBlockNumber).toBe('4242');
    // A clean inclusion revert carries no cause → no causeChain fabricated.
    expect(details.causeChain).toBeUndefined();
    // payload reflects the reverted tx too.
    expect(env.payload.txHash).toBe('0xreverted');
    expect(env.payload.blockNumber).toBe('4242');
  });

  it('off-chain OK + on-chain broadcast-then-receipt-timeout → effect status:submitted, txHash, no receiptStatus (M2+M7)', () => {
    // broadcastSignedTx broadcast a hash but the receipt wait failed: the tx
    // MAY still land. The effect must read submitted (not reverted), and the
    // error must NOT claim a receipt status.
    const env = toCancelDualAgentEnvelope(
      {
        offChainResult: { ok: true },
        onChainResult: null,
        onChainError: new OspexChainError(
          'Transaction was broadcast but waiting for its receipt failed; the transaction may still be mined.',
          { txHash: '0xpending' },
        ),
        explorer: 'https://polygonscan.com/tx/0xpending',
      },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, hash: HASH },
    );
    const txEffect = env.effects[2];
    expect(txEffect?.txHash).toBe('0xpending');
    expect(txEffect?.status).toBe('submitted');
    expect(txEffect?.blockNumber).toBeUndefined();
    const details = env.errors[0]?.details as { txHash?: string; receiptStatus?: string };
    expect(details.txHash).toBe('0xpending');
    expect(details.receiptStatus).toBeUndefined();
    expect(env.payload.txHash).toBe('0xpending');
    expect(env.payload.blockNumber).toBeNull();
  });

  it('off-chain OK + on-chain NON-chain error → off-chain leg preserved, UNKNOWN_ERROR, recovery nextCommand (M6)', () => {
    // The on-chain leg can now throw a NON-OspexChainError (e.g. a validation
    // error if the in-hand row can't be reconstructed, or an owner-auth
    // recovery failure). The dual envelope MUST still preserve the completed
    // off-chain DELETE in effects[] — never collapse to a bare failure that
    // hides it (the M6 fix) — and surface the cancel-onchain recovery.
    const env = toCancelDualAgentEnvelope(
      {
        offChainResult: { ok: true },
        onChainResult: null,
        onChainError: new Error('owner-auth recovery unavailable'),
        explorer: null,
      },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, hash: HASH },
    );
    expect(env.ok).toBe(false);
    // The completed off-chain leg survives (the regression M6 fixes).
    expect(env.effects[0]?.type).toBe('eip712-signature');
    expect(env.effects[0]?.ok).toBe(true);
    expect(env.effects[1]?.type).toBe('offchain-write');
    expect(env.effects[1]?.ok).toBe(true);
    // A non-chain failure → UNKNOWN_ERROR, no tx handle (honest: none landed).
    expect(env.effects[2]?.type).toBe('transaction');
    expect(env.effects[2]?.ok).toBe(false);
    expect(env.effects[2]?.errorCode).toBe('UNKNOWN_ERROR');
    expect(env.effects[2]?.txHash).toBeUndefined();
    expect(env.effects[2]?.status).toBeUndefined();
    expect(env.errors[0]?.code).toBe('UNKNOWN_ERROR');
    expect(env.payload.txHash).toBeNull();
    expect(env.payload.onChainError?.code).toBe('UNKNOWN_ERROR');
    // Recovery: complete the authoritative cancel via the standalone command.
    expect(
      env.nextCommands?.some(
        (c) => c.argv?.[0] === 'commitments' && c.argv?.[1] === 'cancel-onchain',
      ),
    ).toBe(true);
  });

  it('both phases succeed → nextCommands is verify-only (no cancel-onchain remediation)', () => {
    const env = toCancelDualAgentEnvelope(
      {
        offChainResult: { ok: true },
        onChainResult: makeOnChainResult('success'),
        onChainError: null,
        explorer: 'https://polygonscan.com/tx/0xon',
      },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, hash: HASH },
    );
    expect(env.ok).toBe(true);
    expect(env.nextCommands?.some((c) => c.argv?.[1] === 'cancel-onchain')).toBe(false);
  });
});

describe('toCancelOnchainAgentEnvelope', () => {
  it('single transaction effect + commitment shoulder + walletRole=signer', () => {
    const env = toCancelOnchainAgentEnvelope(
      {
        txHash: '0xab',
        commitmentHash: HASH,
        receipt: { status: 'success', blockNumber: 1000n } as never,
      },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, explorer: 'https://x' },
    );
    expect(env.action).toBe('commitments.cancel-onchain');
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('onchain-cancel');
    expect(env.effects[0]?.status).toBe('confirmed');
    expect(env.commitment?.commitmentHash).toBe(HASH);
    expect(env.walletRole).toBe('signer');
  });
});

describe('toCancelAllDryRunEnvelope', () => {
  it('stage dry-run, requiresSignature+Transaction true, no effects, round-trips newMinNonce', () => {
    const env = toCancelAllDryRunEnvelope({
      chainId: POLYGON,
      signerAddress: SIGNER,
      contestId: 42n,
      scorer: SCORER,
      lineTicks: 0,
      newMinNonce: 17_000_000_005n,
      invalidatedCount: 3,
      commitments: [makeCommitment(), makeCommitment(), makeCommitment()],
    });
    expect(env.stage).toBe('dry-run');
    expect(env.requiresSignature).toBe(true);
    expect(env.requiresTransaction).toBe(true);
    expect(env.effects).toEqual([]);
    expect(env.payload.newMinNonce).toBe('17000000005');
    expect(env.payload.invalidatedCount).toBe(3);
    expect(env.payload.commitments).toHaveLength(3);
    // The `complete-cancel-all` nextCommand must carry the previewed floor
    // verbatim so the suggested execute form runs against the same plan.
    expect(env.nextCommands?.[0]?.argv).toEqual(
      expect.arrayContaining(['--new-min-nonce', '17000000005']),
    );
  });
});

describe('toCancelAllExecuteEnvelope', () => {
  it('stage execute, single transaction effect (cancel-all-onchain), invalidatedCount in payload', () => {
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
        scorer: SCORER,
        lineTicks: 0,
        explorer: 'https://x',
      },
    );
    expect(env.stage).toBe('execute');
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('cancel-all-onchain');
    expect(env.payload.invalidatedCount).toBe(4);
    expect(env.payload.newMinNonce).toBe('17000000005');
  });
});
