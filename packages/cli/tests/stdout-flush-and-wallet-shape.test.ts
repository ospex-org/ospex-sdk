/**
 * Two contracts that only a REAL process writing to a REAL pipe can check.
 *
 * Every other test in this repo drives commands in-process and captures stdout
 * by swapping `process.stdout.write` for a string accumulator. That harness
 * cannot see either defect below, because both live in the gap between "the
 * command called write()" and "the consumer received the bytes" — a gap that
 * does not exist when `write` is a function appending to a string.
 *
 * ── 1. `--json | jq .` on a large failure ─────────────────────────────────
 *
 * `process.exit()` discards whatever is still queued on stdout. On POSIX a
 * write to a pipe larger than the kernel pipe buffer completes asynchronously,
 * so emit-then-exit truncates. Reproduced on Linux through the packed bundle
 * before the fix: an upstream HTTP 500 carrying a 100KB error body produced a
 * 100,782-byte envelope of which the consumer received 65,536, and
 * `JSON.parse` failed with an unterminated string.
 *
 * PLATFORM, and it decides what this file is worth (`verification-discipline.md`
 * §3b-platform): Windows stdio pipes are SYNCHRONOUS, so the large case passes
 * here whether or not the fix is present. On Linux — which is what CI runs, and
 * what an operator's `| jq` runs — it is the real check. Do not read a green
 * run on Windows as evidence.
 *
 * ── 2. `wallet` is an address or it is nothing ────────────────────────────
 *
 * `positions {list,status} <address>` take a bare positional and `commitments
 * list --maker` an unschema'd option, and all three used to reach the envelope
 * through a `.toLowerCase() as Hex` cast. A cast is not a check:
 * `positions status not-an-address --json` published
 * `wallet: "not-an-address", walletRole: "subject"`, against an exported type
 * of `0x${string} | null`.
 *
 * These run as subprocesses too, so they exercise the same binary an agent
 * runs rather than the program tree an in-process test builds.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

/**
 * Prefer the packed bundle — it is the artifact a user installs, and the one
 * the review reproduced against. CI builds it before running tests. Locally,
 * `yarn workspace @ospex/cli test` does not, so fall back to the same entry
 * point through tsx. Both are the real CLI; which one ran is asserted below so
 * a reader is never guessing.
 */
const DIST = path.join(PKG, 'dist/index.js');
const TSX = path.resolve(PKG, '../../node_modules/tsx/dist/cli.mjs');
const SRC = path.join(PKG, 'src/index.ts');
const USING_BUNDLE = existsSync(DIST);
const ARGV0: string[] = USING_BUNDLE ? [DIST] : [TSX, SRC];

/** Bytes of upstream error body. Comfortably past a 64KiB pipe buffer. */
const BIG = 200_000;
const PIPE_BUFFER_BYTES = 65_536;

let server: Server;
let port: number;
let bodyBytes = 32;
let tmpHome: string;

