/**
 * Tests for `ospex doctor --strict` — the CI-friendly gate that
 * promotes a group/other-readable password file from a stderr warning
 * to a hard exit (`password_file_permissions_loose`).
 *
 * The full doctor command spins up a chain client and hits live
 * surfaces; we test the strict-gate helper in isolation
 * (`runPasswordFilePermissionGate`) — same code path the doctor's
 * action runs first, before any chain calls. The helper is the
 * load-bearing piece of `--strict`.
 *
 * POSIX-only: Windows file ACLs don't map cleanly onto POSIX bits
 * (see `checkPasswordFilePermissions` in `@ospex/sdk/signers/keystore`),
 * so the gate is a no-op there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPasswordFilePermissionGate } from '../src/commands/doctor.js';

const itPosix = process.platform !== 'win32' ? it : it.skip;

let tmpDir: string;
let prevEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-doctor-strict-'));
  prevEnv = {
    OSPEX_HOME: process.env.OSPEX_HOME,
    OSPEX_PASSWORD_FILE: process.env.OSPEX_PASSWORD_FILE,
  };
  process.env.OSPEX_HOME = tmpDir;
  delete process.env.OSPEX_PASSWORD_FILE;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writePassWithMode(content: string, mode: number, name = 'pw.pass'): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content);
  if (process.platform !== 'win32') await fs.chmod(p, mode);
  return p;
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'config.json'),
    JSON.stringify(config, null, 2) + '\n',
  );
}

/**
 * Spy on `process.exit` so a test-mode exit doesn't kill the runner.
 * Throws a sentinel error tests can catch with `.rejects.toThrow()`.
 */
function stubExit(): { stub: ReturnType<typeof vi.spyOn>; signal: string } {
  const signal = '__test_exit__';
  const stub = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`${signal}:${code ?? 0}`);
  }) as never);
  return { stub, signal };
}

function captureStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  const stub = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as never);
  return {
    writes,
    restore: () => {
      stub.mockRestore();
      process.stderr.write = orig;
    },
  };
}

describe('doctor --strict — runPasswordFilePermissionGate', () => {
  it('no password file configured → silent (no exit, no stderr)', async () => {
    const exitStub = stubExit();
    const stderr = captureStderr();
    try {
      await expect(runPasswordFilePermissionGate(true)).resolves.toBeUndefined();
      expect(exitStub.stub).not.toHaveBeenCalled();
      expect(stderr.writes).toEqual([]);
    } finally {
      stderr.restore();
      exitStub.stub.mockRestore();
    }
  });

  it('configured file missing on disk → silent (the gate is perms-only, not existence)', async () => {
    await writeConfig({ passwordFile: path.join(tmpDir, 'nope.pass') });
    const exitStub = stubExit();
    const stderr = captureStderr();
    try {
      await expect(runPasswordFilePermissionGate(true)).resolves.toBeUndefined();
      expect(exitStub.stub).not.toHaveBeenCalled();
      expect(stderr.writes).toEqual([]);
    } finally {
      stderr.restore();
      exitStub.stub.mockRestore();
    }
  });

  itPosix('tight perm (0600) → silent in both default and strict', async () => {
    const pwPath = await writePassWithMode('pw', 0o600);
    await writeConfig({ passwordFile: pwPath });

    for (const strict of [false, true]) {
      const exitStub = stubExit();
      const stderr = captureStderr();
      try {
        await expect(runPasswordFilePermissionGate(strict)).resolves.toBeUndefined();
        expect(exitStub.stub).not.toHaveBeenCalled();
        expect(stderr.writes).toEqual([]);
      } finally {
        stderr.restore();
        exitStub.stub.mockRestore();
      }
    }
  });

  itPosix('loose perm (0644) + strict=false → warning to stderr, no exit', async () => {
    const pwPath = await writePassWithMode('pw', 0o644);
    await writeConfig({ passwordFile: pwPath });
    const exitStub = stubExit();
    const stderr = captureStderr();
    try {
      await expect(runPasswordFilePermissionGate(false)).resolves.toBeUndefined();
      expect(exitStub.stub).not.toHaveBeenCalled();
      const combined = stderr.writes.join('');
      expect(combined).toMatch(/^warning: /);
      expect(combined).toMatch(/group\/other/);
      expect(combined).toMatch(/mode 0644/);
    } finally {
      stderr.restore();
      exitStub.stub.mockRestore();
    }
  });

  itPosix('loose perm (0644) + strict=true → error to stderr + process.exit(1)', async () => {
    const pwPath = await writePassWithMode('pw', 0o644);
    await writeConfig({ passwordFile: pwPath });
    const exitStub = stubExit();
    const stderr = captureStderr();
    try {
      await expect(runPasswordFilePermissionGate(true)).rejects.toThrow(
        /__test_exit__:1/,
      );
      const combined = stderr.writes.join('');
      expect(combined).toMatch(/^error \(password_file_permissions_loose\): /);
      expect(combined).toMatch(/mode 0644/);
    } finally {
      stderr.restore();
      exitStub.stub.mockRestore();
    }
  });

  itPosix('OSPEX_PASSWORD_FILE env beats config.passwordFile', async () => {
    // Env-pointed file is loose; config-pointed file is tight. Strict
    // should reject — the gate must pick the env source.
    const looseEnv = await writePassWithMode('env', 0o644, 'env.pass');
    const tightConfig = await writePassWithMode('config', 0o600, 'config.pass');
    await writeConfig({ passwordFile: tightConfig });
    process.env.OSPEX_PASSWORD_FILE = looseEnv;

    const exitStub = stubExit();
    const stderr = captureStderr();
    try {
      await expect(runPasswordFilePermissionGate(true)).rejects.toThrow(
        /__test_exit__:1/,
      );
      expect(stderr.writes.join('')).toMatch(new RegExp(`${looseEnv.replace(/\\/g, '\\\\')}`));
    } finally {
      stderr.restore();
      exitStub.stub.mockRestore();
    }
  });
});
