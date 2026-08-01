/**
 * Failure-envelope coverage scenarios for the v2 failure envelope.
 *
 * Pins the three scenarios the reviewer listed in the PR thread:
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
import { scoreContestEffectFromError } from '../src/commands/contests/score.js';

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

describe('failure-envelope scenario 1: validation failure before side effects', () => {
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

describe('failure-envelope scenario 2: preflight/RPC/API failure before side effects', () => {
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

  it('surfaces commitmentHash in details when a submit POST failed after the hash was computed (#7 / H2)', () => {
    // An ambiguous submit POST failure (e.g. a gateway timeout after the server
    // may have inserted the row) carries the locally-computed commitment hash on
    // the OspexAPIError. The failure envelope must surface it at
    // errors[0].details.commitmentHash so an agent can probe
    // `commitments show <hash>` before retrying, instead of blindly re-submitting.
    const HASH = '0x' + 'ab'.repeat(32);
    const stdout = captureStdout(() => {
      emitJsonFailure({
        action: 'commitments.submit',
        stage: 'execute',
        chainId: POLYGON,
        wallet: SIGNER,
        walletRole: 'signer',
        signer: SIGNER,
        requiresSignature: true,
        requiresTransaction: false,
        error: new OspexAPIError('gateway timeout', { status: 504, commitmentHash: HASH }),
      });
    });
    const env = parseEnvelope(stdout);
    expect(env.ok).toBe(false);
    expect(env.errors[0]?.code).toBe('API_ERROR');
    expect(env.errors[0]?.details).toMatchObject({ status: 504, commitmentHash: HASH });
  });
});

describe('failure-envelope scenario 3: mid-flight failure after one successful effect', () => {
  it('preserves the already-confirmed approve tx in effects[] when submit then throws', () => {
    // This is the critical regression the reviewer asked for: a
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

  it('preserves the contests create approve effect when the create tx itself reverts', () => {
    // contests create's retry loop may run the USDC creation-fee approve
    // successfully, then the actual createContestAndRequestVerify reverts.
    // The approve must still appear in the failure envelope's effects[].
    // (R5/CRE: USDC is the only approval — no LINK payment.)
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
        effects: [usdcApprove],
        error: new OspexChainError('createContestAndRequestVerify reverted'),
      });
    });
    const env = parseEnvelope(stdout);
    expect(env.effects).toHaveLength(1);
    expect(env.effects[0]?.purpose).toBe('approve-usdc');
    expect(env.effects.every((e) => e.ok)).toBe(true); // the approve landed
    expect(env.errors[0]?.code).toBe('CHAIN_ERROR');
  });

  // review blocker regression: when contests create's verification
  // poll throws AFTER the create tx landed, the action used to write
  // the success envelope first and THEN throw — producing TWO envelopes
  // on stdout and a failure envelope that omitted the create tx. Fix:
  // single failure envelope that preserves both the approve(s) AND the
  // successful create-contest tx. This test exercises the exact wire
  // shape contests/create.ts's fixed action passes to emitJsonFailure,
  // and asserts a single JSON envelope on stdout with all effects
  // intact.
  // Per-command write-intent coverage: every named write command MUST
  // emit a failure envelope that advertises the write-intent flags +
  // populated signer (the AGENT_ENVELOPE_SPEC §6 contract). Without
  // this, a failure looks like a no-op read to recovery logic. These
  // tests exercise the args each command's catch passes to
  // emitJsonFailure after the rollout fix — submit, match, claim,
  // settle, claim-all, cancel-onchain, approve, contests create/score
  // are all required to set requiresSignature: true and
  // requiresTransaction: true on failure.
  describe.each([
    { action: 'commitments.match', stage: 'execute' as const },
    { action: 'commitments.cancel-onchain', stage: 'execute' as const },
    { action: 'commitments.cancel-all', stage: 'execute' as const },
    { action: 'commitments.approve', stage: 'execute' as const },
    { action: 'commitments.approve-raw', stage: 'execute' as const },
    { action: 'approvals.setup', stage: 'execute' as const },
    { action: 'contests.create', stage: 'execute' as const },
    { action: 'contests.score', stage: 'execute' as const },
    { action: 'claim', stage: 'execute' as const },
    { action: 'settle', stage: 'execute' as const },
    { action: 'claim-all', stage: 'execute' as const },
    // commitments.submit + commitments.cancel are NOT in this list —
    // their requiresTransaction is path-specific, not blanket. See
    // their dedicated scenario blocks below.
  ])('write-command failure envelope advertises write intent ($action)', ({ action, stage }) => {
    it('sets requiresSignature, requiresTransaction, wallet, signer on a pre-effect failure', () => {
      const stdout = captureStdout(() => {
        emitJsonFailure({
          action,
          stage,
          chainId: POLYGON,
          wallet: SIGNER,
          walletRole: 'signer',
          signer: SIGNER,
          // The exact flag pair the per-command catch now passes after
          // the spec-§6 rollout. Without these on every write-command
          // catch, the spec's MUST clause becomes false at HEAD.
          requiresSignature: true,
          requiresTransaction: true,
          error: new OspexChainError('Transaction broadcast or inclusion failed.'),
        });
      });
      const env = JSON.parse(stdout.trim()) as {
        ok: boolean;
        action: string;
        stage: string;
        wallet: string | null;
        signer: string | null;
        requiresSignature: boolean;
        requiresTransaction: boolean;
        effects: unknown[];
      };
      expect(env.ok).toBe(false);
      expect(env.action).toBe(action);
      expect(env.stage).toBe(stage);
      expect(env.wallet).toBe(SIGNER);
      expect(env.signer).toBe(SIGNER);
      expect(env.requiresSignature).toBe(true);
      expect(env.requiresTransaction).toBe(true);
      expect(env.effects).toEqual([]);
    });
  });

  // The cancel command has a distinct flag matrix: EIP-712 cancel-auth
  // is always signed, but the on-chain tx only runs with --also-onchain.
  // The catch reflects that — requiresTransaction tracks `wantsOnchain`.
  it('commitments.cancel — sig:true always, tx:true only with --also-onchain', () => {
    for (const wantsOnchain of [true, false]) {
      const stdout = captureStdout(() => {
        emitJsonFailure({
          action: 'commitments.cancel',
          stage: 'execute',
          chainId: POLYGON,
          wallet: SIGNER,
          walletRole: 'signer',
          signer: SIGNER,
          requiresSignature: true,
          requiresTransaction: wantsOnchain,
          error: new OspexChainError('cancel failed'),
        });
      });
      const env = JSON.parse(stdout.trim()) as {
        requiresSignature: boolean;
        requiresTransaction: boolean;
      };
      expect(env.requiresSignature).toBe(true);
      expect(env.requiresTransaction).toBe(wantsOnchain);
    }
  });

  // submit is fundamentally an off-chain signed write (EIP-712 + POST).
  // requiresTransaction should be true ONLY when an approval tx was
  // attempted in this run — blanket-true would mislead an agent into
  // wasting a chain check on a pure off-chain failure path.
  describe('commitments.submit — requiresTransaction is path-specific', () => {
    it('preview failure (no --yes): sig:true, tx:false, signer-intent context preserved', () => {
      // The preview path can't dispatch a tx — it's a read+compute
      // over `prepareSubmit`. Any failure here (API down, validation)
      // is sig-intent only. Per spec §3.2, preview-only sign
      // envelopes still carry walletRole:'signer' and signer=wallet
      // (the resolved-no-unlock address is the would-be signer).
      const stdout = captureStdout(() => {
        emitJsonFailure({
          action: 'commitments.submit',
          stage: 'preview',
          chainId: POLYGON,
          wallet: SIGNER,
          walletRole: 'signer',
          signer: SIGNER,
          requiresSignature: true,
          // No approval was attempted (the preview path doesn't enter
          // the approval branch) — tx flag stays false.
          requiresTransaction: false,
          error: new OspexAPIError('API unreachable'),
        });
      });
      const env = JSON.parse(stdout.trim()) as {
        wallet: string | null;
        walletRole: string;
        signer: string | null;
        requiresSignature: boolean;
        requiresTransaction: boolean;
      };
      expect(env.requiresSignature).toBe(true);
      expect(env.requiresTransaction).toBe(false);
      // Contract: preview-only failure mirrors preview-only success
      // (walletRole:'signer', signer=wallet) — see spec §3.2.
      expect(env.wallet).toBe(SIGNER);
      expect(env.walletRole).toBe('signer');
      expect(env.signer).toBe(SIGNER);
    });

    it('execute failure with no approval needed: sig:true, tx:false', () => {
      // `--yes --json` happy-path entry, but allowance is already
      // sufficient → no approval tx attempted. Sign+POST fails (e.g.
      // NONCE_TOO_LOW). The failure envelope still carries no tx intent
      // because no tx was attempted.
      const stdout = captureStdout(() => {
        emitJsonFailure({
          action: 'commitments.submit',
          stage: 'execute',
          chainId: POLYGON,
          wallet: SIGNER,
          walletRole: 'signer',
          signer: SIGNER,
          requiresSignature: true,
          requiresTransaction: false,
          error: new OspexAPIError('NONCE_TOO_LOW', {
            status: 409,
            apiCode: 'NONCE_TOO_LOW',
          }),
        });
      });
      const env = JSON.parse(stdout.trim()) as {
        requiresSignature: boolean;
        requiresTransaction: boolean;
      };
      expect(env.requiresSignature).toBe(true);
      expect(env.requiresTransaction).toBe(false);
    });

    it('execute failure with approval landed before throw: sig:true, tx:true', () => {
      // Approval tx confirmed, then the sign+POST throws. The approval
      // landed; agents need to know about the on-chain side effect.
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
          requiresSignature: true,
          requiresTransaction: true,
          effects: [confirmedApprove],
          error: new OspexAPIError('NONCE_TOO_LOW', {
            status: 409,
            apiCode: 'NONCE_TOO_LOW',
          }),
        });
      });
      const env = JSON.parse(stdout.trim()) as {
        requiresSignature: boolean;
        requiresTransaction: boolean;
        effects: Array<{ purpose: string }>;
      };
      expect(env.requiresSignature).toBe(true);
      expect(env.requiresTransaction).toBe(true);
      // The landed approval tx is preserved in effects[].
      expect(env.effects[0]?.purpose).toBe('approve-usdc');
    });
  });

  // claim-all has two failure shapes with distinct envelope context:
  // signer mode (wallet=signer, role='signer') and explicit-address
  // dry-run (wallet=address, role='subject', signer=null). The
  // requires* intent flags must NOT collapse to false in the
  // signer-free dry-run path — the dry-run plan describes a write.
  describe('positions claim-all — dry-run + signer separation', () => {
    it('--dry-run --address: subject context + write intent preserved on failure', () => {
      // Explicit-address dry-run runs signer-free. Failure during the
      // planning API call must STILL advertise sig + tx intent (the
      // dry-run is showing what WOULD have signed/sent), and the
      // address belongs in `wallet` (role='subject'), not `null`.
      const ADDRESS = '0x' + 'cd'.repeat(20);
      const stdout = captureStdout(() => {
        emitJsonFailure({
          action: 'claim-all',
          stage: 'dry-run',
          chainId: POLYGON,
          wallet: ADDRESS as Hex,
          walletRole: 'subject',
          signer: null,
          requiresSignature: true,
          requiresTransaction: true,
          error: new OspexAPIError('API unreachable'),
        });
      });
      const env = JSON.parse(stdout.trim()) as {
        stage: string;
        wallet: string | null;
        walletRole: string;
        signer: string | null;
        requiresSignature: boolean;
        requiresTransaction: boolean;
      };
      expect(env.stage).toBe('dry-run');
      expect(env.wallet).toBe(ADDRESS);
      expect(env.walletRole).toBe('subject');
      expect(env.signer).toBeNull();
      expect(env.requiresSignature).toBe(true);
      expect(env.requiresTransaction).toBe(true);
    });

    it('signer mode (no --address): wallet=signer, role=signer, both flags true', () => {
      const stdout = captureStdout(() => {
        emitJsonFailure({
          action: 'claim-all',
          stage: 'execute',
          chainId: POLYGON,
          wallet: SIGNER,
          walletRole: 'signer',
          signer: SIGNER,
          requiresSignature: true,
          requiresTransaction: true,
          error: new OspexAPIError('API unreachable'),
        });
      });
      const env = JSON.parse(stdout.trim()) as {
        wallet: string | null;
        walletRole: string;
        signer: string | null;
      };
      expect(env.wallet).toBe(SIGNER);
      expect(env.walletRole).toBe('signer');
      expect(env.signer).toBe(SIGNER);
    });
  });

  it('contests create: verification fails AFTER create tx — single envelope with create-contest preserved', () => {
    const usdcApprove: AgentEffect = {
      type: 'transaction',
      purpose: 'approve-usdc',
      ok: true,
      txHash: '0xusdc' as Hex,
      blockNumber: '999',
      status: 'confirmed',
    };
    const createContestEffect: AgentEffect = {
      type: 'transaction',
      purpose: 'create-contest',
      ok: true,
      txHash: '0xcreate' as Hex,
      blockNumber: '1000',
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
        effects: [usdcApprove, createContestEffect],
        // waitForVerified timed out / threw after the create tx landed.
        // The error here is whatever waitForVerified surfaced.
        error: new OspexChainError(
          'Verification did not complete within timeout (120s).',
        ),
      });
    });
    // Single JSON envelope on stdout (the review contract).
    const trimmed = stdout.trim();
    expect(() => JSON.parse(trimmed)).not.toThrow();
    // Confirm there's only one object (no second envelope appended).
    expect(trimmed.match(/\}\s*\{/)).toBeNull();
    const env = parseEnvelope(trimmed);
    expect(env.ok).toBe(false);
    expect(env.action).toBe('contests.create');
    expect(env.effects).toHaveLength(2);
    expect(env.effects[0]?.purpose).toBe('approve-usdc');
    expect(env.effects[0]?.ok).toBe(true);
    // The create tx — the bit the review flagged as missing.
    expect(env.effects[1]?.purpose).toBe('create-contest');
    expect(env.effects[1]?.ok).toBe(true);
    expect(env.effects[1]?.txHash).toBe('0xcreate');
    expect(env.effects[1]?.status).toBe('confirmed');
    expect(env.errors[0]?.code).toBe('CHAIN_ERROR');
  });

  it('contests score --wait: scoring poll fails AFTER the score tx (and re-request) — single envelope with score-contest preserved', () => {
    // `score --wait` sent requestScore (confirmed), the CRE report didn't
    // land within the first window, a re-request was sent, and the second
    // poll ALSO timed out. The action must emit exactly ONE failure
    // envelope that preserves the confirmed score-contest tx — mirroring
    // the create wait-timeout contract (no double envelope; the landed tx
    // is not dropped to stderr).
    // Both on-chain score txs are recorded: the first requestScore AND the auto
    // re-request the command sent after the first callback dropped (Hermes PR172
    // blocker 1 — the execute-envelope ledger must not drop the second tx).
    const mkScoreEffect = (txHash: string): AgentEffect => ({
      type: 'transaction',
      purpose: 'score-contest',
      ok: true,
      txHash: txHash as Hex,
      blockNumber: '1000',
      status: 'confirmed',
    });
    const stdout = captureStdout(() => {
      emitJsonFailure({
        action: 'contests.score',
        stage: 'execute',
        chainId: POLYGON,
        wallet: SIGNER,
        walletRole: 'signer',
        signer: SIGNER,
        requiresSignature: true,
        requiresTransaction: true,
        effects: [mkScoreEffect('0xscore'), mkScoreEffect('0xrerequest')],
        error: new OspexChainError('Contest 9001 did not reach Scored within 120000 ms.'),
      });
    });
    const trimmed = stdout.trim();
    expect(() => JSON.parse(trimmed)).not.toThrow();
    // Single envelope — no second object appended.
    expect(trimmed.match(/\}\s*\{/)).toBeNull();
    const env = parseEnvelope(trimmed);
    expect(env.ok).toBe(false);
    expect(env.action).toBe('contests.score');
    // Both score txs preserved in the ledger, single envelope.
    expect(env.effects).toHaveLength(2);
    expect(env.effects.map((e) => e.purpose)).toEqual(['score-contest', 'score-contest']);
    expect(env.effects.map((e) => e.txHash)).toEqual(['0xscore', '0xrerequest']);
    expect(env.effects.every((e) => e.ok && e.status === 'confirmed')).toBe(true);
    expect(env.errors[0]?.code).toBe('CHAIN_ERROR');
  });

  // The INITIAL requestScore tx failing AFTER broadcast (the command's outer catch) —
  // reverted on inclusion or receipt-unobserved — must land in effects[], not only in
  // errors[].details.txHash (Hermes PR172 re-review; same ledger invariant as the re-request).
  it.each([
    {
      label: 'initial score reverted on inclusion (txHash + reverted receipt)',
      err: new OspexChainError('Transaction reverted on-chain.', {
        txHash: '0xrev',
        receipt: { status: 'reverted', blockNumber: 4242n } as never,
      }),
      status: 'reverted' as const,
      txHash: '0xrev',
    },
    {
      label: 'initial score broadcast but receipt unobserved (txHash, no receipt)',
      err: new OspexChainError('broadcast but receipt wait failed', { txHash: '0xpending' }),
      status: 'submitted' as const,
      txHash: '0xpending',
    },
  ])('contests score --json: $label → the broadcast tx is preserved in effects[]', ({ err, status, txHash }) => {
    // Mirrors the command's outer catch: build the effect from the thrown error and pass it.
    const effect = scoreContestEffectFromError(err);
    const stdout = captureStdout(() => {
      emitJsonFailure({
        action: 'contests.score',
        stage: 'execute',
        chainId: POLYGON,
        wallet: SIGNER,
        walletRole: 'signer',
        signer: SIGNER,
        requiresSignature: true,
        requiresTransaction: true,
        effects: effect ? [effect] : [],
        error: err,
      });
    });
    const env = parseEnvelope(stdout.trim());
    expect(env.ok).toBe(false);
    expect(env.effects).toHaveLength(1); // the broadcast tx is in the LEDGER, not dropped
    expect(env.effects[0]).toMatchObject({ purpose: 'score-contest', ok: false, txHash, status });
    expect(env.errors[0]?.code).toBe('CHAIN_ERROR');
  });

  it('contests score --json: a pre-broadcast / signer failure (no txHash) carries NO effect (nothing was broadcast)', () => {
    const err = new OspexChainError('Pre-send chain reads failed (nonce read): rpc down');
    expect(scoreContestEffectFromError(err)).toBeNull();
    const effect = scoreContestEffectFromError(err);
    const stdout = captureStdout(() => {
      emitJsonFailure({
        action: 'contests.score',
        stage: 'execute',
        chainId: POLYGON,
        wallet: SIGNER,
        walletRole: 'signer',
        signer: SIGNER,
        requiresSignature: true,
        requiresTransaction: true,
        effects: effect ? [effect] : [],
        error: err,
      });
    });
    expect(parseEnvelope(stdout.trim()).effects).toEqual([]);
  });
});
