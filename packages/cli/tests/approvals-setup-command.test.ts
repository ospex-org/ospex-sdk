/**
 * COMMAND-LEVEL tests for `ospex approvals setup` (issue #176).
 *
 * The planner/renderer suite (`approvals-setup.test.ts`) proves that
 * `parseUsdcInput` refuses an explicit zero. It does NOT prove that the
 * command actually calls it, nor that the refusal happens BEFORE any
 * signer / chain work — the whole safety claim of the fix.
 *
 * That gap is not theoretical: deleting the two pre-parse calls from
 * `approvals/setup.ts` leaves the planner suite fully green, because
 * `buildSetupPlan` re-parses internally and would still throw — just
 * AFTER `getClient({ requiresSigner: true })` has unlocked the keystore
 * and read allowances from chain. Same exit code, same stderr, entirely
 * different safety property.
 *
 * So the load-bearing assertion in this file is `expect(getClient).not
 * .toHaveBeenCalled()`. It is what makes the ordering guarantee
 * mutation-sensitive rather than aspirational. If you move, weaken, or
 * remove the pre-parse, these tests go red.
 *
 * Covers, per the issue's acceptance criteria: `--risk-usdc 0`,
 * `--fee-usdc 0`, and both together.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OspexValidationError } from '@ospex/sdk';

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
import { approvalsSetupCommand } from '../src/commands/approvals/setup.js';

class ProcessExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function asStr(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

async function run(
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
    exitViaCall = typeof code === 'number' ? code : 0;
    throw new ProcessExitSignal(exitViaCall);
  }) as never);
  let error: unknown;
  try {
    await approvalsSetupCommand.parseAsync(argv, { from: 'user' });
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

/**
 * The CLI's top-level handler (`index.ts main()`) is what turns a thrown
 * OspexError into `error (CODE): msg` on stderr + exit 1. The command
 * action itself just throws, so assert on the thrown error the way the
 * top-level handler would read it.
 */
function expectValidationRefusal(error: unknown): OspexValidationError {
  expect(error).toBeInstanceOf(OspexValidationError);
  const err = error as OspexValidationError;
  expect(err.code).toBe('VALIDATION_ERROR');
  return err;
}

beforeEach(() => {
  vi.mocked(getClient).mockReset();
  vi.mocked(promptYesNo).mockReset();
  vi.mocked(promptValue).mockReset();
  // Any call to getClient is a failure of the ordering guarantee. Make
  // it loud rather than returning a usable client, so a regression can
  // never limp past this line into chain work.
  vi.mocked(getClient).mockImplementation((() => {
    throw new Error('getClient must not be reached — zero is refused before any signer/chain work');
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approvals setup — explicit zero is refused before any signer/chain work', () => {
  const CASES: Array<{ name: string; argv: string[]; flag: string }> = [
    {
      name: '--risk-usdc 0',
      argv: ['--risk-usdc', '0', '--yes', '--json'],
      flag: '--risk-usdc',
    },
    {
      name: '--fee-usdc 0',
      argv: ['--fee-usdc', '0', '--yes', '--json'],
      flag: '--fee-usdc',
    },
    {
      // The reported repro from issue #176.
      name: 'both dimensions zero',
      argv: ['--risk-usdc', '0', '--fee-usdc', '0', '--yes', '--json'],
      flag: '--risk-usdc',
    },
  ];

  for (const c of CASES) {
    it(`${c.name}: throws VALIDATION_ERROR, emits no envelope, and never builds a client`, async () => {
      const { stdout, error } = await run(c.argv);

      const err = expectValidationRefusal(error);
      expect(err.message).toContain('is not a revocation');
      expect(err.message).toContain(`\`${c.flag} 0\``);

      // THE load-bearing assertion. Removing the pre-parse from
      // setup.ts still produces a VALIDATION_ERROR (buildSetupPlan
      // re-parses) — but only after the keystore is unlocked and
      // allowances are read. This is what catches that.
      expect(getClient).not.toHaveBeenCalled();

      // No green envelope — and no envelope at all — on stdout.
      expect(stdout).toBe('');

      // No interactive path was entered.
      expect(promptYesNo).not.toHaveBeenCalled();
      expect(promptValue).not.toHaveBeenCalled();
    });
  }

  it('names the dimension the caller actually typed, not a fixed one', async () => {
    const { error } = await run(['--fee-usdc', '0', '--yes', '--json']);
    const err = expectValidationRefusal(error);
    expect(err.message).toContain('`--fee-usdc 0`');
    expect(err.message).not.toContain('`--risk-usdc 0`');
    expect(err.field).toBe('--fee-usdc');
  });

  it('points the operator at both real revocation surfaces', async () => {
    const { error } = await run(['--risk-usdc', '0', '--yes', '--json']);
    const err = expectValidationRefusal(error);
    expect(err.message).toContain('ospex commitments approve 0');
    expect(err.message).toContain('approve(TreasuryModule, 0)');
  });

  it('refuses a zero even in decimal-padded form', async () => {
    for (const zero of ['0.0', '0.000000']) {
      vi.mocked(getClient).mockClear();
      const { stdout, error } = await run(['--fee-usdc', zero, '--yes', '--json']);
      expectValidationRefusal(error);
      expect(getClient).not.toHaveBeenCalled();
      expect(stdout).toBe('');
    }
  });

  it('refuses bad-shape input the same way, before any client work', async () => {
    const { stdout, error } = await run(['--risk-usdc', '1e3', '--yes', '--json']);
    const err = expectValidationRefusal(error);
    expect(err.message).toContain('Invalid USDC amount');
    expect(getClient).not.toHaveBeenCalled();
    expect(stdout).toBe('');
  });
});

describe('approvals setup — positive control: valid input reaches the client', () => {
  // Without this, every assertion above would still pass if the command
  // were broken to reject everything. This proves the refusal is
  // specific to zero / bad shape rather than a blanket failure, and
  // that getClient IS the next step for valid input.
  it('a non-zero amount gets past the guard and calls getClient', async () => {
    const { error } = await run(['--risk-usdc', '50', '--yes', '--json']);
    expect(getClient).toHaveBeenCalledTimes(1);
    // The mocked getClient throws by design; what matters is that the
    // command got far enough to call it, and that the failure is NOT a
    // validation refusal.
    expect(error).not.toBeInstanceOf(OspexValidationError);
  });

  it('"skip" is still accepted as leave-unchanged and reaches the client', async () => {
    const { error } = await run(['--risk-usdc', '50', '--fee-usdc', 'skip', '--yes', '--json']);
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(error).not.toBeInstanceOf(OspexValidationError);
  });

  it('"max" is still accepted and reaches the client', async () => {
    const { error } = await run(['--fee-usdc', 'max', '--yes', '--json']);
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(error).not.toBeInstanceOf(OspexValidationError);
  });
});
