/**
 * Class A failure-envelope SWEEP — the class, not one command.
 *
 * `AGENT_ENVELOPE_SPEC.md` §6 requires that once `getClient()` has returned,
 * a Class A command's `--json` failure leaves a parseable v2 envelope on
 * stdout, so `--json | jq .` works on failures as well as successes. A new
 * command that quietly skips that wiring is invisible to every per-command
 * test, because a per-command test only exists for commands somebody
 * remembered to write one for. `commitments filled-risk` shipped without it
 * and a reviewer found it by hand.
 *
 * So this file drives EVERY Class A command against a dead endpoint and
 * records what actually reached stdout. Three things are pinned:
 *
 *   1. The Class A roster is DERIVED from `docs/AGENT_ENVELOPE_SPEC.md`
 *      §4.1–4.3 and compared to a literal list here. Expected side literal,
 *      derived side from the document — never both from the same place, or
 *      the comparison only proves the parser is deterministic.
 *   2. §4.1–4.4 are exhaustive over the REGISTERED COMMAND TREE. A command
 *      that is neither Class A nor explicitly carved out is unclassified, and
 *      unclassified is how `filled-risk` got here.
 *   3. Every Class A command is executed and its stdout classified against a
 *      per-command literal expectation. One `it()` per command, so a failure
 *      names the command rather than a count.
 *
 * ── The gap this sweep records, deliberately ───────────────────────────────
 *
 * Measured at the time of writing, against a dead API + dead RPC: all 14
 * Class A write commands emit the envelope, `doctor` and `commitments
 * filled-risk` emit it, and the OTHER 19 read commands emit NOTHING on
 * stdout — a plain stderr line and exit 1. That is a real, pre-existing
 * violation of §6 with a real consequence: an agent piping `--json` through
 * `jq` gets an empty document from a failed `contests show`, `positions
 * status`, `odds show`, and sixteen others, and has to fall back to scraping
 * stderr.
 *
 * They are marked `'no-envelope'` below to record the measurement, NOT to
 * bless it (`verification-discipline.md` §3j). The expectation is exact in
 * both directions, so the list can only change deliberately: a command that
 * starts emitting the envelope reddens this file until its row is updated,
 * and a command that stops reddens it too. Closing those 19 is a follow-up —
 * it touches 19 command files that this PR does not otherwise change.
 *
 * ── Mechanism ──────────────────────────────────────────────────────────────
 *
 * Each command runs in-process through the REAL program tree
 * (`makeProgram().parseAsync`), with `apiUrl` and `rpcUrl` pointed at the
 * IPv4 discard port so the first network call fails wherever the command
 * makes it. Signer-requiring commands get a real on-disk keystore (weak
 * scrypt, throwaway Anvil key) plus a password file, so the unlock SUCCEEDS
 * and the failure is genuinely post-client rather than a signer-resolution
 * refusal that never reaches the window §6 is about.
 *
 * `process.exit` is stubbed (commands call it after emitting) and stdout is
 * captured. Only stdout counts: an envelope written to stderr does not
 * satisfy `--json | jq .`, and the whole captured stdout must parse as ONE
 * JSON document, so a stray log line before the envelope fails here too.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptKeystoreJson } from 'ethers';
import type { Command } from '@commander-js/extra-typings';
import { makeProgram } from '../src/index.js';

/* ------------------------------------------------------------------ */
/* The authoritative document                                          */
/* ------------------------------------------------------------------ */

const SPEC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/AGENT_ENVELOPE_SPEC.md',
);

/**
 * Pull the command names out of one `### 4.x` subsection.
 *
 * §4.1–4.3 are a single sentence of backticked names; §4.4 is a bullet list
 * whose names sit before an em dash and whose prose is full of unrelated
 * backticks (`--json`, `schemaVersion: 1`, NDJSON shapes), so that section is
 * read bullet-by-bullet and only the head of each bullet is scanned.
 *
 * Every step that can silently yield an empty set throws instead. A parser
 * that quietly returns `[]` would make the roster comparison below pass by
 * matching nothing on both sides once the literal is also emptied — the
 * failure mode this whole file exists to prevent, one level down.
 */
