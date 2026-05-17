/**
 * Hermes PR-6 coverage scenarios for the v2 failure envelope.
 *
 * Pins the three scenarios Hermes listed in the PR-70 thread:
 *   1. Validation failure BEFORE side effects → ok:false, no
 *      effects[], typed code (e.g. VALIDATION_ERROR).
 *   2. Preflight/RPC/API failure BEFORE side effects → ok:false,
 *      no effects[], typed code (e.g. ALLOWANCE_INSUFFICIENT,
 *      API_ERROR) with structured details surfaced.
 *   3. Mid-flight failure AFTER one successful effect → ok:false,
 *      the already-confirmed effect IS preserved in effects[]
 *      (proves the envelope didn't drop the side effect back to
 *      stderr).
 *
 * Each scenario is exercised against `emitJsonFailure` (the
 * per-command catch path) by capturing stdout and parsing the
 * emitted envelope. Command-level wiring is covered by the per-
 * command catch blocks in src/commands/*.ts; verification that
 * those catch blocks call into emitJsonFailure with the right
 * context lives in the call-site code review surface (each catch
 * block is a small, uniform pattern).
 */

import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import {
  OspexAllowanceError,
  OspexAPIError,
  OspexChainError,
  OspexValidationError,
  type AgentEffect,
  type Hex,
} from '@ospex/sdk';
import { emitJsonFailure } from '../src/lib/agentEnvelope.js';

const POLYGON = 137 as const;
const SIGNER: Hex = '0xaabbccddeeff00112233445566778899aabbccdd';

class StringSink extends Writable {
  buf = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.buf += chunk.toString();
    cb();
  }
}

/**
 * Run a closure with process.stdout replaced by a capturing sink.
 * Restores in finally so unrelated tests aren't affected.
 */
function captureStdout(fn: () => void): string {
  const sink = new StringSink();
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Buffer) => {
    sink.write(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return sink.buf;
}

interface ParsedEnvelope {
  schemaVersion: number;
  ok: boolean;
  action: string;
  stage: string;
  errors: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
  effects: Array<{
    type: string;
    purpose: string;
    ok: boolean;
    txHash?: string;
    status?: string;
  }>;
  wallet: string | null;
  walletRole: string;
}

function parseEnvelope(stdout: string): ParsedEnvelope {
  return JSON.parse(stdout.trim()) as ParsedEnvelope;
}

describe('Hermes PR-6 scenario 1: validation failure before side effects', () => {
  it('emits a v2 failure envelope with VALIDATION_ERROR code and empty effects[]', () => {
    const stdout = captureStdout(() => {
      emitJsonFailure({
        action: 'commitments.submit',
        stage: 'preview',
        chainId: POLYGON,
        wallet: SIGNER,
        walletRole: 'signer',
        signer: SIGNER,
        // Validation error caught after getClient() but before any
        // on-chain action — e.g. invalid USDC decimal that
        // prepareSubmit's resolver throws on.
        error: new OspexValidationError(
          'risk-usdc must be a positive decimal with at most 6 fractional digits.',
          { field: 'riskUsdc' },
        ),
      });
    });
    const env = parseEnvelope(stdout);
    expect(env.schemaVersion).toBe(2);
    expect(env.ok).toBe(false);
    expect(env.action).toBe('commitments.submit');
    expect(env.stage).toBe('preview');
    expect(env.effects).toEqual([]);
    expect(env.errors).toHaveLength(1);
    expect(env.errors[0]?.code).toBe('VALIDATION_ERROR');
    expect(env.errors[0]?.details).toMatchObject({ field: 'riskUsdc' });
  });
});

describe('Hermes PR-6 scenario 2: preflight/RPC/API failure before side effects', () => {
  it('emits a v2 failure envelope for ALLOWANCE_INSUFFICIENT with structured details', () => {
    const stdout = captureStdout(() => {
      emitJsonFailure({
        action: 'commitments.submit',
        stage: 'execute',
        chainId: POLYGON,
        wallet: SIGNER,
        walletRole: 'signer',
        signer: SIGNER,
        // Preflight throws before any tx is sent — e.g. allowance
        // shortfall surfaced by prepareSubmit's allowance read.
        error: new OspexAllowanceError(
          'USDC allowance for PositionModule is short of riskAmount.',
          {
            required: 25_000_000n,
            current: 0n,
            spender: '0x0DCd42f8609cd7884ddBa3481b03a78dfc88366c' as Hex,
            token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as Hex,
          },
        ),
      });
    });
    const env = parseEnvelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.effects).toEqual([]); // no on-chain tx yet
    expect(env.errors[0]?.code).toBe('ALLOWANCE_INSUFFICIENT');
    expect(env.errors[0]?.details).toMatchObject({
      required: '25000000',
      current: '0',
      // spender / token addresses surface verbatim
    });
  });

  it('emits a v2 failure envelope for API_ERROR with status + apiCode', () => {
    const stdout = captureStdout(() => {
      emitJsonFailure({
        action: 'commitments.list',
        stage: 'read',
        chainId: POLYGON,
        error: new OspexAPIError('Rate limited.', {
          status: 429,
          apiCode: 'RATE_LIMITED',
        }),
      });
    });
    const env = parseEnvelope(stdout);
    expect(env.errors[0]?.code).toBe('API_ERROR');
    expect(env.errors[0]?.details).toMatchObject({ status: 429, apiCode: 'RATE_LIMITED' });
    expect(env.effects).toEqual([]);
  });
});

