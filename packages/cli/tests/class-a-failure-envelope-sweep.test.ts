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
 *      per-command literal expectation — including the `action` the envelope
 *      names, which is the field an agent switches on and the one a
 *      copy-pasted catch block gets wrong. One `it()` per command, so a
 *      failure names the command rather than a count.
 *
 * ── The gap this sweep used to record ──────────────────────────────────────
 *
 * When this file was written, 19 of the reads emitted NOTHING on stdout when
 * they failed — a plain stderr line and exit 1 — and each carried a
 * `'no-envelope'` row recording the measurement rather than blessing it
 * (`verification-discipline.md` §3j). Those 19 were closed together, and with
 * them the `'no-envelope'` expectation was DELETED rather than emptied: while
 * the variant existed, a future command could opt back out of §6 by writing
 * one word in this table. It no longer type-checks. A Class A command that
 * genuinely cannot emit an envelope belongs in §4.4, which is a decision made
 * in the spec and reviewed there, not a row here.
 *
 * What remains is the property that made the gap findable: the table is exact
 * in BOTH directions, so a command that stops emitting reddens it, and one
 * whose shoulder block drifts reddens it too. The roster assertions force
 * whoever adds a command to come here and decide.
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
import type { AgentStage, WalletRole } from '@ospex/sdk';
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

/**
 * The §5.3 shoulder block a command's envelope must carry, written out per row.
 *
 * `action` alone was not enough. The shoulder fields are where a mechanically
 * applied change goes wrong: they differ per command — §5.3 gives `positions
 * status` a `'subject'`, `commitments list --maker` a `'filter'`, and `contests
 * list` a `'none'` — and nothing else in this file could see them, so nineteen
 * reads could have been wired with a uniform `wallet: null, walletRole: 'none'`
 * and passed every assertion here. The two intent flags are pinned for the same
 * reason in the other direction: a read that advertised `requiresSignature:
 * true` would tell an agent's recovery logic that a signature was attempted on
 * a command that cannot sign.
 *
 * Written as literals, never read back from the command under test — otherwise
 * this compares the command against itself.
 */
interface ShoulderPin {
  stage: AgentStage;
  /** Lowercase, as the envelope reports it. `null` when the command names no wallet. */
  wallet: string | null;
  walletRole: WalletRole;
  requiresSignature: boolean;
  requiresTransaction: boolean;
}

interface ProbeBase {
  /** Argv AFTER the command path and BEFORE `--json`. */
  args: readonly string[];
  /** True when the command needs a working signer to get past `getClient()`. */
  signer?: boolean;
  /** Why this row reads the way it does, where that is not obvious. */
  note?: string;
}

/**
 * One row per Class A command. The two expectations:
 *
 * `'envelope'`    — §6 honoured: nonzero exit, stdout is one parseable v2
 *                   envelope with `ok: false`, naming this command and
 *                   carrying the `shoulder` block written out beside it.
 * `'no-client'`   — the command builds no SDK client, so a dead endpoint
 *                   cannot push it into §6's post-client window at all. It
 *                   still has to leave one parseable v2 envelope on stdout,
 *                   which is what gets asserted.
 *
 * A row whose command puts an envelope on stdout also carries the `action`
 * that envelope must name, written out by hand here rather than read back
 * from the command under test. `action` is the §1 field an agent switches on,
 * and a catch block copy-pasted from a sibling command is exactly how it comes
 * out wrong: before this pin existed, a mutant that changed the new
 * `filled-risk` catch block's `action` to `commitments.match` survived both
 * this sweep and the per-command test file.
 *
 * The union is what makes it structural rather than a convention — a new
 * `'envelope'` row does not compile without an `action`. That end is held by
 * `yarn typecheck:tests` and NOT by `yarn test`, which strips types without
 * checking them; measured by deleting one row's `action` (TS2322, "Property
 * 'action' is missing") and restoring it.
 */
type Probe =
  | (ProbeBase & { expect: 'envelope'; action: string; shoulder: ShoulderPin; shape?: EnvelopeShape })
  | (ProbeBase & { expect: 'no-client'; action: string });