function namesFromSection(markdown: string, heading: string, style: 'sentence' | 'bullets'): string[] {
  const start = markdown.indexOf(`### ${heading}`);
  if (start === -1) throw new Error(`AGENT_ENVELOPE_SPEC.md: no "### ${heading}" heading`);
  const rest = markdown.slice(start + heading.length + 4);
  const end = rest.search(/\n(?:### |## |---)/);
  const body = (end === -1 ? rest : rest.slice(0, end)).trim();
  if (body === '') throw new Error(`AGENT_ENVELOPE_SPEC.md: "${heading}" is empty`);

  const names: string[] = [];
  if (style === 'sentence') {
    // The roster is the FIRST paragraph; later paragraphs are commentary that
    // re-mentions individual commands (§4.2 does exactly that for
    // `commitments approve`), and folding those in would let a name survive
    // deletion from the roster itself.
    const firstParagraph = body.split(/\n\s*\n/)[0] ?? '';
    for (const m of firstParagraph.matchAll(/`([^`]+)`/g)) names.push(m[1] as string);
  } else {
    for (const line of body.split('\n')) {
      if (!line.trimStart().startsWith('- ')) continue;
      const head = line.split(' — ')[0] ?? '';
      for (const m of head.matchAll(/`([^`]+)`/g)) names.push(m[1] as string);
    }
  }
  if (names.length === 0) {
    throw new Error(`AGENT_ENVELOPE_SPEC.md: parsed no command names from "${heading}"`);
  }
  return names;
}

function deriveFromSpec(): { classA: string[]; notInScope: string[] } {
  const markdown = readFileSync(SPEC_PATH, 'utf8');
  return {
    classA: [
      ...namesFromSection(markdown, '4.1 Reads', 'sentence'),
      ...namesFromSection(markdown, '4.2 Preview-bearing writes', 'sentence'),
      ...namesFromSection(markdown, '4.3 Fire-and-forget writes', 'sentence'),
    ],
    notInScope: namesFromSection(markdown, '4.4 Not in scope (intentionally)', 'bullets'),
  };
}

/* ------------------------------------------------------------------ */
/* The literal pins                                                    */
/* ------------------------------------------------------------------ */

/**
 * The Class A roster as this test expects to find it in §4.1–4.3. Written out
 * by hand so that DELETING a command from the spec — the cheap way to make a
 * sweep stop covering something — reddens here instead of silently shrinking
 * the sweep.
 */
const CLASS_A_PIN: readonly string[] = [
  // §4.1 Reads
  'health',
  'doctor',
  'auth check',
  'approvals show',
  'wallet address',
  'commitments list',
  'commitments show',
  'commitments fillability',
  'commitments nonce-floor',
  'commitments filled-risk',
  'contests list',
  'contests show',
  'contests wait-verified',
  'contests wait-scored',
  'contests score-status',
  'games list',
  'leaderboard show',
  'odds show',
  'positions list',
  'positions status',
  'positions history',
  'speculations list',
  'speculations show',
  // §4.2 Preview-bearing writes
  'commitments submit',
  'commitments match',
  'commitments approve',
  'commitments approve-raw',
  'approvals setup',
  // §4.3 Fire-and-forget writes
  'commitments cancel',
  'commitments cancel-onchain',
  'commitments cancel-all',
  'claim',
  'claim-all',
  'settle',
  'contests create',
  'contests score',
  'contests update-markets',
];

/** The §4.4 carve-outs, same reasoning as the pin above. */
const NOT_IN_SCOPE_PIN: readonly string[] = [
  'odds watch',
  'own-state watch',
  'init',
  'wallet import',
  'wallet unlock',
  'wallet lock',
  'auth use-foundry',
  'auth clear-foundry',
  'commitments submit-raw',
];

/* ------------------------------------------------------------------ */
/* Probe table — argv + the expectation, one row per Class A command    */
/* ------------------------------------------------------------------ */

/**
 * `'envelope'`    — §6 honoured: nonzero exit, stdout is one parseable v2
 *                   envelope with `ok: false`.
 * `'no-envelope'` — nonzero exit, stdout EMPTY. The outstanding gap; see the
 *                   header. Not an approval.
 * `'no-client'`   — the command builds no SDK client, so a dead endpoint
 *                   cannot push it into §6's post-client window at all. It
 *                   still has to leave one parseable v2 envelope on stdout,
 *                   which is what gets asserted.
 */
type Expectation = 'envelope' | 'no-envelope' | 'no-client';

/**
 * Two legitimate shapes of `ok: false` on stdout, and they are not
 * interchangeable:
 *
 * `'thrown'`   — the command caught a thrown error and emitted it. `errors[]`
 *                carries the taxonomy code and `payload` is `null` (§6).
 * `'reported'` — the command's whole job is to DIAGNOSE, so a post-client
 *                failure becomes a finding inside the report rather than a
 *                thrown error. `doctor` is the only such command: `ok: false`,
 *                `errors: []`, and the report itself in `payload`. Asserting
 *                `payload: null` on it would be asserting that the diagnosis
 *                is discarded.
 */
type EnvelopeShape = 'thrown' | 'reported';

interface Probe {
  /** Argv AFTER the command path and BEFORE `--json`. */
  args: readonly string[];
  /** True when the command needs a working signer to get past `getClient()`. */
  signer?: boolean;
  expect: Expectation;
  /** Defaults to `'thrown'`; see {@link EnvelopeShape}. */
  shape?: EnvelopeShape;
  /** Why this row reads the way it does, where that is not obvious. */
  note?: string;
}

const OTHER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const A_HASH = `0x${'ab'.repeat(32)}`;

const PROBES: Record<string, Probe> = {
  /* §4.1 Reads */
  health: { args: [], expect: 'no-envelope' },
  doctor: {
    args: [],
    expect: 'envelope',
    shape: 'reported',
    note: 'converts a post-client failure into a finding in its report rather than a throw.',
  },
  'auth check': {
    args: [],
    expect: 'no-client',
    note: 'diagnoses the LOCAL signer configuration; never constructs a client.',
  },
  'approvals show': { args: ['--address', OTHER_ADDRESS], expect: 'no-envelope' },
  'wallet address': {
    args: [],
    signer: true,
    expect: 'no-client',
    note: 'reads the keystore only; never constructs a client.',
  },
  'commitments list': { args: [], expect: 'no-envelope' },
  'commitments show': { args: [A_HASH], expect: 'no-envelope' },
  'commitments fillability': { args: [A_HASH], expect: 'no-envelope' },
  'commitments nonce-floor': {
    args: ['--maker', OTHER_ADDRESS, '--contest-id', '1', '--scorer', OTHER_ADDRESS, '--line', '0'],
    expect: 'no-envelope',
  },
  'commitments filled-risk': { args: [A_HASH], expect: 'envelope' },
  'contests list': { args: [], expect: 'no-envelope' },
  'contests show': { args: ['1'], expect: 'no-envelope' },
  'contests wait-verified': { args: ['1'], expect: 'no-envelope' },
  'contests wait-scored': { args: ['1'], expect: 'no-envelope' },
  'contests score-status': { args: ['1'], expect: 'no-envelope' },
  'games list': { args: [], expect: 'no-envelope' },
  'leaderboard show': { args: [], expect: 'no-envelope' },
  'odds show': { args: ['1'], expect: 'no-envelope' },
  'positions list': { args: [OTHER_ADDRESS], expect: 'no-envelope' },
  'positions status': { args: [OTHER_ADDRESS], expect: 'no-envelope' },
  'positions history': { args: ['--address', OTHER_ADDRESS], expect: 'no-envelope' },
  'speculations list': { args: [], expect: 'no-envelope' },
  'speculations show': { args: ['1'], expect: 'no-envelope' },

  /* §4.2 Preview-bearing writes */
  'commitments submit': {
    args: [
      '--contest', '42',
      '--market', 'moneyline',
      '--side', 'home',
      '--odds', '150',
      '--risk-usdc', '25',
      // Skips the unlock in preview mode, so the failure is the dead API.
      '--expected-address', OTHER_ADDRESS,
    ],
    expect: 'envelope',
  },
  'commitments match': {
    args: [A_HASH, '--risk-usdc', '1', '--expected-address', OTHER_ADDRESS],
    expect: 'envelope',
  },
  'commitments approve': { args: ['25', '--yes'], signer: true, expect: 'envelope' },
  'commitments approve-raw': { args: ['25000000', '--yes'], signer: true, expect: 'envelope' },
  'approvals setup': { args: ['--risk-usdc', '5', '--yes'], signer: true, expect: 'envelope' },

  /* §4.3 Fire-and-forget writes */
  'commitments cancel': { args: [A_HASH], signer: true, expect: 'envelope' },
  'commitments cancel-onchain': { args: [A_HASH], signer: true, expect: 'envelope' },
  'commitments cancel-all': {
    args: ['--contest-id', '1', '--scorer', OTHER_ADDRESS, '--line', '0', '--new-min-nonce', '5'],
    signer: true,
    expect: 'envelope',
  },
  claim: { args: ['1', '--type', 'upper'], signer: true, expect: 'envelope' },
  'claim-all': { args: [], signer: true, expect: 'envelope' },
  settle: { args: ['1'], signer: true, expect: 'envelope' },
  'contests create': {
    args: ['--game-id', 'a-game-id', '--yes', '--no-wait'],
    signer: true,
    expect: 'envelope',
  },
  'contests score': { args: ['1'], signer: true, expect: 'envelope' },
  'contests update-markets': { args: ['1'], signer: true, expect: 'envelope' },
};

/* ------------------------------------------------------------------ */
/* Fixtures — dead endpoints + a keystore that really unlocks           */
/* ------------------------------------------------------------------ */

/** IPv4 discard port: connections are refused immediately, so no probe waits. */
const DEAD_URL = 'http://127.0.0.1:9';

// Anvil account #0 — a throwaway test key, never used for anything real.
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PASSPHRASE = 'test-passphrase-1234';

const TOUCHED_ENV = [
  'OSPEX_HOME',
  'OSPEX_API_URL',
  'OSPEX_RPC_URL',
  'OSPEX_CHAIN_ID',
  'OSPEX_KEYSTORE_PATH',
  'OSPEX_PASSWORD_FILE',
  'OSPEX_FOUNDRY_KEYSTORES_DIR',
  'FOUNDRY_DIR',
] as const;

let tmpDir: string;
let keystorePath: string;
let passwordPath: string;
const envSnapshot: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of TOUCHED_ENV) envSnapshot[key] = process.env[key];

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ospex-classa-sweep-'));
  keystorePath = path.join(tmpDir, 'keystore.json');
  passwordPath = path.join(tmpDir, 'passphrase.txt');
  // Weak scrypt on purpose: this keystore guards a published test key, and
  // 37 command runs should not each pay a production KDF.
  await fs.writeFile(
    keystorePath,
    await encryptKeystoreJson({ address: TEST_ADDRESS, privateKey: TEST_PK }, PASSPHRASE, {
      scrypt: { N: 1 << 10 },
    }),
  );
  await fs.writeFile(passwordPath, PASSPHRASE);
  await fs.writeFile(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({ apiUrl: DEAD_URL, rpcUrl: DEAD_URL, chainId: 137 }, null, 2),
  );

  process.env.OSPEX_HOME = tmpDir;
  process.env.OSPEX_API_URL = DEAD_URL;
  process.env.OSPEX_RPC_URL = DEAD_URL;
  process.env.OSPEX_CHAIN_ID = '137';
  // Cleared, not merely defaulted: a developer shell that pins a keystore or a
  // Foundry directory would otherwise change which signer the probes resolve,
  // and the sweep would be measuring that machine rather than the code.
  delete process.env.OSPEX_KEYSTORE_PATH;
  delete process.env.OSPEX_PASSWORD_FILE;
  delete process.env.OSPEX_FOUNDRY_KEYSTORES_DIR;
  delete process.env.FOUNDRY_DIR;
}, 60_000);