beforeAll(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-flush-'));
  server = createServer((req, res) => {
    // A commitments LIST answers 200 with an empty page, so a command can reach
    // its SUCCESS envelope here. Everything else fails, for the flush cases.
    if ((req.url ?? '').startsWith('/v1/commitments')) {
      const ok = JSON.stringify({ commitments: [] });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(ok) });
      res.end(ok);
      return;
    }
    // The padding goes in the field the SDK lifts into `errors[0].message`;
    // padding any other key produces a small envelope and tests nothing.
    const body = JSON.stringify({ error: 'E'.repeat(bodyBytes), code: 'INTERNAL' });
    res.writeHead(500, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpHome, { recursive: true, force: true });
});

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run the CLI as a child process with stdout on a PIPE, and drain it fully. */
function run(args: string[], apiUrl: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...ARGV0, ...args, '--json'], {
      cwd: PKG,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OSPEX_HOME: tmpHome,
        OSPEX_API_URL: apiUrl,
        OSPEX_RPC_URL: apiUrl,
        OSPEX_CHAIN_ID: '137',
        OSPEX_KEYSTORE_PATH: '',
        OSPEX_PASSWORD_FILE: '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

describe('stdout survives process exit on a real pipe', () => {
  it(`runs the ${USING_BUNDLE ? 'packed bundle' : 'source entry point via tsx'}`, () => {
    // Not decoration: if neither target existed, `spawn` would fail in a way
    // that reads like the CLI misbehaving rather than the harness misfiring.
    expect(existsSync(ARGV0[0] as string)).toBe(true);
  });

  it('a small failure envelope is parseable (control)', async () => {
    bodyBytes = 32;
    const { stdout, code } = await run(['health'], `http://127.0.0.1:${port}`);
    expect(code).toBe(1);
    const env = JSON.parse(stdout) as { ok: boolean; errors: Array<{ code: string }> };
    expect(env.ok).toBe(false);
    expect(env.errors[0]?.code).toBe('API_ERROR');
    // Pins the control as a control: it must NOT be big enough to exercise the
    // pipe boundary, or it stops being the other half of the comparison.
    expect(stdout.length).toBeLessThan(PIPE_BUFFER_BYTES);
  }, 60_000);

  it('a failure envelope larger than the pipe buffer arrives whole', async () => {
    bodyBytes = BIG;
    const { stdout, code } = await run(['health'], `http://127.0.0.1:${port}`);

    // Assert the case DISCRIMINATES before asserting the outcome. If a later
    // change bounds the error message, this envelope shrinks below the pipe
    // buffer and the test would keep passing while testing nothing.
    expect(
      stdout.length,
      'the fixture must produce an envelope past the pipe buffer, or it cannot ' +
        'exercise the truncation it exists to catch',
    ).toBeGreaterThan(PIPE_BUFFER_BYTES);

    expect(code).toBe(1);
    // The whole document, not a prefix of it. Before the fix this threw
    // "Unterminated string in JSON at position 65536" on Linux.
    const env = JSON.parse(stdout) as { ok: boolean; errors: Array<{ code: string }> };
    expect(env.ok).toBe(false);
    expect(env.errors[0]?.code).toBe('API_ERROR');
  }, 60_000);
});

describe('wallet is a real address or it is null — in a real process', () => {
  const DEAD = 'http://127.0.0.1:9';
  const VALID = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const VALID_LC = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

  interface Shoulder { wallet: string | null; walletRole: string }

  const cases: Array<[string, string[], Shoulder]> = [
    ['positions status <malformed>', ['positions', 'status', 'not-an-address'],
      { wallet: null, walletRole: 'none' }],
    ['positions list <malformed>', ['positions', 'list', 'not-an-address'],
      { wallet: null, walletRole: 'none' }],
    ['commitments list --maker <malformed>', ['commitments', 'list', '--maker', 'not-an-address'],
      { wallet: null, walletRole: 'none' }],
    // A 0x-prefixed value of the WRONG LENGTH: the shape most likely to slip
    // through a prefix-only check, and indistinguishable from a real address
    // to anything that only looks at the first two characters.
    ['positions status <0x, wrong length>', ['positions', 'status', '0xdeadbeef'],
      { wallet: null, walletRole: 'none' }],
    // NEGATIVE CONTROL. Without this, a build that reported `wallet: null` for
    // EVERY read would pass every case above.
    ['positions status <valid>', ['positions', 'status', VALID],
      { wallet: VALID_LC, walletRole: 'subject' }],
  ];

  for (const [label, args, expected] of cases) {
    it(`${label} → wallet=${JSON.stringify(expected.wallet)} role=${expected.walletRole}`, async () => {
      const { stdout, code } = await run(args, DEAD);
      expect(code).toBe(1);
      const env = JSON.parse(stdout) as Shoulder & { ok: boolean };
      expect(env.ok).toBe(false);
      expect({ wallet: env.wallet, walletRole: env.walletRole }).toStrictEqual(expected);
      // The exported type is `0x${string} | null`. Anything else is a contract
      // break whatever the role says.
      if (env.wallet !== null) expect(env.wallet).toMatch(/^0x[0-9a-f]{40}$/);
    }, 60_000);
  }
});

describe('the SUCCESS envelope narrows its wallet too', () => {
  /**
   * The failure envelope is narrowed twice — once by the command, once by
   * `withReadFailureEnvelope` — so reverting the command's half leaves the
   * failure path correct and every case above still green. The SUCCESS
   * envelope never passes through the wrapper, so this is the only place the
   * command-level narrowing is load-bearing on its own.
   */
  it('commitments list --maker <malformed> succeeds without publishing a bad wallet', async () => {
    bodyBytes = 32;
    const { stdout, code } = await run(
      ['commitments', 'list', '--maker', 'not-an-address'],
      `http://127.0.0.1:${port}`,
    );
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as { ok: boolean; wallet: string | null; walletRole: string };
    // Assert the case DISCRIMINATES: it has to reach the success path, or it is
    // just another failure-envelope test wearing a different name.
    expect(env.ok, 'must reach the success envelope for this case to mean anything').toBe(true);
    expect(env.wallet).toBeNull();
    expect(env.walletRole).toBe('none');
  }, 60_000);

  it('commitments list --maker <valid> still names the filter (control)', async () => {
    bodyBytes = 32;
    const { stdout, code } = await run(
      ['commitments', 'list', '--maker', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'],
      `http://127.0.0.1:${port}`,
    );
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as { ok: boolean; wallet: string | null; walletRole: string };
    expect(env.ok).toBe(true);
    expect(env.wallet).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
    expect(env.walletRole).toBe('filter');
  }, 60_000);
});
