import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type {
  AgentEnvelope,
  AgentError,
  AgentWarning,
  ApprovalRequirement,
} from '@ospex/sdk';
import {
  CLI_VERSION,
  MAX_NEXT_COMMANDS,
  SDK_VERSION,
  buildAgentEnvelope,
  buildFailureEnvelope,
  networkForChainId,
  writeAgentEnvelope,
} from '../src/lib/agentEnvelope.js';

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

  // Hermes PR-67 review: `doctor` shipped with `payload.schemaVersion: 1`
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