const OTHER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const A_HASH = `0x${'ab'.repeat(32)}`;

/**
 * The two probe addresses as the envelope reports them. Written out rather than
 * derived with `.toLowerCase()`, so a command that stopped normalising its
 * wallet would still be caught; the equality checks below are what stop these
 * from drifting into a different address entirely.
 */
const OTHER_LC = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const SIGNER_LC = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

/* ------------------------------------------------------------------ */
/* Shoulder shapes — one literal per §5.3 / §6 category                */
/* ------------------------------------------------------------------ */

/** §5.3 `∅/none/∅`: a read that names no wallet at all. */
const READ_NO_WALLET: ShoulderPin = {
  stage: 'read',
  wallet: null,
  walletRole: 'none',
  requiresSignature: false,
  requiresTransaction: false,
};

/** §3.2 "read scoped to a wallet": the address is the thing being read about. */
const readSubject = (wallet: string): ShoulderPin => ({ ...READ_NO_WALLET, wallet, walletRole: 'subject' });

/** §6 "pure on-chain writes": the signer was resolved, and both a signature and a tx were intended. */
const WRITE_SIGN_AND_TX: ShoulderPin = {
  stage: 'execute',
  wallet: SIGNER_LC,
  walletRole: 'signer',
  requiresSignature: true,
  requiresTransaction: true,
};