afterAll(async () => {
  for (const key of TOUCHED_ENV) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

class ExitSignal extends Error {
  constructor(readonly exitCode: number) {
    super(`process.exit(${exitCode})`);
  }
}

/** A probe that never settles must produce a VERDICT, not a stalled suite. */
const PROBE_TIMEOUT_MS = 20_000;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  hung: boolean;
  /**
   * An error escaped the command's action instead of being emitted.
   *
   * This is what §6's stderr fallback looks like from inside the harness: the
   * real binary's `main()` catches the escapee, prints it to stderr and exits
   * 1, but this runner calls `parseAsync` directly, so the escape is visible
   * here rather than as stderr text. Recorded because "nothing on stdout"
   * alone cannot tell a command that let the failure escape from one that
   * swallowed the failure entirely — the second would be a far worse bug
   * wearing the same appearance.
   */
  escaped: Error | null;
}

async function runCommand(argv: readonly string[]): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;

  let exitCode = 0;
  let hung = false;
  let escaped: Error | null = null;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitSignal(exitCode);
  }) as never);
  const previousExitCode = process.exitCode;
  process.exitCode = 0;

  try {
    const program = makeProgram();
    // Commander exits the process on an argv error; route that through the
    // same signal so a mistyped probe row surfaces as a verdict.
    program.exitOverride((err) => {
      throw new ExitSignal(err.exitCode);
    });
    await Promise.race([
      program.parseAsync(['node', 'ospex', ...argv]),
      new Promise((_resolve, reject) => {
        // Unref'd: the loser of this race is never cleared, and a ref'd timer
        // would hold the event loop open for the full window on every run.
        const timer = setTimeout(() => reject(new ExitSignal(-1)), PROBE_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } catch (err) {
    if (err instanceof ExitSignal) {
      if (err.exitCode === -1) hung = true;
      else exitCode = err.exitCode;
    } else {
      escaped = err instanceof Error ? err : new Error(String(err));
      exitCode = 1;
    }
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
    exitSpy.mockRestore();
  }

  if (exitCode === 0 && process.exitCode !== undefined && process.exitCode !== 0) {
    exitCode = Number(process.exitCode);
  }
  process.exitCode = previousExitCode;
  return { stdout, stderr, exitCode, hung, escaped };
}

interface ParsedEnvelope {
  schemaVersion?: number;
  ok?: boolean;
  action?: string;
  payload?: unknown;
  errors?: unknown[];
}

/** Parse the WHOLE stdout. A prefix line, a suffix line, or two documents all fail. */
function parseWholeStdout(stdout: string): ParsedEnvelope | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed) as ParsedEnvelope;
  } catch {
    return null;
  }
}

function argvFor(name: string, probe: Probe): string[] {
  const signerFlags = probe.signer === true
    ? ['--keystore-path', keystorePath, '--password-file', passwordPath]
    : [];
  return [...name.split(' '), ...probe.args, ...signerFlags, '--json'];
}

/* ------------------------------------------------------------------ */
/* 1. The roster is what the spec says it is                           */
/* ------------------------------------------------------------------ */

describe('Class A roster — derived from AGENT_ENVELOPE_SPEC.md §4', () => {
  it('§4.1–4.3 list exactly the commands pinned here', () => {
    const { classA } = deriveFromSpec();
    expect([...classA].sort()).toStrictEqual([...CLASS_A_PIN].sort());
    // Order-independent above; this catches a name listed twice, which the
    // sorted comparison of two equal-length lists would otherwise hide only
    // if the duplicate replaced a different name.
    expect(new Set(classA).size).toBe(classA.length);
  });

  it('§4.4 carves out exactly the commands pinned here', () => {
    const { notInScope } = deriveFromSpec();
    expect([...notInScope].sort()).toStrictEqual([...NOT_IN_SCOPE_PIN].sort());
  });

  it('every Class A name resolves to a real leaf command in the program tree', () => {
    const leaves = leafCommandPaths(makeProgram());
    const missing = CLASS_A_PIN.filter((name) => !leaves.has(name));
    expect(missing).toStrictEqual([]);
  });

  it('every registered leaf command is classified — Class A or an explicit §4.4 carve-out', () => {
    // The gap that let `filled-risk` ship unwired is "nobody looked at it".
    // A new command lands here on the day it is registered.
    const leaves = [...leafCommandPaths(makeProgram())];
    const classified = new Set([...CLASS_A_PIN, ...NOT_IN_SCOPE_PIN]);
    const unclassified = leaves.filter((name) => !classified.has(name)).sort();
    expect(unclassified).toStrictEqual([]);
  });

  it('has a probe row for every Class A command, and no rows for anything else', () => {
    expect(Object.keys(PROBES).sort()).toStrictEqual([...CLASS_A_PIN].sort());
  });
});

/** Every command path in the tree that actually does something (no group nodes, no `help`). */
function leafCommandPaths(program: Command): Set<string> {
  const out = new Set<string>();
  const walk = (cmd: Command, prefix: string[]): void => {
    for (const child of cmd.commands as Command[]) {
      const name = child.name();
      if (name === 'help') continue;
      const trail = [...prefix, name];
      const grandchildren = (child.commands as Command[]).filter((c) => c.name() !== 'help');
      if (grandchildren.length === 0) out.add(trail.join(' '));
      else walk(child, trail);
    }
  };
  walk(program, []);
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. What each Class A command actually puts on stdout when it fails  */
/* ------------------------------------------------------------------ */

describe('Class A commands — what reaches stdout on a post-client failure', () => {
  // Negative control for the whole sweep: if the dead endpoints were not
  // actually dead — a proxy answering, a stale config file winning — every
  // command would SUCCEED and every `'no-envelope'` row would still pass,
  // because a successful command writes nothing to stdout without `--json`…
  // and with `--json` writes an `ok: true` envelope, which this classifier
  // does NOT accept for an `'envelope'` row. This case makes the premise
  // explicit rather than assumed.
  it('control: the probe endpoints really do fail a read', async () => {
    const { stdout, exitCode } = await runCommand(['commitments', 'filled-risk', A_HASH, '--json']);
    const envelope = parseWholeStdout(stdout);
    expect(exitCode).not.toBe(0);
    expect(envelope?.ok).toBe(false);
  }, 30_000);

  for (const [name, probe] of Object.entries(PROBES)) {
    const label =
      probe.expect === 'envelope'
        ? `${name} — emits a parseable v2 failure envelope on stdout`
        : probe.expect === 'no-envelope'
          ? `${name} — KNOWN GAP: emits nothing on stdout (§6 not yet honoured)`
          : `${name} — builds no client; still emits one parseable v2 envelope`;

    it(
      label,
      async () => {
        const { stdout, exitCode, hung, escaped } = await runCommand(argvFor(name, probe));
        expect(hung, `${name} did not settle within ${PROBE_TIMEOUT_MS}ms`).toBe(false);

        const envelope = parseWholeStdout(stdout);

        if (probe.expect === 'envelope') {
          expect(
            envelope,
            `${name}: stdout was not one parseable JSON document. ` +
              `A Class A command must leave a failure envelope on STDOUT (spec §6, §7) — ` +
              `stderr does not satisfy \`--json | jq .\`. Got: ${JSON.stringify(stdout.slice(0, 300))}`,
          ).not.toBeNull();
          expect(envelope?.schemaVersion, `${name}: envelope schemaVersion`).toBe(2);
          expect(envelope?.ok, `${name}: envelope ok`).toBe(false);
          expect(exitCode, `${name}: exit code must be nonzero when ok:false`).not.toBe(0);
          expect(
            escaped,
            `${name}: the error reached stdout as an envelope AND escaped to the top-level ` +
              `handler — the command must not re-throw what it already emitted`,
          ).toBeNull();

          if ((probe.shape ?? 'thrown') === 'thrown') {
            expect(envelope?.payload, `${name}: failure envelopes carry payload: null`).toBeNull();
            expect(
              Array.isArray(envelope?.errors) && (envelope?.errors?.length ?? 0) > 0,
              `${name}: a failure envelope must explain itself in errors[]`,
            ).toBe(true);
          } else {
            // 'reported': the diagnosis is the deliverable, so an empty
            // payload would mean the command answered nothing.
            expect(envelope?.payload, `${name}: the report is the payload`).not.toBeNull();
          }
          return;
        }

        if (probe.expect === 'no-envelope') {
          expect(
            stdout.trim(),
            `${name}: this row records the OUTSTANDING §6 gap. If this command now emits an ` +
              `envelope, that is good news — move its row to 'envelope' and update the header ` +
              `count. Do not delete the row.`,
          ).toBe('');
          expect(exitCode, `${name}: a failed read must still exit nonzero`).not.toBe(0);
          // The failure went SOMEWHERE. Without this, a command that swallowed
          // the error and printed nothing would read as 'no-envelope' too, and
          // that is a different, worse bug: silent success on a failed read.
          expect(
            escaped,
            `${name}: expected the failure to escape to the top-level handler ` +
              `(the §6 stderr fallback). Nothing on stdout AND nothing thrown means ` +
              `the failure was swallowed.`,
          ).not.toBeNull();
          return;
        }

        // 'no-client': a dead endpoint cannot fail it, so it should have run
        // to completion and still emitted a well-formed envelope.
        expect(envelope, `${name}: expected one parseable v2 envelope on stdout`).not.toBeNull();
        expect(envelope?.schemaVersion, `${name}: envelope schemaVersion`).toBe(2);
        expect(exitCode, `${name}: nothing should have failed`).toBe(0);
      },
      30_000,
    );
  }
});
