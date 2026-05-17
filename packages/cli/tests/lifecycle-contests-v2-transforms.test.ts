/**
 * Unit tests for the v1 → v2 envelope transforms used by the
 * contest-lifecycle writes:
 *   - contests create (incl. approve-effect prepending per PR-69)
 *   - contests score (incl. approve-effect prepending)
 */

import { describe, expect, it } from 'vitest';
import type { AgentEffect, Hex } from '@ospex/sdk';
import { toContestCreateAgentEnvelope } from '../src/commands/contests/create.js';
import { toContestScoreAgentEnvelope } from '../src/commands/contests/score.js';

const POLYGON = 137 as const;
const SIGNER: Hex = '0xaabbccddeeff00112233445566778899aabbccdd';

function approveLinkEffect(txHash: string): AgentEffect {
  return {
    type: 'transaction',
    purpose: 'approve-link',
    ok: true,
    txHash: txHash as Hex,
    blockNumber: '500',
    status: 'confirmed',
  };
}

function approveUsdcEffect(txHash: string): AgentEffect {
  return {
    type: 'transaction',
    purpose: 'approve-usdc',
    ok: true,
    txHash: txHash as Hex,
    blockNumber: '500',
    status: 'confirmed',
  };
}

describe('toContestCreateAgentEnvelope', () => {
  function makeCreateResult(overrides: Record<string, unknown> = {}) {
    return {
      contestId: 9001n,
      txHash: '0xcreate',
      requestId: '0xrequest',
      receipt: { status: 'success', blockNumber: 1000n } as never,
      ...overrides,
    } as never;
  }

  it('action contests.create, single create-contest effect when no approvals', () => {
    const env = toContestCreateAgentEnvelope(makeCreateResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      verification: null,
    });
    expect(env.action).toBe('contests.create');
    expect(env.stage).toBe('execute');
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('create-contest');
    expect(env.payload.contestId).toBe('9001');
  });

  it('prepends a single approve-link effect (LINK-only allowance loop)', () => {
    const link = approveLinkEffect('0xlink');
    const env = toContestCreateAgentEnvelope(makeCreateResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      verification: null,
      approveEffects: [link],
    });
    expect(env.effects).toHaveLength(2);
    expect(env.effects[0]).toBe(link);
    expect(env.effects[1]?.purpose).toBe('create-contest');
  });

  it('prepends two approve effects (LINK + USDC), preserving chronological order', () => {
    const link = approveLinkEffect('0xlink');
    const usdc = approveUsdcEffect('0xusdc');
    const env = toContestCreateAgentEnvelope(makeCreateResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      verification: null,
      approveEffects: [link, usdc],
    });
    expect(env.effects).toHaveLength(3);
    expect(env.effects[0]?.purpose).toBe('approve-link');
    expect(env.effects[1]?.purpose).toBe('approve-usdc');
    expect(env.effects[2]?.purpose).toBe('create-contest');
  });

  it('envelope.ok=false when any approve reverted, even if create succeeded', () => {
    const reverted: AgentEffect = {
      ...approveLinkEffect('0xlink'),
      ok: false,
      status: 'reverted',
    };
    const env = toContestCreateAgentEnvelope(makeCreateResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      verification: null,
      approveEffects: [reverted],
    });
    expect(env.ok).toBe(false);
  });

  it('payload carries verification block when wait succeeded', () => {
    const env = toContestCreateAgentEnvelope(makeCreateResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      verification: { contestId: '9001', status: 'verified' },
    });
    expect(env.payload.verification?.status).toBe('verified');
  });
});

describe('toContestScoreAgentEnvelope', () => {
  function makeScoreResult(overrides: Record<string, unknown> = {}) {
    return {
      contestId: 9001n,
      txHash: '0xscore',
      requestId: '0xrequest',
      receipt: { status: 'success', blockNumber: 1000n } as never,
      ...overrides,
    } as never;
  }

  it('action contests.score, single score-contest effect when no approvals', () => {
    const env = toContestScoreAgentEnvelope(makeScoreResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
    });
    expect(env.action).toBe('contests.score');
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('score-contest');
  });

  it('prepends a single approve-link effect when LINK allowance was added inline', () => {
    const link = approveLinkEffect('0xlink');
    const env = toContestScoreAgentEnvelope(makeScoreResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      approveEffects: [link],
    });
    expect(env.effects).toHaveLength(2);
    expect(env.effects[0]).toBe(link);
    expect(env.effects[1]?.purpose).toBe('score-contest');
  });

  it('envelope.ok=false when score reverts', () => {
    const env = toContestScoreAgentEnvelope(
      makeScoreResult({ receipt: { status: 'reverted', blockNumber: 1000n } }),
      { chainId: POLYGON, signerAddress: SIGNER },
    );
    expect(env.ok).toBe(false);
    expect(env.effects[0]?.status).toBe('reverted');
  });
});