const PROBES: Record<string, Probe> = {
  /* §4.1 Reads */
  health: { args: [], expect: 'envelope', action: 'health', shoulder: READ_NO_WALLET },
  doctor: {
    args: [],
    expect: 'envelope',
    action: 'doctor',
    shape: 'reported',
    shoulder: readSubject(SIGNER_LC),
    note: 'converts a post-client failure into a finding in its report rather than a throw.',
  },
  'auth check': {
    args: [],
    expect: 'no-client',
    action: 'auth.check',
    note: 'diagnoses the LOCAL signer configuration; never constructs a client.',
  },
  'approvals show': {
    args: ['--address', OTHER_ADDRESS],
    expect: 'envelope',
    action: 'approvals.show',
    shoulder: readSubject(OTHER_LC),
  },
  'wallet address': {
    args: [],
    signer: true,
    expect: 'no-client',
    action: 'wallet.address',
    note: 'reads the keystore only; never constructs a client.',
  },
  'commitments list': {
    args: [],
    expect: 'envelope',
    action: 'commitments.list',
    shoulder: READ_NO_WALLET,
    note: 'no --maker here, so the wallet shoulder is genuinely absent; the `filter` shape it takes WITH --maker is pinned in command-failure-envelope.test.ts.',
  },
  'commitments show': {
    args: [A_HASH],
    expect: 'envelope',
    action: 'commitments.show',
    shoulder: READ_NO_WALLET,
    note: 'the success envelope names the maker as `subject`, but the maker arrives in the response that never came — §6 reserves null for exactly that.',
  },
  'commitments fillability': {
    args: [A_HASH],
    expect: 'envelope',
    action: 'commitments.fillability',
    shoulder: READ_NO_WALLET,
    note: 'no --taker and no configured signer, so this row fails INSIDE the window at resolvePreviewAddress with no subject resolved. Deliberately kept flag-free: the resolved-taker shape lives in command-failure-envelope.test.ts, so both are covered rather than one replacing the other.',
  },
  'commitments nonce-floor': {
    args: ['--maker', OTHER_ADDRESS, '--contest-id', '1', '--scorer', OTHER_ADDRESS, '--line', '0'],
    expect: 'envelope',
    action: 'commitments.nonce-floor',
    shoulder: readSubject(OTHER_LC),
  },
  'commitments filled-risk': {
    args: [A_HASH],
    expect: 'envelope',
    action: 'commitments.filled-risk',
    shoulder: READ_NO_WALLET,
  },
  'contests list': { args: [], expect: 'envelope', action: 'contests.list', shoulder: READ_NO_WALLET },
  'contests show': { args: ['1'], expect: 'envelope', action: 'contests.show', shoulder: READ_NO_WALLET },
  'contests wait-verified': {
    args: ['1'],
    expect: 'envelope',
    action: 'contests.wait-verified',
    shoulder: READ_NO_WALLET,
  },
  'contests wait-scored': {
    args: ['1'],
    expect: 'envelope',
    action: 'contests.wait-scored',
    shoulder: READ_NO_WALLET,
  },
  'contests score-status': {
    args: ['1'],
    expect: 'envelope',
    action: 'contests.score-status',
    shoulder: READ_NO_WALLET,
  },
  'games list': { args: [], expect: 'envelope', action: 'games.list', shoulder: READ_NO_WALLET },
  'leaderboard show': {
    args: [],
    expect: 'envelope',
    action: 'leaderboard.show',
    shoulder: READ_NO_WALLET,
  },
  'odds show': { args: ['1'], expect: 'envelope', action: 'odds.show', shoulder: READ_NO_WALLET },
  'positions list': {
    args: [OTHER_ADDRESS],
    expect: 'envelope',
    action: 'positions.list',
    shoulder: readSubject(OTHER_LC),
  },
  'positions status': {
    args: [OTHER_ADDRESS],
    expect: 'envelope',
    action: 'positions.status',
    shoulder: readSubject(OTHER_LC),
  },
  'positions history': {
    args: ['--address', OTHER_ADDRESS],
    expect: 'envelope',
    action: 'positions.history',
    shoulder: readSubject(OTHER_LC),
  },
  'speculations list': {
    args: [],
    expect: 'envelope',
    action: 'speculations.list',
    shoulder: READ_NO_WALLET,
  },
  'speculations show': {
    args: ['1'],
    expect: 'envelope',
    action: 'speculations.show',
    shoulder: READ_NO_WALLET,
  },

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
    action: 'commitments.submit',
    // §6: the EIP-712-then-POST core is off-chain, so a preview-path failure
    // with no approval attempted keeps `requiresTransaction: false`.
    shoulder: {
      stage: 'preview',
      wallet: OTHER_LC,
      walletRole: 'signer',
      requiresSignature: true,
      requiresTransaction: false,
    },
  },
  'commitments match': {
    args: [A_HASH, '--risk-usdc', '1', '--expected-address', OTHER_ADDRESS],
    expect: 'envelope',
    action: 'commitments.match',
    shoulder: { ...WRITE_SIGN_AND_TX, stage: 'preview', wallet: OTHER_LC },
  },
  'commitments approve': {
    args: ['25', '--yes'],
    signer: true,
    expect: 'envelope',
    action: 'commitments.approve',
    shoulder: WRITE_SIGN_AND_TX,
  },
  'commitments approve-raw': {
    args: ['25000000', '--yes'],
    signer: true,
    expect: 'envelope',
    action: 'commitments.approve-raw',
    shoulder: WRITE_SIGN_AND_TX,
  },
  'approvals setup': {
    args: ['--risk-usdc', '5', '--yes'],
    signer: true,
    expect: 'envelope',
    action: 'approvals.setup',
    shoulder: WRITE_SIGN_AND_TX,
  },

  /* §4.3 Fire-and-forget writes */
  'commitments cancel': {
    args: [A_HASH],
    signer: true,
    expect: 'envelope',
    action: 'commitments.cancel',
    // §6: EIP-712 cancel-auth always; a tx only with `--also-onchain`, not passed here.
    shoulder: { ...WRITE_SIGN_AND_TX, requiresTransaction: false },
  },
  'commitments cancel-onchain': {
    args: [A_HASH],
    signer: true,
    expect: 'envelope',
    action: 'commitments.cancel-onchain',
    shoulder: WRITE_SIGN_AND_TX,
  },
  'commitments cancel-all': {
    args: ['--contest-id', '1', '--scorer', OTHER_ADDRESS, '--line', '0', '--new-min-nonce', '5'],
    signer: true,
    expect: 'envelope',
    action: 'commitments.cancel-all',
    shoulder: WRITE_SIGN_AND_TX,
  },
  claim: {
    args: ['1', '--type', 'upper'],
    signer: true,
    expect: 'envelope',
    action: 'claim',
    shoulder: WRITE_SIGN_AND_TX,
  },
  'claim-all': {
    args: [],
    signer: true,
    expect: 'envelope',
    action: 'claim-all',
    shoulder: WRITE_SIGN_AND_TX,
  },
  settle: {
    args: ['1'],
    signer: true,
    expect: 'envelope',
    action: 'settle',
    shoulder: WRITE_SIGN_AND_TX,
  },
  'contests create': {
    args: ['--game-id', 'a-game-id', '--yes', '--no-wait'],
    signer: true,
    expect: 'envelope',
    action: 'contests.create',
    shoulder: WRITE_SIGN_AND_TX,
  },
  'contests score': {
    args: ['1'],
    signer: true,
    expect: 'envelope',
    action: 'contests.score',
    shoulder: WRITE_SIGN_AND_TX,
  },
  'contests update-markets': {
    args: ['1'],
    signer: true,
    expect: 'envelope',
    action: 'contests.update-markets',
    shoulder: WRITE_SIGN_AND_TX,
  },
};

