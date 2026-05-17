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
import type { Commitment, Hex } from '@ospex/sdk';
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

function makeCommitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
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

  it('off-chain OK + on-chain failed before send → effects show error, errors[] populated', () => {
    const env = toCancelDualAgentEnvelope(
      {
        offChainResult: { ok: true },
        onChainResult: null,
        onChainError: { code: 'CHAIN_ERROR', message: 'NotCommitmentMaker' },
        explorer: null,
      },
      makeCommitment(),
      { chainId: POLYGON, signerAddress: SIGNER, hash: HASH },
    );
    expect(env.ok).toBe(false);
    expect(env.errors).toEqual([
      { code: 'CHAIN_ERROR', message: 'NotCommitmentMaker' },
    ]);
    expect(env.effects[2]?.ok).toBe(false);
    expect(env.effects[2]?.errorCode).toBe('CHAIN_ERROR');
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
  it('stage dry-run, requiresSignature+Transaction true, no effects', () => {
    const env = toCancelAllDryRunEnvelope({
      chainId: POLYGON,
      signerAddress: SIGNER,
      contestId: 42n,
      scorer: SCORER,
      lineTicks: 0,
      invalidatedCount: 3,
      commitments: [makeCommitment(), makeCommitment(), makeCommitment()],
    });
    expect(env.stage).toBe('dry-run');
    expect(env.requiresSignature).toBe(true);
    expect(env.requiresTransaction).toBe(true);
    expect(env.effects).toEqual([]);
    expect(env.payload.invalidatedCount).toBe(3);
    expect(env.payload.commitments).toHaveLength(3);
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
