/**
 * Unit tests for the v1 → v2 envelope transforms used by the
 * contest-lifecycle writes:
 *   - contests create (incl. approve-effect prepending for the USDC
 *     creation-fee allowance loop)
 *   - contests score (free under R5/CRE — no approval effects)
 *   - contests update-markets (free under R5/CRE — carries requestNonce)
 */

import { describe, expect, it } from 'vitest';
import { OspexChainError, type AgentEffect, type Hex } from '@ospex/sdk';
import {
  buildCreateContestEffect,
  toContestCreateAgentEnvelope,
} from '../src/commands/contests/create.js';
import {
  buildReRequestScoreEffect,
  buildScoreContestEffect,
  toContestScoreAgentEnvelope,
} from '../src/commands/contests/score.js';
import { toContestUpdateMarketsAgentEnvelope } from '../src/commands/contests/update-markets.js';

const POLYGON = 137 as const;
const SIGNER: Hex = '0xaabbccddeeff00112233445566778899aabbccdd';

// The re-request `score()` error shapes the ledger must preserve when a tx was broadcast.
const SCORE_REVERTED_ERR = new OspexChainError('Transaction reverted on-chain.', {
  txHash: '0xrev',
  receipt: { status: 'reverted', blockNumber: 1234n } as never,
});
const SCORE_UNKNOWN_ERR = new OspexChainError('broadcast but receipt wait failed', { txHash: '0xpending' });
const SCORE_PRE_BROADCAST_ERR = new OspexChainError('Pre-send chain reads failed (nonce read): rpc down');

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

  it('records a SECOND score-contest effect when --wait auto-re-requested and that tx landed', () => {
    const env = toContestScoreAgentEnvelope(makeScoreResult({ txHash: '0xfirst' }), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      scoring: { contestId: 9001n, status: 'scored', awayScore: 4, homeScore: 2 },
      reRequestResult: makeScoreResult({ txHash: '0xrerequest' }),
    });
    // Both on-chain score txs are in the effects[] ledger (the execute-envelope
    // side-effect contract records every write the command performed).
    expect(env.effects).toHaveLength(2);
    expect(env.effects.map((e) => e.purpose)).toEqual(['score-contest', 'score-contest']);
    expect(env.effects.map((e) => e.txHash)).toEqual(['0xfirst', '0xrerequest']);
  });

  it('records a re-request that THREW-after-broadcast (reverted) as a SECOND score-contest effect — a broadcast tx is never dropped from the ledger (Hermes PR172 re-review)', () => {
    const env = toContestScoreAgentEnvelope(makeScoreResult({ txHash: '0xfirst' }), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      scoring: { contestId: 9001n, status: 'scored', awayScore: 4, homeScore: 2 },
      reRequestError: SCORE_REVERTED_ERR, // the re-request broadcast a tx that reverted on inclusion
    });
    expect(env.effects).toHaveLength(2);
    expect(env.effects[1]).toMatchObject({ purpose: 'score-contest', ok: false, txHash: '0xrev', status: 'reverted' });
    expect(env.ok).toBe(true); // the FIRST requestScore tx succeeded — a reverted re-request doesn't flip the envelope
  });

  it('keeps a single score-contest effect when --wait did NOT re-request (reRequestResult null)', () => {
    const env = toContestScoreAgentEnvelope(makeScoreResult({ txHash: '0xfirst' }), {
      chainId: POLYGON,
      signerAddress: SIGNER,
      scoring: { contestId: 9001n, status: 'scored', awayScore: 4, homeScore: 2 },
      reRequestResult: null,
    });
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.txHash).toBe('0xfirst');
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

describe('buildReRequestScoreEffect (the auto re-request effect, from a resolved result OR a thrown OspexChainError)', () => {
  it('resolved re-request → a confirmed score-contest effect', () => {
    const eff = buildReRequestScoreEffect(
      { contestId: 9001n, txHash: '0xok', receipt: { status: 'success', blockNumber: 2000n } as never } as never,
      null,
    );
    expect(eff).toMatchObject({ purpose: 'score-contest', ok: true, txHash: '0xok', status: 'confirmed', blockNumber: '2000' });
  });

  it('re-request REVERTED on inclusion (txHash + reverted receipt) → recorded as a reverted, ok:false effect — NOT dropped', () => {
    const eff = buildReRequestScoreEffect(null, SCORE_REVERTED_ERR);
    expect(eff).toMatchObject({ purpose: 'score-contest', ok: false, txHash: '0xrev', status: 'reverted', blockNumber: '1234' });
    expect(eff?.errorCode).toBe('CHAIN_ERROR');
  });

  it('re-request BROADCAST but receipt unobserved (txHash, no receipt) → recorded as a submitted, ok:false effect — NOT dropped', () => {
    const eff = buildReRequestScoreEffect(null, SCORE_UNKNOWN_ERR);
    expect(eff).toMatchObject({ purpose: 'score-contest', ok: false, txHash: '0xpending', status: 'submitted' });
    expect(eff?.blockNumber).toBeUndefined(); // never confirmed → no block number
    expect(eff?.errorCode).toBe('CHAIN_ERROR');
  });

  it('PRE-BROADCAST re-request failure (no txHash) / non-chain error / no error → null (no tx broadcast → nothing to record)', () => {
    expect(buildReRequestScoreEffect(null, SCORE_PRE_BROADCAST_ERR)).toBeNull();
    expect(buildReRequestScoreEffect(null, new Error('plain non-chain error'))).toBeNull();
    expect(buildReRequestScoreEffect(null, null)).toBeNull();
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
