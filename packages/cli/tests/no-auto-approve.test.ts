/**
 * Command-level regression coverage for the opt-in no-auto-approval policy.
 * A short allowance discovered by the CLI preview must stop before either the
 * approval helper or the final match/submit write is invoked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAddresses,
  type AgentEnvelope,
  type Hex,
  type OspexClient,
} from '@ospex/sdk';

vi.mock('../src/lib/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/client.js')>();
  return { ...actual, getClient: vi.fn() };
});
vi.mock('../src/lib/matchPreviewRender.js', () => ({ renderMatchPreview: vi.fn() }));
vi.mock('../src/lib/previewRender.js', () => ({ renderPreview: vi.fn() }));

import { getClient } from '../src/lib/client.js';
import { commitmentsMatchCommand } from '../src/commands/commitments/match.js';
import { commitmentsSubmitCommand } from '../src/commands/commitments/submit.js';

const WALLET = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const ADDRESSES = getAddresses(137);
const APPROVAL = {
  token: 'USDC' as const,
  spender: ADDRESSES.positionModule,
  current: '0',
  required: '1000000',
  needsApproval: true,
  purpose: 'commitment-risk' as const,
};

class ProcessExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function asStr(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

async function run(
  command: { parseAsync: (argv: string[], opts: { from: 'user' }) => Promise<unknown> },
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number; error?: unknown }> {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => ((stdout += asStr(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => ((stderr += asStr(chunk)), true)) as typeof process.stderr.write;
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  let exitViaCall: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitViaCall = code ?? 0;
    throw new ProcessExitSignal(exitViaCall);
  }) as never);
  let error: unknown;
  try {
    await command.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (!(err instanceof ProcessExitSignal)) error = err;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    exitSpy.mockRestore();
  }
  const exitCode = exitViaCall ?? (typeof process.exitCode === 'number' ? process.exitCode : 0);
  process.exitCode = origExitCode;
  return { stdout, stderr, exitCode, ...(error === undefined ? {} : { error }) };
}

function envelope(stdout: string): AgentEnvelope<unknown> {
  return JSON.parse(stdout) as AgentEnvelope<unknown>;
}

function matchClient(approval = APPROVAL) {
  const approve = vi.fn().mockRejectedValue(new Error('implicit match approval attempted'));
  const approveCreationFee = vi.fn().mockRejectedValue(new Error('implicit match fee approval attempted'));
  const matchFromPreview = vi.fn().mockResolvedValue({
    txHash: `0x${'11'.repeat(32)}`,
    takerRisk: 1_000_000n,
    fillMakerRisk: 1_000_000n,
    receipt: { status: 'success', blockNumber: 1n },
  });
  const checkCommitmentFillability = vi.fn().mockResolvedValue({
    commitmentHash: HASH,
    fillableNow: !approval.needsApproval,
    outcome: approval.needsApproval ? 'not-fillable' : 'fillable',
    advisory: true,
    reasons: approval.needsApproval ? [{
      code: 'TAKER_POSITION_ALLOWANCE_INSUFFICIENT',
      requiredWei6: '1000000',
      actualWei6: '0',
    }] : [],
  });
  const preview = { taker: WALLET, approvals: [approval] };
  const client = {
    chainId: () => 137,
    signer: () => ({ getAddress: vi.fn().mockResolvedValue(WALLET) }),
    commitments: {
      resolveByPrefix: vi.fn().mockResolvedValue({ commitmentHash: HASH }),
      prepareMatch: vi.fn().mockResolvedValue(preview),
      checkCommitmentFillability,
      approve,
      approveCreationFee,
      matchFromPreview,
    },
  } as unknown as OspexClient;
  return { client, checkCommitmentFillability, approve, approveCreationFee, matchFromPreview };
}

function submitClient(approval = APPROVAL) {
  const approve = vi.fn().mockRejectedValue(new Error('implicit submit approval attempted'));
  const approveCreationFee = vi.fn().mockRejectedValue(new Error('implicit submit fee approval attempted'));
  const submitPrepared = vi.fn().mockResolvedValue({
    hash: HASH,
    commitment: { status: 'open', riskAmount: '1000000', nonce: '1', expiry: '123' },
  });
  const checkSubmitFundability = vi.fn().mockResolvedValue({
    maker: WALLET,
    fundableNow: !approval.needsApproval,
    outcome: approval.needsApproval ? 'not-fundable' : 'fundable',
    scope: 'visible-book-only',
    coverage: { visible: 'included', hidden: 'excluded', source: 'public-commitments' },
    advisory: true,
    reasons: approval.needsApproval ? [{
      code: 'MAKER_POSITION_ALLOWANCE_INSUFFICIENT',
      requiredWei6: '1000000',
      actualWei6: '0',
    }] : [],
  });
  const preview = { maker: WALLET, raw: { maker: WALLET }, approvals: [approval] };
  const client = {
    chainId: () => 137,
    signer: () => ({ getAddress: vi.fn().mockResolvedValue(WALLET) }),
    commitments: {
      prepareSubmit: vi.fn().mockResolvedValue(preview),
      checkSubmitFundability,
      approve,
      approveCreationFee,
      submitPrepared,
    },
  } as unknown as OspexClient;
  return { client, checkSubmitFundability, approve, approveCreationFee, submitPrepared };
}

let originalTTY: boolean | undefined;
beforeEach(() => {
  originalTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true });
  vi.mocked(getClient).mockReset();
});
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalTTY, configurable: true, writable: true });
  vi.restoreAllMocks();
});

describe('--no-auto-approve', () => {
  it('makes commitments match refuse before approval or match dispatch', async () => {
    const fake = matchClient();
    vi.mocked(getClient).mockResolvedValue(fake.client as never);

    const result = await run(commitmentsMatchCommand, [
      HASH,
      '--risk-usdc',
      '1',
      '--yes',
      '--no-auto-approve',
      '--json',
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(1);
    const row = envelope(result.stdout);
    expect(row.ok).toBe(false);
    expect(row.requiresSignature).toBe(true);
    expect(row.requiresTransaction).toBe(true);
    expect(row.effects).toEqual([]);
    expect(row.errors[0]?.code).toBe('ALLOWANCE_INSUFFICIENT');
    expect(row.errors[0]?.details).toMatchObject({ required: '1000000', current: '0' });
    expect(fake.checkCommitmentFillability).not.toHaveBeenCalled();
    expect(fake.approve).not.toHaveBeenCalled();
    expect(fake.approveCreationFee).not.toHaveBeenCalled();
    expect(fake.matchFromPreview).not.toHaveBeenCalled();
  });

  it('makes commitments submit refuse before approval, signing, or posting', async () => {
    const fake = submitClient();
    vi.mocked(getClient).mockResolvedValue(fake.client as never);

    const result = await run(commitmentsSubmitCommand, [
      '--speculation',
      '101',
      '--side',
      'away',
      '--odds',
      '+110',
      '--risk-usdc',
      '1',
      '--yes',
      '--no-auto-approve',
      '--json',
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(1);
    const row = envelope(result.stdout);
    expect(row.ok).toBe(false);
    expect(row.requiresSignature).toBe(true);
    expect(row.requiresTransaction).toBe(false);
    expect(row.effects).toEqual([]);
    expect(row.errors[0]?.code).toBe('ALLOWANCE_INSUFFICIENT');
    expect(row.errors[0]?.details).toMatchObject({ required: '1000000', current: '0' });
    expect(fake.checkSubmitFundability).not.toHaveBeenCalled();
    expect(fake.approve).not.toHaveBeenCalled();
    expect(fake.approveCreationFee).not.toHaveBeenCalled();
    expect(fake.submitPrepared).not.toHaveBeenCalled();
  });

  it('lets commitments match dispatch when its allowance is sufficient', async () => {
    const sufficient = { ...APPROVAL, current: APPROVAL.required, needsApproval: false };
    expect(BigInt(sufficient.current)).toBeGreaterThanOrEqual(BigInt(sufficient.required));
    const fake = matchClient(sufficient);
    vi.mocked(getClient).mockResolvedValue(fake.client as never);

    const result = await run(commitmentsMatchCommand, [
      HASH, '--risk-usdc', '1', '--yes', '--no-auto-approve',
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(fake.approve).not.toHaveBeenCalled();
    expect(fake.matchFromPreview).toHaveBeenCalledOnce();
  });

  it('lets commitments submit dispatch when its allowance is sufficient', async () => {
    const sufficient = { ...APPROVAL, current: APPROVAL.required, needsApproval: false };
    expect(BigInt(sufficient.current)).toBeGreaterThanOrEqual(BigInt(sufficient.required));
    const fake = submitClient(sufficient);
    vi.mocked(getClient).mockResolvedValue(fake.client as never);

    const result = await run(commitmentsSubmitCommand, [
      '--speculation', '101', '--side', 'away', '--odds', '+110', '--risk-usdc', '1',
      '--yes', '--no-auto-approve',
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(fake.approve).not.toHaveBeenCalled();
    expect(fake.submitPrepared).toHaveBeenCalledOnce();
  });
});
