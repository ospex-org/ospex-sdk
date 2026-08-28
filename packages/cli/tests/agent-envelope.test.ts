import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type {
  AgentEnvelope,
  AgentError,
  AgentErrorCauseEntry,
  AgentWarning,
  ApprovalRequirement,
} from '@ospex/sdk';
import { OspexAllowanceError, OspexAPIError, OspexChainError, OspexValidationError } from '@ospex/sdk';
import {
  CLI_VERSION,
  MAX_CAUSE_CHAIN_DEPTH,
  MAX_NEXT_COMMANDS,
  SDK_VERSION,
  buildAgentEnvelope,
  buildFailureEnvelope,
  emitJsonFailure,
  emitJsonSuccess,
  errorToAgentError,
  networkForChainId,
  withReadFailureEnvelope,
  writeAgentEnvelope,
} from '../src/lib/agentEnvelope.js';

/** Stands in for process termination so a `process.exit(1)` stops the body without killing vitest. */
class ExitCalled extends Error {}

class StringSink extends Writable {
  buf = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.buf += chunk.toString();
    cb();
  }
}

const BASE_REQUIRED = {
  ok: true,
  action: 'health',
  stage: 'read' as const,
  network: 'polygon' as const,
  chainId: 137 as const,
  payload: { status: 'ok' },
};

