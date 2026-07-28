/**
 * Command-level tests for `ospex commitments submit-raw` prompt / approval /
 * USDC-unit hygiene (review findings M8 + M9).
 *
 * M8 — non-TTY guard: submit-raw signs + posts immediately (no preview-only
 *   mode), so a non-interactive run without --yes is refused UP FRONT rather
 *   than hanging on the reactive allowance prompt. Unlike submit/match, --json
 *   does NOT exempt the guard (there is no dry-run path here).
 *
 * M9 — allowance handler:
 *   (a) the amount default is the EXACT required amount, never unlimited;
 *   (b) all diagnostics go to STDERR so the --json payload on stdout stays
 *       parseable;
 *   (c) the entered amount is parsed as human USDC units (6dp), not raw wei6.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OspexAllowanceError,
  usdcDecimalToAmountWei6,
  wei6ToDecimalUSDC,
  type OspexClient,
} from '@ospex/sdk';

vi.mock('../src/lib/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/client.js')>();
  return { ...actual, getClient: vi.fn() };
});
vi.mock('../src/lib/prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/prompt.js')>();
  return { ...actual, promptYesNo: vi.fn(), promptValue: vi.fn() };
});

import { getClient } from '../src/lib/client.js';
import { promptYesNo, promptValue } from '../src/lib/prompt.js';
import { commitmentsSubmitRawCommand } from '../src/commands/commitments/submit-raw.js';

const REQUIRED_WEI6 = 1_000_000n; // 1 USDC
const REQUIRED_HUMAN = wei6ToDecimalUSDC(REQUIRED_WEI6);
const AMOUNT_PROMPT = 'Amount in USDC (number, or "max" for unlimited)';

// 6 positional args: contestId scorer lineTicks position oddsTick riskAmount
const BASE_ARGS = ['1', '0x000000000000000000000000000000000000dEaD', '0', 'upper', '191', '1000000'];

const SUCCESS = {
  hash: '0xhash',
  commitment: { status: 'open', riskAmount: '1000000', nonce: '1', expiry: '123' },
};

function allowanceError(): OspexAllowanceError {
  return new OspexAllowanceError('short', {
    required: REQUIRED_WEI6,
    current: 0n,
    spender: '0x00000000000000000000000000000000000000aa', // PositionModule (display only)
    token: '0x00000000000000000000000000000000000000bb', // USDC (display only)
  });
}

function fakeClient(cfg: {
  submitRaw: ReturnType<typeof vi.fn>;
  approve?: ReturnType<typeof vi.fn>;
}): OspexClient {
  return {
    commitments: {
      submitRaw: cfg.submitRaw,
      approve: cfg.approve ?? vi.fn().mockResolvedValue({ txHash: '0xapprove', receipt: { status: 'success' } }),
    },
  } as unknown as OspexClient;
}

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
  process.stdout.write = ((c: string | Uint8Array) => ((stdout += asStr(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((stderr += asStr(c)), true)) as typeof process.stderr.write;
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
  return { stdout, stderr, exitCode, error };
}

let origTTY: boolean | undefined;
function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
}

beforeEach(() => {
  origTTY = process.stdin.isTTY;
  vi.mocked(getClient).mockReset();
  vi.mocked(promptYesNo).mockReset();
  vi.mocked(promptValue).mockReset();
});
afterEach(() => {
  setTTY(origTTY);
  vi.restoreAllMocks();
});

describe('submit-raw — M8 non-TTY guard', () => {
  it('refuses a non-interactive run without --yes (before getClient)', async () => {
    setTTY(false);
    const { error } = await run(commitmentsSubmitRawCommand, [...BASE_ARGS]);
    expect(String((error as Error)?.message)).toMatch(/--yes is required/);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('--json does NOT exempt the guard (submit-raw has no preview-only mode)', async () => {
    setTTY(false);
    const { error } = await run(commitmentsSubmitRawCommand, [...BASE_ARGS, '--json']);
    expect(String((error as Error)?.message)).toMatch(/--yes is required/);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('--yes allows a non-interactive run', async () => {
    setTTY(false);
    const submitRaw = vi.fn().mockResolvedValue(SUCCESS);
    vi.mocked(getClient).mockResolvedValue(fakeClient({ submitRaw }) as never);
    const { error, exitCode } = await run(commitmentsSubmitRawCommand, [...BASE_ARGS, '--yes', '--json']);
    expect(error).toBeUndefined();
    expect(exitCode).toBe(0);
    expect(submitRaw).toHaveBeenCalledTimes(1);
  });
});

describe('submit-raw — M9 non-interactive approval (--yes)', () => {
  it('auto-approves the EXACT required amount, never unlimited', async () => {
    setTTY(false);
    const submitRaw = vi.fn().mockRejectedValueOnce(allowanceError()).mockResolvedValue(SUCCESS);
    const approve = vi.fn().mockResolvedValue({ txHash: '0xapprove', receipt: { status: 'success' } });
    vi.mocked(getClient).mockResolvedValue(fakeClient({ submitRaw, approve }) as never);
    const { exitCode } = await run(commitmentsSubmitRawCommand, [...BASE_ARGS, '--yes', '--json']);
    expect(exitCode).toBe(0);
    expect(approve).toHaveBeenCalledWith(REQUIRED_WEI6); // exact required, not 'max'
    expect(submitRaw).toHaveBeenCalledTimes(2); // retried after approve
  });

  it('--approve-max approves unlimited', async () => {
    setTTY(false);
    const submitRaw = vi.fn().mockRejectedValueOnce(allowanceError()).mockResolvedValue(SUCCESS);
    const approve = vi.fn().mockResolvedValue({ txHash: '0xapprove', receipt: { status: 'success' } });
    vi.mocked(getClient).mockResolvedValue(fakeClient({ submitRaw, approve }) as never);
    const { exitCode } = await run(commitmentsSubmitRawCommand, [...BASE_ARGS, '--yes', '--approve-max', '--json']);
    expect(approve).toHaveBeenCalledWith('max');
    expect(exitCode).toBe(0);
    expect(submitRaw).toHaveBeenCalledTimes(2); // retried after the unlimited approve
  });

  it('keeps stdout clean under --json — approval diagnostics go to stderr', async () => {
    setTTY(false);
    const submitRaw = vi.fn().mockRejectedValueOnce(allowanceError()).mockResolvedValue(SUCCESS);
    vi.mocked(getClient).mockResolvedValue(fakeClient({ submitRaw }) as never);
    const { stdout, stderr } = await run(commitmentsSubmitRawCommand, [...BASE_ARGS, '--yes', '--json']);
    // stdout is ONLY the JSON payload — parseable, no allowance prose.
    const parsed = JSON.parse(stdout.trim()) as { hash: string };
    expect(parsed.hash).toBe('0xhash');
    expect(stdout).not.toMatch(/USDC approval needed/);
    // The allowance diagnostics + approve-tx line landed on stderr.
    expect(stderr).toMatch(/USDC approval needed/);
    expect(stderr).toMatch(/approve tx: 0xapprove/);
  });
});

describe('submit-raw — M9 interactive approval', () => {
  it('defaults the amount prompt to the required amount (not unlimited)', async () => {
    setTTY(true);
    const submitRaw = vi.fn().mockRejectedValueOnce(allowanceError()).mockResolvedValue(SUCCESS);
    const approve = vi.fn().mockResolvedValue({ txHash: '0xapprove', receipt: { status: 'success' } });
    vi.mocked(getClient).mockResolvedValue(fakeClient({ submitRaw, approve }) as never);
    vi.mocked(promptYesNo).mockResolvedValue(true);
    vi.mocked(promptValue).mockResolvedValue(REQUIRED_HUMAN); // bare-Enter returns the default
    await run(commitmentsSubmitRawCommand, [...BASE_ARGS]);
    // The default offered IS the required amount — proving bare Enter no
    // longer means "unlimited".
    expect(promptValue).toHaveBeenCalledWith(AMOUNT_PROMPT, REQUIRED_HUMAN);
    expect(approve).toHaveBeenCalledWith(REQUIRED_WEI6);
  });

  it('parses the entered amount as human USDC units, not raw wei6', async () => {
    setTTY(true);
    const submitRaw = vi.fn().mockRejectedValueOnce(allowanceError()).mockResolvedValue(SUCCESS);
    const approve = vi.fn().mockResolvedValue({ txHash: '0xapprove', receipt: { status: 'success' } });
    vi.mocked(getClient).mockResolvedValue(fakeClient({ submitRaw, approve }) as never);
    vi.mocked(promptYesNo).mockResolvedValue(true);
    vi.mocked(promptValue).mockResolvedValue('5'); // user types "5" meaning 5 USDC
    await run(commitmentsSubmitRawCommand, [...BASE_ARGS]);
    expect(approve).toHaveBeenCalledWith(usdcDecimalToAmountWei6('5')); // 5_000_000n, NOT 5n
  });

  it('accepts an OFF-LOT-GRID custom amount (an approve amount has no lot rule)', async () => {
    // An ERC-20 approve value carries no 100-wei6 lot rule — that rule is
    // MatchingModule's constraint on a maker's SIGNED riskAmount. This prompt
    // used the maker-risk parser, which refused any off-grid amount and
    // reported the refusal as a parse failure before exiting 1.
    setTTY(true);
    const submitRaw = vi.fn().mockRejectedValueOnce(allowanceError()).mockResolvedValue(SUCCESS);
    const approve = vi.fn().mockResolvedValue({ txHash: '0xapprove', receipt: { status: 'success' } });
    vi.mocked(getClient).mockResolvedValue(fakeClient({ submitRaw, approve }) as never);
    vi.mocked(promptYesNo).mockResolvedValue(true);
    vi.mocked(promptValue).mockResolvedValue('1.000150'); // 1_000_150n, 50 off the grid
    const res = await run(commitmentsSubmitRawCommand, [...BASE_ARGS]);

    expect(1_000_150n % 100n).toBe(50n); // the value really is off-grid
    expect(approve).toHaveBeenCalledWith(1_000_150n);
    expect(res.stderr).not.toMatch(/Could not parse/);
    expect(res.exitCode).toBe(0);
  });

  it('"max" grants unlimited explicitly', async () => {
    setTTY(true);
    const submitRaw = vi.fn().mockRejectedValueOnce(allowanceError()).mockResolvedValue(SUCCESS);
    const approve = vi.fn().mockResolvedValue({ txHash: '0xapprove', receipt: { status: 'success' } });
    vi.mocked(getClient).mockResolvedValue(fakeClient({ submitRaw, approve }) as never);
    vi.mocked(promptYesNo).mockResolvedValue(true);
    vi.mocked(promptValue).mockResolvedValue('max');
    await run(commitmentsSubmitRawCommand, [...BASE_ARGS]);
    expect(approve).toHaveBeenCalledWith('max');
  });

  it('an amount below the required amount exits 1 without approving', async () => {
    setTTY(true);
    const submitRaw = vi.fn().mockRejectedValueOnce(allowanceError()).mockResolvedValue(SUCCESS);
    const approve = vi.fn();
    vi.mocked(getClient).mockResolvedValue(fakeClient({ submitRaw, approve }) as never);
    vi.mocked(promptYesNo).mockResolvedValue(true);
    vi.mocked(promptValue).mockResolvedValue('0.5'); // below the 1 USDC required
    const { exitCode } = await run(commitmentsSubmitRawCommand, [...BASE_ARGS]);
    expect(exitCode).toBe(1);
    expect(approve).not.toHaveBeenCalled();
  });

  it('a non-numeric amount exits 1 without approving', async () => {
    setTTY(true);
    const submitRaw = vi.fn().mockRejectedValueOnce(allowanceError()).mockResolvedValue(SUCCESS);
    const approve = vi.fn();
    vi.mocked(getClient).mockResolvedValue(fakeClient({ submitRaw, approve }) as never);
    vi.mocked(promptYesNo).mockResolvedValue(true);
    vi.mocked(promptValue).mockResolvedValue('abc'); // unparseable as USDC
    const { exitCode } = await run(commitmentsSubmitRawCommand, [...BASE_ARGS]);
    expect(exitCode).toBe(1);
    expect(approve).not.toHaveBeenCalled();
  });

  it('declining the approval cancels — the allowance error propagates', async () => {
    setTTY(true);
    const submitRaw = vi.fn().mockRejectedValue(allowanceError());
    vi.mocked(getClient).mockResolvedValue(fakeClient({ submitRaw }) as never);
    vi.mocked(promptYesNo).mockResolvedValue(false);
    const { error } = await run(commitmentsSubmitRawCommand, [...BASE_ARGS]);
    expect(error).toBeInstanceOf(OspexAllowanceError);
    expect(submitRaw).toHaveBeenCalledTimes(1); // never retried
  });
});