describe('Hermes PR-6 scenario 3: mid-flight failure after one successful effect', () => {
  it('preserves the already-confirmed approve tx in effects[] when submit then throws', () => {
    // This is the critical regression Hermes asked for: a
    // `commitments submit --yes --json` invocation that successfully
    // sent a USDC approve tx (commitment-risk), then `submitPrepared`
    // throws NONCE_TOO_LOW. The approve tx hash MUST land in the
    // failure envelope's effects[] so the agent can reconcile against
    // the on-chain state.
    const confirmedApprove: AgentEffect = {
      type: 'transaction',
      purpose: 'approve-usdc',
      ok: true,
      txHash: '0xapprove' as Hex,
      blockNumber: '1000',
      status: 'confirmed',
    };
    const stdout = captureStdout(() => {
      emitJsonFailure({
        action: 'commitments.submit',
        stage: 'execute',
        chainId: POLYGON,
        wallet: SIGNER,
        walletRole: 'signer',
        signer: SIGNER,
        effects: [confirmedApprove],
        error: new OspexAPIError('NONCE_TOO_LOW: maker activity moved.', {
          status: 409,
          apiCode: 'NONCE_TOO_LOW',
        }),
      });
    });
    const env = parseEnvelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('approve-usdc');
    expect(env.effects[0]?.txHash).toBe('0xapprove');
    expect(env.effects[0]?.ok).toBe(true);
    expect(env.effects[0]?.status).toBe('confirmed');
    expect(env.errors[0]?.code).toBe('API_ERROR');
    expect(env.errors[0]?.details).toMatchObject({ apiCode: 'NONCE_TOO_LOW' });
  });

  it('preserves a settle tx + reports the claim failure when claim-all entry partials', () => {
    // The claim-all variant of the same contract: settle tx confirmed,
    // claim threw on the SAME entry. emitJsonFailure called with the
    // confirmed settle tx in effects, plus a failure marker for the
    // failed claim step.
    const settleEffect: AgentEffect = {
      type: 'transaction',
      purpose: 'settle-speculation',
      ok: true,
      txHash: '0xsettle' as Hex,
      status: 'confirmed',
    };
    const claimFailureEffect: AgentEffect = {
      type: 'transaction',
      purpose: 'claim-position',
      ok: false,
      txHash: '0xrevertedclaim' as Hex,
      status: 'reverted',
      errorCode: 'CHAIN_ERROR',
    };
    const stdout = captureStdout(() => {
      emitJsonFailure({
        action: 'claim-all',
        stage: 'execute',
        chainId: POLYGON,
        wallet: SIGNER,
        walletRole: 'signer',
        signer: SIGNER,
        effects: [settleEffect, claimFailureEffect],
        error: new OspexChainError('claim reverted', {
          reason: 'NotCommitmentMaker',
          txHash: '0xrevertedclaim',
        }),
      });
    });
    const env = parseEnvelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.effects).toHaveLength(2);
    expect(env.effects[0]?.purpose).toBe('settle-speculation');
    expect(env.effects[0]?.ok).toBe(true);
    expect(env.effects[0]?.status).toBe('confirmed');
    expect(env.effects[1]?.purpose).toBe('claim-position');
    expect(env.effects[1]?.ok).toBe(false);
    expect(env.effects[1]?.status).toBe('reverted');
    expect(env.errors[0]?.code).toBe('CHAIN_ERROR');
    expect(env.errors[0]?.details).toMatchObject({
      reason: 'NotCommitmentMaker',
      txHash: '0xrevertedclaim',
    });
  });

  it('preserves contests create approve effects when the create tx itself reverts', () => {
    // contests create's retry loop may run LINK + USDC approves
    // successfully, then the actual createContestFromOracle reverts
    // (e.g. Chainlink subscription not funded). Both approves must
    // appear in the failure envelope's effects[].
    const linkApprove: AgentEffect = {
      type: 'transaction',
      purpose: 'approve-link',
      ok: true,
      txHash: '0xlink' as Hex,
      status: 'confirmed',
    };
    const usdcApprove: AgentEffect = {
      type: 'transaction',
      purpose: 'approve-usdc',
      ok: true,
      txHash: '0xusdc' as Hex,
      status: 'confirmed',
    };
    const stdout = captureStdout(() => {
      emitJsonFailure({
        action: 'contests.create',
        stage: 'execute',
        chainId: POLYGON,
        wallet: SIGNER,
        walletRole: 'signer',
        signer: SIGNER,
        effects: [linkApprove, usdcApprove],
        error: new OspexChainError('createContestFromOracle reverted', {
          reason: 'ScriptApprovalExpired',
        }),
      });
    });
    const env = parseEnvelope(stdout);
    expect(env.effects).toHaveLength(2);
    expect(env.effects[0]?.purpose).toBe('approve-link');
    expect(env.effects[1]?.purpose).toBe('approve-usdc');
    expect(env.effects.every((e) => e.ok)).toBe(true); // both approves landed
    expect(env.errors[0]?.code).toBe('CHAIN_ERROR');
    expect(env.errors[0]?.details).toMatchObject({ reason: 'ScriptApprovalExpired' });
  });
});