describe('buildAgentEnvelope', () => {
  it('produces the full v2 shape with all defaults applied', () => {
    const env = buildAgentEnvelope(BASE_REQUIRED);
    expect(env.schemaVersion).toBe(2);
    expect(env.ok).toBe(true);
    expect(env.action).toBe('health');
    expect(env.stage).toBe('read');
    expect(env.network).toBe('polygon');
    expect(env.chainId).toBe(137);
    expect(env.wallet).toBeNull();
    expect(env.walletRole).toBe('none');
    expect(env.signer).toBeNull();
    expect(env.requiresSignature).toBe(false);
    expect(env.requiresTransaction).toBe(false);
    expect(env.approvalRequirements).toEqual([]);
    expect(env.estimatedCosts).toBeNull();
    expect(env.risk).toBeNull();
    expect(env.payout).toBeNull();
    expect(env.contest).toBeNull();
    expect(env.speculation).toBeNull();
    expect(env.commitment).toBeNull();
    expect(env.sideSummary).toBeNull();
    expect(env.warnings).toEqual([]);
    expect(env.errors).toEqual([]);
    expect(env.effects).toEqual([]);
    expect(env.nextCommands).toEqual([]);
    expect(env.payload).toEqual({ status: 'ok' });
  });

  it('stamps generatedAt as a valid ISO-8601 string by default', () => {
    const env = buildAgentEnvelope(BASE_REQUIRED);
    const parsed = Date.parse(env.generatedAt);
    expect(Number.isNaN(parsed)).toBe(false);
    // Round-trip preserves UTC suffix.
    expect(env.generatedAt).toMatch(/Z$/);
  });

  it('honors an explicit generatedAt for deterministic tests', () => {
    const env = buildAgentEnvelope({
      ...BASE_REQUIRED,
      generatedAt: '2026-05-16T15:00:00.000Z',
    });
    expect(env.generatedAt).toBe('2026-05-16T15:00:00.000Z');
  });

  it('stamps CLI + SDK versions by default', () => {
    const env = buildAgentEnvelope(BASE_REQUIRED);
    expect(env.cliVersion).toBe(CLI_VERSION);
    expect(env.sdkVersion).toBe(SDK_VERSION);
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('passes through provided values without mutation', () => {
    const wallet = '0xabcdef0000000000000000000000000000000001' as const;
    const warnings: AgentWarning[] = [
      { code: 'allowance-short', message: 'short', severity: 'blocking' },
    ];
    const approvalRequirements: ApprovalRequirement[] = [
      {
        token: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174' as const,
        tokenSymbol: 'USDC',
        spender: '0x0000000000000000000000000000000000000099' as const,
        spenderLabel: 'PositionModule',
        purpose: 'commitment-risk',
        requiredWei: '25000000',
        requiredHuman: '25.000000',
        currentWei: '0',
        currentHuman: '0.000000',
        needsApproval: true,
      },
    ];
    const env = buildAgentEnvelope({
      ...BASE_REQUIRED,
      action: 'commitments.submit',
      stage: 'preview',
      wallet,
      walletRole: 'signer',
      signer: wallet,
      requiresSignature: true,
      requiresTransaction: true,
      approvalRequirements,
      warnings,
      payload: { preview: { kind: 'submit' } },
    });
    expect(env.wallet).toBe(wallet);
    expect(env.walletRole).toBe('signer');
    expect(env.signer).toBe(wallet);
    expect(env.requiresSignature).toBe(true);
    expect(env.requiresTransaction).toBe(true);
    expect(env.approvalRequirements).toBe(approvalRequirements);
    expect(env.warnings).toBe(warnings);
    expect(env.payload).toEqual({ preview: { kind: 'submit' } });
  });

  it('throws when nextCommands exceeds the hard cap', () => {
    const tooMany = Array.from({ length: MAX_NEXT_COMMANDS + 1 }, (_, i) => ({
      id: `id-${i}`,
      description: `desc-${i}`,
      suggestedFor: 'verify' as const,
      command: `ospex foo ${i}`,
      argv: ['foo', String(i), '--json'],
      safeToAutoRun: true,
    }));
    expect(() =>
      buildAgentEnvelope({ ...BASE_REQUIRED, nextCommands: tooMany }),
    ).toThrow(/nextCommands exceeds cap/);
  });

  it('accepts exactly MAX_NEXT_COMMANDS entries', () => {
    const allowed = Array.from({ length: MAX_NEXT_COMMANDS }, (_, i) => ({
      id: `id-${i}`,
      description: `desc-${i}`,
      suggestedFor: 'verify' as const,
      command: `ospex foo ${i}`,
      argv: ['foo', String(i), '--json'],
      safeToAutoRun: true,
    }));
    const env = buildAgentEnvelope({ ...BASE_REQUIRED, nextCommands: allowed });
    expect(env.nextCommands).toHaveLength(MAX_NEXT_COMMANDS);
  });

  // Review: `doctor` shipped with `payload.schemaVersion: 1`
  // because `JsonDoctorReport` baked it in. The guard below catches this
  // class of bug at build time so future migrations can't silently
  // ship two version signals.
  it('throws when payload object carries an inner schemaVersion', () => {
    expect(() =>
      buildAgentEnvelope({
        ...BASE_REQUIRED,
        payload: { schemaVersion: 1, foo: 'bar' },
      }),
    ).toThrow(/inner `schemaVersion` field/);
  });

  it('accepts payload objects without schemaVersion', () => {
    expect(() =>
      buildAgentEnvelope({ ...BASE_REQUIRED, payload: { foo: 'bar' } }),
    ).not.toThrow();
  });

  it('accepts null payload (failure envelopes)', () => {
    expect(() =>
      buildAgentEnvelope({ ...BASE_REQUIRED, payload: null }),
    ).not.toThrow();
  });

  it('accepts primitive payloads (number, string, boolean) without guard', () => {
    for (const payload of [42, 'ok', true]) {
      expect(() =>
        buildAgentEnvelope({ ...BASE_REQUIRED, payload }),
      ).not.toThrow();
    }
  });
});

describe('buildFailureEnvelope', () => {
  const errors: AgentError[] = [
    { code: 'ALLOWANCE_INSUFFICIENT', message: 'USDC allowance is too low' },
  ];

  it('produces an ok: false envelope with payload: null', () => {
    const env = buildFailureEnvelope({
      action: 'commitments.match',
      stage: 'preview',
      network: 'polygon',
      chainId: 137,
      errors,
    });
    expect(env.schemaVersion).toBe(2);
    expect(env.ok).toBe(false);
    expect(env.payload).toBeNull();
    expect(env.errors).toEqual(errors);
  });

  it('throws when errors array is empty', () => {
    expect(() =>
      buildFailureEnvelope({
        action: 'commitments.match',
        stage: 'preview',
        network: 'polygon',
        chainId: 137,
        errors: [],
      }),
    ).toThrow(/at least one error is required/);
  });

  it('carries through preflight info on failures', () => {
    const env = buildFailureEnvelope({
      action: 'commitments.submit',
      stage: 'preview',
      network: 'polygon',
      chainId: 137,
      wallet: '0xabcdef0000000000000000000000000000000001',
      walletRole: 'signer',
      requiresSignature: true,
      requiresTransaction: true,
      errors,
    });
    expect(env.wallet).toBe('0xabcdef0000000000000000000000000000000001');
    expect(env.walletRole).toBe('signer');
    expect(env.requiresSignature).toBe(true);
    expect(env.requiresTransaction).toBe(true);
  });
});

describe('writeAgentEnvelope', () => {
  it('writes parseable JSON to the given stream with a trailing newline', () => {
    const sink = new StringSink();
    const env = buildAgentEnvelope({
      ...BASE_REQUIRED,
      generatedAt: '2026-05-16T15:00:00.000Z',
    });
    writeAgentEnvelope(env, { out: sink });
    expect(sink.buf.endsWith('\n')).toBe(true);
    const parsed: AgentEnvelope<unknown> = JSON.parse(sink.buf.trim());
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.action).toBe('health');
    expect(parsed.generatedAt).toBe('2026-05-16T15:00:00.000Z');
  });

  it('serializes BigInt values as decimal strings', () => {
    const sink = new StringSink();
    const env = buildAgentEnvelope({
      ...BASE_REQUIRED,
      payload: { riskWei6: 25_000_000n, big: 10n ** 30n },
    });
    writeAgentEnvelope(env, { out: sink });
    const parsed = JSON.parse(sink.buf.trim()) as {
      payload: { riskWei6: string; big: string };
    };
    expect(parsed.payload.riskWei6).toBe('25000000');
    expect(parsed.payload.big).toBe('1000000000000000000000000000000');
  });

  it('emits a single JSON object, not NDJSON', () => {
    const sink = new StringSink();
    const env = buildAgentEnvelope(BASE_REQUIRED);
    writeAgentEnvelope(env, { out: sink });
    // Trimmed output has exactly one top-level object.
    const lines = sink.buf.trim().split('\n');
    // (pretty-printed, so many lines — but it must JSON.parse as a single object)
    expect(JSON.parse(sink.buf.trim())).toBeTypeOf('object');
    expect(lines.length).toBeGreaterThan(1); // pretty-printed
  });

  it('honors a 0 indent for compact output', () => {
    const sink = new StringSink();
    const env = buildAgentEnvelope(BASE_REQUIRED);
    writeAgentEnvelope(env, { out: sink, indent: 0 });
    // Compact: exactly one line plus trailing newline.
    expect(sink.buf.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(sink.buf.trim())).toBeTypeOf('object');
  });
});

describe('networkForChainId', () => {
  it('maps 137 to polygon and 80002 to amoy', () => {
    expect(networkForChainId(137)).toBe('polygon');
    expect(networkForChainId(80002)).toBe('amoy');
  });
});

describe('buildFailureEnvelope (the failure-envelope scope: effects preservation)', () => {
  const errors: AgentError[] = [{ code: 'CHAIN_ERROR', message: 'reverted' }];

  it('preserves completed effects[] on mid-flight failure', () => {
    const completedApprove = {
      type: 'transaction' as const,
      purpose: 'approve-usdc',
      ok: true,
      txHash: '0xapprove' as `0x${string}`,
      blockNumber: '1000',
      status: 'confirmed' as const,
    };
    const env = buildFailureEnvelope({
      action: 'commitments.submit',
      stage: 'execute',
      network: 'polygon',
      chainId: 137,
      errors,
      effects: [completedApprove],
    });
    expect(env.ok).toBe(false);
    expect(env.effects).toEqual([completedApprove]);
    expect(env.errors[0]?.code).toBe('CHAIN_ERROR');
  });

  it('defaults effects to [] when not provided', () => {
    const env = buildFailureEnvelope({
      action: 'commitments.submit',
      stage: 'preview',
      network: 'polygon',
      chainId: 137,
      errors,
    });
    expect(env.effects).toEqual([]);
  });
});

describe('errorToAgentError', () => {
  it('OspexError → { code, message }', () => {
    const out = errorToAgentError(new OspexValidationError('bad field'));
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(out.message).toBe('bad field');
  });

  it('OspexChainError with reason + txHash surfaces them via details', () => {
    const err = new OspexChainError('reverted', {
      reason: 'NotCommitmentMaker',
      txHash: '0xreverted',
    });
    const out = errorToAgentError(err);
    expect(out.code).toBe('CHAIN_ERROR');
    expect(out.details).toMatchObject({
      reason: 'NotCommitmentMaker',
      txHash: '0xreverted',
    });
  });

  // M3: the failure envelope must carry receipt.status — the discriminator
  // between a reverted tx and a confirmed-but-post-parse-failed tx. Without
  // it, an agent's retry table mislabels a SUCCESSFUL claim as "tx reverted".
  it('surfaces receiptStatus + receiptBlockNumber for a reverted-on-inclusion OspexChainError', () => {
    const err = new OspexChainError('Transaction reverted on-chain.', {
      txHash: '0xreverted',
      receipt: { status: 'reverted', blockNumber: 1234n } as never,
    });
    const out = errorToAgentError(err);
    expect(out.details).toMatchObject({
      txHash: '0xreverted',
      receiptStatus: 'reverted',
      receiptBlockNumber: '1234',
    });
  });

  it('surfaces receiptStatus:"success" for a confirmed-but-unparsed OspexChainError (NOT a revert)', () => {
    const err = new OspexChainError('tx confirmed but POSITION_CLAIMED event missing', {
      txHash: '0xclaimed',
      receipt: { status: 'success', blockNumber: 5678n } as never,
    });
    const out = errorToAgentError(err);
    const details = out.details as { receiptStatus?: string };
    // The confirmed claim must NOT read as reverted — this is the exact
    // mislabel M3 exists to prevent.
    expect(details.receiptStatus).toBe('success');
  });

  it('omits receiptStatus when the OspexChainError carries a txHash but no receipt (status UNKNOWN)', () => {
    // The M2 receipt-wait-timeout shape: broadcast landed a hash, no receipt.
    // NOTE: this is an OVER-CLAIM guard (it would catch new code wrongly
    // surfacing a receiptStatus on a no-receipt error), not a fix-pin — it
    // passes on pre-M3 code too. The discriminating M3 behavior (receipt
    // PRESENT ⇒ receiptStatus surfaced) is pinned by the two sibling tests
    // above. The pair together pins the present-vs-absent contrast.
    const err = new OspexChainError('broadcast ok, receipt wait failed', {
      txHash: '0xpending',
    });
    const out = errorToAgentError(err);
    const details = out.details as { txHash?: string; receiptStatus?: string };
    expect(details.txHash).toBe('0xpending');
    expect(details.receiptStatus).toBeUndefined();
  });

  it('OspexAllowanceError surfaces required/current/spender/token via details', () => {
    const err = new OspexAllowanceError('short', {
      required: 25_000_000n,
      current: 0n,
      spender: '0xspender' as `0x${string}`,
      token: '0xtoken' as `0x${string}`,
    });
    const out = errorToAgentError(err);
    expect(out.code).toBe('ALLOWANCE_INSUFFICIENT');
    expect(out.details).toMatchObject({
      required: '25000000', // bigint → decimal string
      current: '0',
      spender: '0xspender',
      token: '0xtoken',
    });
  });

  it('OspexAPIError surfaces status + apiCode via details', () => {
    const err = new OspexAPIError('rate limited', { status: 429, apiCode: 'RATE_LIMITED' });
    const out = errorToAgentError(err);
    expect(out.code).toBe('API_ERROR');
    expect(out.details).toMatchObject({ status: 429, apiCode: 'RATE_LIMITED' });
  });

  it('native Error → UNKNOWN_ERROR with original message', () => {
    const out = errorToAgentError(new Error('boom'));
    expect(out.code).toBe('UNKNOWN_ERROR');
    expect(out.message).toBe('boom');
  });

  it('non-Error throw value → UNKNOWN_ERROR with stringified message', () => {
    const out = errorToAgentError('not even an error');
    expect(out.code).toBe('UNKNOWN_ERROR');
    expect(out.message).toBe('not even an error');
  });

  // H1 regression: the credentialed RPC URL must be scrubbed from the
  // TOP-LEVEL envelope message, not just details.causeChain. The SDK's
  // formatPreSendErr joins viem metaMessages verbatim into the
  // OspexChainError's OWN .message, so a transport 429/timeout puts the
  // Alchemy `/v2/<key>` on the error message the envelope copies to stdout.
  const ALCHEMY_KEY = 'AbCdEf0123456789xyzAbCdEf0123456789';

  it('redacts a credentialed RPC URL embedded in the OspexChainError message (H1)', () => {
    const err = new OspexChainError(
      `Transaction broadcast or inclusion failed.\n\nURL: https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}\nStatus: 429`,
    );
    const out = errorToAgentError(err);
    expect(out.code).toBe('CHAIN_ERROR');
    expect(out.message).not.toContain(ALCHEMY_KEY);
    expect(out.message).toContain('[redacted]');
  });

  it('redacts a credentialed URL in a native Error message (UNKNOWN_ERROR branch)', () => {
    const out = errorToAgentError(new Error(`fetch failed: https://eth.example/v2/${ALCHEMY_KEY}`));
    expect(out.code).toBe('UNKNOWN_ERROR');
    expect(out.message).not.toContain(ALCHEMY_KEY);
    expect(out.message).toContain('[redacted]');
  });

  it('redacts a credentialed URL in a non-Error thrown value (String(err) branch)', () => {
    const out = errorToAgentError(`raw throw https://eth.example/v2/${ALCHEMY_KEY}`);
    expect(out.code).toBe('UNKNOWN_ERROR');
    expect(out.message).not.toContain(ALCHEMY_KEY);
    expect(out.message).toContain('[redacted]');
  });

  it('leaves a credential-free OspexError message byte-identical (no over-redaction)', () => {
    const out = errorToAgentError(new OspexValidationError('lineTicks must be a 32-bit integer'));
    expect(out.message).toBe('lineTicks must be a 32-bit integer');
  });

  it('sanitizes a credentialed URL in details.revertReason (parity with causeChain)', () => {
    // revertReason is a free-form string for legacy/unknown reverts; the
    // detail path must scrub it exactly like the cause-chain walker does.
    const err = new OspexChainError('reverted', {
      revertReason: `execution reverted at https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    });
    const out = errorToAgentError(err);
    const details = out.details as { revertReason?: string };
    expect(details.revertReason).toBeDefined();
    expect(details.revertReason).not.toContain(ALCHEMY_KEY);
    expect(details.revertReason).toContain('[redacted]');
  });
});

describe('errorToAgentError — cause-chain walk (CHAIN_ERROR observability)', () => {
  it('preserves a wrapped viem-style cause under details.causeChain', () => {
    // The exact shape buildSignAndSend produces on a sendRawTransaction
    // transport failure: wrap with cause, no txHash yet.
    class HttpRequestError extends Error {
      override name = 'HttpRequestError';
      shortMessage = 'HTTP request failed.';
      status = 429;
      metaMessages = ['URL: https://example.invalid/v2/[redacted]', 'Method: eth_sendRawTransaction'];
    }
    const viemErr = new HttpRequestError(
      'HTTP request failed.\n\nURL: https://example.invalid/v2/aaaaaaaaaaaaaaaaaaaa\nStatus: 429',
    );
    const wrapped = new OspexChainError('Transaction broadcast or inclusion failed.', {
      cause: viemErr,
    });
    const out = errorToAgentError(wrapped);
    expect(out.code).toBe('CHAIN_ERROR');
    expect(out.message).toBe('Transaction broadcast or inclusion failed.');
    const details = out.details as { causeChain?: AgentErrorCauseEntry[] };
    expect(Array.isArray(details.causeChain)).toBe(true);
    expect(details.causeChain).toHaveLength(1);
    const top = details.causeChain![0]!;
    expect(top.name).toBe('HttpRequestError');
    expect(top.status).toBe(429);
    expect(top.shortMessage).toBe('HTTP request failed.');
  });

  it('redacts URLs (with credential path segments) embedded in the nested message + metaMessages', () => {
    class HttpRequestError extends Error {
      override name = 'HttpRequestError';
      shortMessage = 'HTTP request failed.';
      metaMessages = ['URL: https://eth-mainnet.g.alchemy.com/v2/aaaaaaaaaaaaaaaaaaaa'];
    }
    const viemErr = new HttpRequestError(
      'HTTP request failed.\n\nURL: https://eth-mainnet.g.alchemy.com/v2/aaaaaaaaaaaaaaaaaaaa',
    );
    const wrapped = new OspexChainError('Transaction broadcast or inclusion failed.', {
      cause: viemErr,
    });
    const out = errorToAgentError(wrapped);
    const top = (out.details as { causeChain: AgentErrorCauseEntry[] }).causeChain[0]!;
    // Long opaque path segment must be scrubbed from both the message
    // and metaMessages — agents read both.
    expect(top.message).not.toContain('aaaaaaaaaaaaaaaaaaaa');
    expect(top.metaMessages?.[0]).not.toContain('aaaaaaaaaaaaaaaaaaaa');
    expect(top.message).toContain('[redacted]');
  });

  it('walks multi-level cause chains up to MAX_CAUSE_CHAIN_DEPTH', () => {
    // Build a 6-deep chain; expect the walker to stop at the cap.
    let deepest = new Error('leaf');
    deepest.name = 'LeafError';
    for (let i = 0; i < 5; i++) {
      const wrapped = new Error(`wrap-${i}`);
      (wrapped as { cause?: unknown }).cause = deepest;
      deepest = wrapped;
    }
    const top = new OspexChainError('outer', { cause: deepest });
    const out = errorToAgentError(top);
    const chain = (out.details as { causeChain: AgentErrorCauseEntry[] }).causeChain;
    // 6 nested causes; capped at 4.
    expect(chain).toHaveLength(MAX_CAUSE_CHAIN_DEPTH);
    expect(MAX_CAUSE_CHAIN_DEPTH).toBe(4);
  });

  it('breaks self-referential cause chains without looping', () => {
    const a = new Error('a');
    const b = new Error('b');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    const top = new OspexChainError('outer', { cause: a });
    const out = errorToAgentError(top);
    const chain = (out.details as { causeChain: AgentErrorCauseEntry[] }).causeChain;
    // a → b, then b's cause === a (already seen) → stop. 2 entries.
    expect(chain).toHaveLength(2);
  });

  it('redacts named-credential tokens in nested messages', () => {
    const inner = new Error('Request failed: authorization=Bearer abcd1234secret api_key=xyzlongtoken');
    inner.name = 'TransportError';
    const top = new OspexChainError('outer', { cause: inner });
    const out = errorToAgentError(top);
    const chain = (out.details as { causeChain: AgentErrorCauseEntry[] }).causeChain;
    expect(chain[0]?.message).not.toContain('abcd1234secret');
    expect(chain[0]?.message).not.toContain('xyzlongtoken');
    expect(chain[0]?.message).toContain('[redacted]');
  });

  it('extracts a nested OspexError reason / revertReason / txHash', () => {
    const inner = new OspexChainError('nested revert', {
      reason: 'NotCommitmentMaker',
      txHash: '0xdeadbeef',
      revertReason: 'caller not authorized',
    });
    const outer = new OspexChainError('outer wrapper', { cause: inner });
    const out = errorToAgentError(outer);
    const top = (out.details as { causeChain: AgentErrorCauseEntry[] }).causeChain[0]!;
    expect(top.reason).toBe('NotCommitmentMaker');
    expect(top.txHash).toBe('0xdeadbeef');
    expect(top.revertReason).toBe('caller not authorized');
  });

  it('does not emit details.causeChain when err has no cause', () => {
    const out = errorToAgentError(new OspexValidationError('plain validation, no cause'));
    expect(out.details).toBeUndefined();
  });

  it('also surfaces causeChain for plain Error throws that carry a cause', () => {
    const inner = new Error('inner transport boom');
    inner.name = 'TransportError';
    const top = new Error('outer wrap');
    (top as { cause?: unknown }).cause = inner;
    const out = errorToAgentError(top);
    expect(out.code).toBe('UNKNOWN_ERROR');
    expect((out.details as { causeChain: AgentErrorCauseEntry[] }).causeChain[0]?.name).toBe(
      'TransportError',
    );
  });
});

describe('emitJsonFailure — requiresSignature / requiresTransaction / approvalRequirements', () => {
  it('forwards requiresSignature + requiresTransaction onto the failure envelope', () => {
    const sink = new StringSink();
    const writeOrig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Buffer) => {
      sink.write(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      emitJsonFailure({
        action: 'contests.create',
        stage: 'execute',
        chainId: 137,
        wallet: '0xaa00000000000000000000000000000000000001' as const,
        walletRole: 'signer',
        signer: '0xaa00000000000000000000000000000000000001' as const,
        // Write command failed before any side effect — caller MUST
        // advertise sig + tx intent so the envelope doesn't show the
        // misleading default of `false`.
        requiresSignature: true,
        requiresTransaction: true,
        error: new OspexChainError('Transaction broadcast or inclusion failed.'),
      });
    } finally {
      process.stdout.write = writeOrig;
    }
    const parsed = JSON.parse(sink.buf.trim()) as {
      ok: boolean;
      requiresSignature: boolean;
      requiresTransaction: boolean;
      wallet: string | null;
      signer: string | null;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.requiresSignature).toBe(true);
    expect(parsed.requiresTransaction).toBe(true);
    expect(parsed.wallet).toBe('0xaa00000000000000000000000000000000000001');
    expect(parsed.signer).toBe('0xaa00000000000000000000000000000000000001');
  });

  it('forwards approvalRequirements onto the failure envelope', () => {
    const sink = new StringSink();
    const writeOrig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Buffer) => {
      sink.write(chunk);
      return true;
    }) as typeof process.stdout.write;
    const approvals: ApprovalRequirement[] = [
      {
        token: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' as const,
        tokenSymbol: 'USDC',
        spender: '0x1111111111111111111111111111111111111111' as const,
        spenderLabel: 'PositionModule',
        purpose: 'commitment-risk',
        requiredWei: '100000000',
        requiredHuman: '100.000000',
        currentWei: '0',
        currentHuman: '0.000000',
        needsApproval: true,
      },
    ];
    try {
      emitJsonFailure({
        action: 'commitments.submit',
        stage: 'execute',
        chainId: 137,
        approvalRequirements: approvals,
        error: new OspexValidationError('boom'),
      });
    } finally {
      process.stdout.write = writeOrig;
    }
    const parsed = JSON.parse(sink.buf.trim()) as { approvalRequirements: unknown[] };
    expect(parsed.approvalRequirements).toEqual(approvals);
  });

  it('defaults requiresSignature/requiresTransaction to false when not passed (back-compat)', () => {
    const sink = new StringSink();
    const writeOrig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Buffer) => {
      sink.write(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      emitJsonFailure({
        action: 'health',
        stage: 'read',
        chainId: 137,
        error: new OspexValidationError('boom'),
      });
    } finally {
      process.stdout.write = writeOrig;
    }
    const parsed = JSON.parse(sink.buf.trim()) as {
      requiresSignature: boolean;
      requiresTransaction: boolean;
    };
    // Read commands stay false — the existing default. Only write
    // commands flip to true.
    expect(parsed.requiresSignature).toBe(false);
    expect(parsed.requiresTransaction).toBe(false);
  });
});

describe('emitJsonFailure', () => {
  it('writes a failure envelope to stdout with errors + preserved effects', () => {
    const sink = new StringSink();
    const stdout = process.stdout;
    // Swap stdout for the duration of one call. (writeAgentEnvelope
    // doesn't accept a stream override, so we replace via prototype
    // descriptor; restore in finally.)
    const writeOrig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Buffer) => {
      sink.write(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      emitJsonFailure({
        action: 'commitments.submit',
        stage: 'execute',
        chainId: 137,
        error: new OspexChainError('NONCE_TOO_LOW'),
        effects: [
          {
            type: 'transaction',
            purpose: 'approve-usdc',
            ok: true,
            txHash: '0xapprove',
            blockNumber: '1000',
            status: 'confirmed',
          },
        ],
      });
    } finally {
      process.stdout.write = writeOrig;
    }
    void stdout;
    const parsed = JSON.parse(sink.buf.trim()) as {
      ok: boolean;
      action: string;
      stage: string;
      errors: Array<{ code: string }>;
      effects: Array<{ purpose: string; ok: boolean }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.action).toBe('commitments.submit');
    expect(parsed.stage).toBe('execute');
    expect(parsed.errors[0]?.code).toBe('CHAIN_ERROR');
    expect(parsed.effects[0]?.purpose).toBe('approve-usdc');
    expect(parsed.effects[0]?.ok).toBe(true);
  });
});

describe('emitJsonSuccess — writes envelope + sets the §6 exit code', () => {
  // Captures stdout AND the exit code the helper sets, then restores both
  // (so a leaked process.exitCode=1 can't fail the vitest run itself).
  function run(envelope: AgentEnvelope<unknown>): { stdout: string; exitCode: number } {
    const sink = new StringSink();
    const writeOrig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Buffer) => {
      sink.write(chunk);
      return true;
    }) as typeof process.stdout.write;
    const origExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      emitJsonSuccess(envelope);
      const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
      return { stdout: sink.buf, exitCode };
    } finally {
      process.stdout.write = writeOrig;
      process.exitCode = origExitCode;
    }
  }

  it('ok:true → exit code 0 and the envelope is written to stdout', () => {
    const env = buildAgentEnvelope({
      ...BASE_REQUIRED,
      ok: true,
      action: 'claim-all',
      stage: 'execute',
      payload: { swept: true },
    });
    const { stdout, exitCode } = run(env);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim()) as { ok: boolean; action: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe('claim-all');
  });

  it('ok:false → exit code 1, and the envelope is STILL written before exit (the §6 contract M4 violated)', () => {
    const env = buildAgentEnvelope({
      ...BASE_REQUIRED,
      ok: false,
      action: 'claim-all',
      stage: 'execute',
      payload: { failed: 1 },
    });
    const { stdout, exitCode } = run(env);
    expect(exitCode).toBe(1);
    // process.exitCode (not process.exit) ⇒ the envelope flushed first; an
    // agent can still parse ok:false off stdout.
    const parsed = JSON.parse(stdout.trim()) as { ok: boolean };
    expect(parsed.ok).toBe(false);
  });

  it('sets the code as `ok ? 0 : 1` — an ok:true emit clears a prior non-zero code', () => {
    // Pins that the helper assigns exitCode (not `if (!ok) exitCode = 1`),
    // so a clean emit after a prior failure doesn't inherit the stale 1.
    const writeOrig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const origExitCode = process.exitCode;
    process.exitCode = 1; // simulate a prior nonzero
    try {
      emitJsonSuccess(buildAgentEnvelope({ ...BASE_REQUIRED, ok: true }));
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = writeOrig;
      process.exitCode = origExitCode;
    }
  });
});

/* ------------------------------------------------------------------ */
/* withReadFailureEnvelope — the shared Class A read wrapper          */
/* ------------------------------------------------------------------ */

/**
 * Unit coverage for the wrapper's own branches. The WIRING — that each of
 * the 19 read commands actually routes through it, with the shoulder fields
 * §5.3 gives that command — is pinned separately by
 * `class-a-failure-envelope-sweep.test.ts`, which drives the real program
 * tree. Both are needed: `verification-discipline.md` §3i-install, unit
 * tests of a factory leave the install sites unexecuted.
 */
describe('withReadFailureEnvelope', () => {
  /** Run the wrapper with stdout and process.exit captured, and restore both. */
  async function run(
    spec: Parameters<typeof withReadFailureEnvelope>[0],
    body: () => Promise<unknown>,
  ): Promise<{ stdout: string; exitCalls: number[]; threw: unknown }> {
    const sink = new StringSink();
    const writeOrig = process.stdout.write.bind(process.stdout);
    const exitCalls: number[] = [];
    const exitOrig = process.exit;
    process.stdout.write = ((chunk: string | Buffer) => {
      sink.write(chunk);
      return true;
    }) as typeof process.stdout.write;
    // The wrapper calls process.exit(1) after emitting. Throw a sentinel so
    // control stops exactly where the real process would, WITHOUT killing the
    // test runner — and record that it was called, because "the envelope was
    // written" and "the command stopped" are two separate promises of §6.
    process.exit = ((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new ExitCalled();
    }) as never;
    let threw: unknown = null;
    try {
      await withReadFailureEnvelope(spec, body);
    } catch (err) {
      threw = err instanceof ExitCalled ? null : err;
    } finally {
      process.stdout.write = writeOrig;
      process.exit = exitOrig;
    }
    return { stdout: sink.buf, exitCalls, threw };
  }

  const SPEC = { action: 'positions.status', chainId: 137 as const };
  const BOOM = new OspexAPIError('upstream is down');
  const SUBJECT_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
  const SUBJECT_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

  it('returns the body value and writes nothing when the body succeeds', async () => {
    const sink = new StringSink();
    const writeOrig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Buffer) => {
      sink.write(chunk);
      return true;
    }) as typeof process.stdout.write;
    let value: string;
    try {
      value = await withReadFailureEnvelope({ ...SPEC, json: true }, async () => 'the payload');
    } finally {
      process.stdout.write = writeOrig;
    }
    expect(value).toBe('the payload');
    // The wrapper is not an emitter — the command's own success path writes.
    expect(sink.buf).toBe('');
  });

  // NEGATIVE CONTROL. Every case below asserts "the failure is captured";
  // without this one they would all still pass on a wrapper that captured
  // EVERY failure, which would silently convert a failed human-mode read
  // into a swallowed error or an envelope nobody asked for.
  it('re-throws the original error untouched, and emits nothing, without --json', async () => {
    const { stdout, exitCalls, threw } = await run({ ...SPEC, json: false }, async () => {
      throw BOOM;
    });
    expect(threw).toBe(BOOM);
    expect(stdout).toBe('');
    expect(exitCalls).toStrictEqual([]);
  });

  it('emits one read-shaped failure envelope and exits 1 with --json', async () => {
    const { stdout, exitCalls, threw } = await run({ ...SPEC, json: true }, async () => {
      throw BOOM;
    });
    expect(threw).toBeNull();
    expect(exitCalls).toStrictEqual([1]);
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.ok).toBe(false);
    expect(parsed.action).toBe('positions.status');
    expect(parsed.stage).toBe('read');
    expect(parsed.payload).toBeNull();
    expect((parsed.errors as Array<{ code: string }>)[0]?.code).toBe('API_ERROR');
    // §5.3: a read must never advertise write intent, whatever it was doing.
    expect(parsed.requiresSignature).toBe(false);
    expect(parsed.requiresTransaction).toBe(false);
    expect(parsed.signer).toBeNull();
  });

  it('reports no subject when the command has no wallet context', async () => {
    const { stdout } = await run({ ...SPEC, json: true }, async () => {
      throw BOOM;
    });
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(parsed.wallet).toBeNull();
    expect(parsed.walletRole).toBe('none');
  });

  it('carries the subject a wallet-scoped read names', async () => {
    const { stdout } = await run(
      { ...SPEC, json: true, subject: () => ({ wallet: SUBJECT_A, walletRole: 'subject' }) },
      async () => {
        throw BOOM;
      },
    );
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(parsed.wallet).toBe(SUBJECT_A);
    expect(parsed.walletRole).toBe('subject');
  });

  // THE DISCRIMINATING CASE for the thunk. `commitments fillability` and
  // `positions history` resolve their own subject INSIDE the guarded window,
  // so the value the envelope should name does not exist when the wrapper is
  // called. The thunk here reads a `let` that the body reassigns before it
  // throws: an eager implementation — one that captured the subject at call
  // time — would report SUBJECT_A, and every other case in this describe
  // would still pass. Both spellings are non-null on purpose, so this fails
  // on the VALUE rather than on a null the `?? NO_READ_SUBJECT` path could
  // also produce.
  // The commands ALSO narrow their wallet before handing it over, so a
  // command-level test cannot tell whether this boundary is doing anything —
  // either layer alone produces the same envelope (`verification-discipline.md`
  // §3b-rescue: with defence in depth, every layer is a rival explanation for
  // the same green test). These two cases hand the wrapper a hostile subject
  // directly, so only the boundary can produce the expected answer.
  it('refuses a subject whose wallet is not an address, and drops the role with it', async () => {
    const { stdout } = await run(
      {
        ...SPEC,
        json: true,
        // What a command that cast instead of narrowing would hand over.
        subject: () => ({ wallet: 'not-an-address' as `0x${string}`, walletRole: 'subject' }),
      },
      async () => {
        throw BOOM;
      },
    );
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(parsed.wallet).toBeNull();
    // The role goes with it. A `'subject'` beside a null wallet claims a
    // subject the envelope cannot name.
    expect(parsed.walletRole).toBe('none');
  });

  it('lowercases a valid subject, and keeps the role the command chose', async () => {
    const { stdout } = await run(
      {
        ...SPEC,
        json: true,
        // Mixed case, and a role that is NOT 'subject' — so this fails if the
        // boundary drops the case OR hardcodes the role it re-attaches.
        subject: () => ({ wallet: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', walletRole: 'filter' }),
      },
      async () => {
        throw BOOM;
      },
    );
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(parsed.wallet).toBe(SUBJECT_A);
    expect(parsed.walletRole).toBe('filter');
  });

  it('evaluates the subject at failure time, not at call time', async () => {
    let subject = SUBJECT_A as string;
    const { stdout } = await run(
      {
        ...SPEC,
        json: true,
        subject: () => ({ wallet: subject as `0x${string}`, walletRole: 'subject' }),
      },
      async () => {
        subject = SUBJECT_B;
        throw BOOM;
      },
    );
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(parsed.wallet).toBe(SUBJECT_B);
  });
});
