/**
 * Unit tests for the v1 → v2 envelope transforms used by the
 * contest-lifecycle writes:
 *   - contests create (incl. approve-effect prepending for the USDC
 *     creation-fee allowance loop)
 *   - contests score (free under R5/CRE — no approval effects)
 *   - contests update-markets (free under R5/CRE — carries requestNonce)
 */

import { describe, expect, it } from 'vitest';
import type { AgentEffect, Hex } from '@ospex/sdk';
import {
  buildCreateContestEffect,
  toContestCreateAgentEnvelope,
} from '../src/commands/contests/create.js';
import {
  buildScoreContestEffect,
  toContestScoreAgentEnvelope,
} from '../src/commands/contests/score.js';
import { toContestUpdateMarketsAgentEnvelope } from '../src/commands/contests/update-markets.js';

const POLYGON = 137 as const;
const SIGNER: Hex = '0xaabbccddeeff00112233445566778899aabbccdd';

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

  it('prepends the USDC creation-fee approve effect before the create effect', () => {
    const usdc = approveUsdcEffect('0xusdc');
    const env = toContestCreateAgentEnvelope(makeCreateResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      verification: null,
      approveEffects: [usdc],
    });
    expect(env.effects).toHaveLength(2);
    expect(env.effects[0]).toBe(usdc);
    expect(env.effects[0]?.purpose).toBe('approve-usdc');
    expect(env.effects[1]?.purpose).toBe('create-contest');
  });

  it('envelope.ok=false when the approve reverted, even if create succeeded', () => {
    const reverted: AgentEffect = {
      ...approveUsdcEffect('0xusdc'),
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

// Review blocker: when waitForVerified throws AFTER the create
// tx landed, the action's --json path used to emit TWO envelopes
// (success then failure) AND the failure envelope omitted the
// create-contest tx. Fix extracted `buildCreateContestEffect` so the
// failure path can include it. These tests pin the helper's shape;
// the call-site test for the action's new single-envelope behavior
// lives in failure-envelope-scenarios.test.ts.
describe('buildCreateContestEffect', () => {
  it('builds a confirmed create-contest effect from a successful result', () => {
    const eff = buildCreateContestEffect({
      contestId: 9001n,
      txHash: '0xcreate',
      receipt: { status: 'success', blockNumber: 1000n } as never,
    } as never);
    expect(eff).toEqual({
      type: 'transaction',
      purpose: 'create-contest',
      ok: true,
      txHash: '0xcreate',
      blockNumber: '1000',
      status: 'confirmed',
    });
  });

  it('builds a reverted create-contest effect when receipt status is reverted', () => {
    const eff = buildCreateContestEffect({
      contestId: 9001n,
      txHash: '0xcreate',
      receipt: { status: 'reverted', blockNumber: 1000n } as never,
    } as never);
    expect(eff.ok).toBe(false);
    expect(eff.status).toBe('reverted');
  });
});

describe('toContestScoreAgentEnvelope', () => {
  function makeScoreResult(overrides: Record<string, unknown> = {}) {
    return {
      contestId: 9001n,
      txHash: '0xscore',
      receipt: { status: 'success', blockNumber: 1000n } as never,
      ...overrides,
    } as never;
  }

  it('action contests.score, single score-contest effect (free under CRE)', () => {
    const env = toContestScoreAgentEnvelope(makeScoreResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
    });
    expect(env.action).toBe('contests.score');
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('score-contest');
  });

  it('envelope.ok=false when score reverts', () => {
    const env = toContestScoreAgentEnvelope(
      makeScoreResult({ receipt: { status: 'reverted', blockNumber: 1000n } }),
      { chainId: POLYGON, signerAddress: SIGNER },
    );
    expect(env.ok).toBe(false);
    expect(env.effects[0]?.status).toBe('reverted');
  });

  it('payload.scoring is null for the fire-and-return call (no --wait)', () => {
    const env = toContestScoreAgentEnvelope(makeScoreResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
    });
    expect(env.payload.scoring).toBeNull();
    expect(env.warnings).toEqual([]);
  });

  it('payload carries the scoring block + real scores when --wait resolved Scored', () => {
    const env = toContestScoreAgentEnvelope(makeScoreResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      scoring: { contestId: 9001n, status: 'scored', awayScore: 4, homeScore: 2 },
    });
    expect(env.payload.scoring).toEqual({ status: 'scored', awayScore: 4, homeScore: 2 });
    expect(env.ok).toBe(true);
    expect(env.warnings).toEqual([]);
  });

  it('surfaces a 0-0 final as real scores (not null) when --wait resolved Scored', () => {
    const env = toContestScoreAgentEnvelope(makeScoreResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      scoring: { contestId: 9001n, status: 'scored', awayScore: 0, homeScore: 0 },
    });
    expect(env.payload.scoring).toEqual({ status: 'scored', awayScore: 0, homeScore: 0 });
  });

  it('voided --wait resolution: info warning, scoring.status=voided, envelope still ok', () => {
    const env = toContestScoreAgentEnvelope(makeScoreResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      scoring: { contestId: 9001n, status: 'voided', awayScore: null, homeScore: null },
    });
    expect(env.payload.scoring?.status).toBe('voided');
    expect(env.ok).toBe(true); // the score REQUEST tx succeeded; voided is a terminal outcome
    expect(env.warnings).toHaveLength(1);
    expect(env.warnings[0]?.code).toBe('contest-voided');
    expect(env.warnings[0]?.severity).toBe('info');
  });
});