/* ------------------------------------------------------------------ */
/* Fixtures — dead endpoints + a keystore that really unlocks           */
/* ------------------------------------------------------------------ */

/**
 * IPv4 discard port. Nothing here waits on a socket: port 9 is on the WHATWG
 * blocked-port list, so undici refuses the request before opening one (the
 * cause chain bottoms out at `bad port`) and a listener on the host cannot
 * change the answer. Same behaviour on Linux, which is where CI runs. A
 * connection refusal would do just as well; this is simply more deterministic.
 */
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
  stage?: string;
  wallet?: string | null;
  walletRole?: string;
  requiresSignature?: boolean;
  requiresTransaction?: boolean;
  payload?: unknown;
  errors?: unknown[];
}

/** The subset of a parsed envelope a {@link ShoulderPin} covers, for one whole-object compare. */
function shoulderOf(envelope: ParsedEnvelope): ShoulderPin {
  return {
    stage: envelope.stage as AgentStage,
    wallet: envelope.wallet ?? null,
    walletRole: envelope.walletRole as WalletRole,
    requiresSignature: envelope.requiresSignature as boolean,
    requiresTransaction: envelope.requiresTransaction as boolean,
  };
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
  // Negative control for the whole sweep: every case below asserts what a
  // command does when it FAILS, so all of them rest on the premise that the
  // probe endpoints really are unreachable. If they were not — a proxy
  // answering, a stale config file winning — the commands would succeed and
  // emit `ok: true`, which no assertion below accepts; but the premise is
  // worth failing on directly, and by name, rather than as 35 confusing
  // downstream mismatches. This case makes it explicit rather than assumed.
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
          // `action` is what an agent switches on, and it is the field a
          // copy-pasted catch block gets wrong while every other assertion here
          // stays green. The expected value is a literal in the probe table, so
          // this compares the command against the table rather than the command
          // against itself.
          expect(envelope?.action, `${name}: the envelope must name the failing command`)
            .toBe(probe.action);
          // Whole-object compare, not field-by-field: five separate assertions
          // would each have to be remembered, and the one nobody added is the
          // one that goes wrong. This also means a NEW shoulder field shows up
          // as a diff here rather than passing unnoticed.
          expect(
            shoulderOf(envelope as ParsedEnvelope),
            `${name}: the failure envelope's §5.3 shoulder block. A read must name the wallet ` +
              `it was reading ABOUT (or null, never a role without an address), and must not ` +
              `advertise write intent it never had.`,
          ).toStrictEqual(probe.shoulder);
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

        // 'no-client': a dead endpoint cannot fail it, so it should have run
        // to completion and still emitted a well-formed envelope.
        expect(envelope, `${name}: expected one parseable v2 envelope on stdout`).not.toBeNull();
        expect(envelope?.schemaVersion, `${name}: envelope schemaVersion`).toBe(2);
        expect(envelope?.action, `${name}: the envelope must name the command`).toBe(probe.action);
        expect(exitCode, `${name}: nothing should have failed`).toBe(0);
      },
      30_000,
    );
  }
});