describe('buildScoreContestEffect', () => {
  it('builds a confirmed score-contest effect from a successful result', () => {
    const eff = buildScoreContestEffect({
      contestId: 9001n,
      txHash: '0xscore',
      receipt: { status: 'success', blockNumber: 1000n } as never,
    } as never);
    expect(eff).toEqual({
      type: 'transaction',
      purpose: 'score-contest',
      ok: true,
      txHash: '0xscore',
      blockNumber: '1000',
      status: 'confirmed',
    });
  });

  it('builds a reverted score-contest effect when receipt status is reverted', () => {
    const eff = buildScoreContestEffect({
      contestId: 9001n,
      txHash: '0xscore',
      receipt: { status: 'reverted', blockNumber: 1000n } as never,
    } as never);
    expect(eff.ok).toBe(false);
    expect(eff.status).toBe('reverted');
  });
});

describe('toContestUpdateMarketsAgentEnvelope', () => {
  function makeUpdateResult(overrides: Record<string, unknown> = {}) {
    return {
      contestId: 9001n,
      requestNonce: 3n,
      txHash: '0xupdate',
      receipt: { status: 'success', blockNumber: 1000n } as never,
      ...overrides,
    } as never;
  }

  it('action contests.update-markets, single market-update-contest effect (free under CRE)', () => {
    const env = toContestUpdateMarketsAgentEnvelope(makeUpdateResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
    });
    expect(env.action).toBe('contests.update-markets');
    expect(env.stage).toBe('execute');
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('market-update-contest');
    expect(env.payload.contestId).toBe('9001');
    expect(env.payload.requestNonce).toBe('3');
  });

  it('nextCommands suggests verify-contest-odds', () => {
    const env = toContestUpdateMarketsAgentEnvelope(makeUpdateResult(), {
      chainId: POLYGON,
      signerAddress: SIGNER,
    });
    expect(env.nextCommands[0]?.id).toBe('verify-contest-odds');
    expect(env.nextCommands[0]?.argv).toContain('9001');
  });

  it('envelope.ok=false when the update reverts', () => {
    const env = toContestUpdateMarketsAgentEnvelope(
      makeUpdateResult({ receipt: { status: 'reverted', blockNumber: 1000n } }),
      { chainId: POLYGON, signerAddress: SIGNER },
    );
    expect(env.ok).toBe(false);
    expect(env.effects[0]?.status).toBe('reverted');
  });
});
