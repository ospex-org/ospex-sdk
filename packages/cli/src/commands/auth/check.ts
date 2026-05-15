/**
 * `ospex auth check [signer-flags...] [--strict] [--sign-challenge] [--json]`
 *
 * Diagnostic command that walks the same signer-resolution ladder a
 * real write command would (flag > env > config > default) and reports
 * exactly which source resolved each field. Optionally unlocks the
 * keystore non-interactively, verifies the address pin, checks the
 * password file permissions, and signs a static EIP-712 challenge to
 * prove end-to-end signing works — all without sending a transaction
 * or mutating protocol state.
 *
 * Three modes the agent contract cares about:
 *
 *   - `ospex auth check` — default. Walks resolution; if a
 *     non-interactive password source is available, unlocks and
 *     verifies; if not, prints "what you'd need" and exits 0.
 *
 *   - `ospex auth check --strict` — promotes group/other-readable
 *     password files from warning to hard fail
 *     (`password_file_permissions_loose`). CI gate.
 *
 *   - `ospex auth check --sign-challenge` — requires a non-interactive
 *     password source. Signs a deterministic EIP-712 challenge and
 *     emits the signature so an agent can verify the signer is truly
 *     able to sign end-to-end (not just decrypt).
 *
 * Mutates nothing. Sends no tx. Never prompts (refuses the unlock path
 * if only an interactive prompt would fire). `--json` envelope is the
 * stable agent contract — see docs/AGENT_CONTRACT.md (added in PR 5).
 *
 * Design note: this command intentionally re-walks the precedence
 * ladder instead of going through `loadSigner` — it needs to report
 * provenance ("which source set this field"), which the runtime path
 * doesn't track. Keeping the walk here means the runtime path stays
 * lean and the diagnostic stays a single self-contained file.
 *
 * **The walk MUST stay in lockstep with `loadSigner`'s
 * `materializeIntent` + `mergeIntentFromConfig` +
 * `resolveSignerByPrecedence`.** Any change to either path must be
 * mirrored on the other. Hermes's PR 50 round-1 review caught three
 * divergences that the regression tests in
 * `tests/auth-check.test.ts` now lock in:
 *
 *   1. Session-cache password provenance applies ONLY when the
 *      keystore came from a legacy source (config-keystorePath-legacy /
 *      default-legacy). Explicit sources (flag, env, config-foundry*)
 *      bypass the session cache — same as `loadSigner`'s "path 1
 *      explicit skips path 2 session" precedence.
 *
 *   2. When session-cache is the unlock path, `keystore_not_found`
 *      is suppressed — the session.privateKey path never consults
 *      the keystore file, same as `loadSigner` (path 2 wins before
 *      path 3 reads the file).
 *
 *   3. Config-pinned `expectedAddress` lifts apply only when the
 *      resolved keystore source corresponds to the configured one.
 *      Env `OSPEX_KEYSTORE_PATH` is an explicit source, so the
 *      config pin does NOT apply unless the env path equals
 *      `config.foundryKeystorePath` — mirrors
 *      `mergeIntentFromConfig`'s `explicitMatchesConfigKeystorePath`
 *      branch.
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  OspexError,
  OspexSignerResolutionError,
  type Signer,
} from '@ospex/sdk';
import {
  KeystoreSigner,
  checkPasswordFilePermissions,
  type FromFoundryAccountArgs,
  type FromKeystoreFileArgs,
} from '@ospex/sdk/signers/keystore';
import { formatOutput } from '../../lib/format.js';
import { readSession } from '../../lib/client.js';
import {
  expandTilde,
  getKeystorePath,
  loadConfigFile,
  type CliConfigFile,
} from '../../lib/config.js';
import {
  addSignerOptions,
  parseSignerIntent,
  type SignerIntent,
} from '../../lib/signer-options.js';

// ── Provenance enum (stable agent contract) ─────────────────────────

/**
 * Every place the resolver could pick a keystore from. Distinguishes
 * the new sticky-signer fields (`foundryAccount`, `foundryKeystorePath`)
 * from the legacy `ospex init` field (`keystorePath`) and from the
 * hard-coded default (`~/.ospex/keystore.json`) so agents can tell at
 * a glance whether the user is on the Foundry-native path or the
 * legacy session-cache path.
 */
type KeystoreProvenance =
  | 'flag-account'
  | 'flag-keystore-path'
  | 'env-OSPEX_KEYSTORE_PATH'
  | 'config-foundryAccount'
  | 'config-foundryKeystorePath'
  | 'config-keystorePath-legacy'
  | 'default-legacy';

type PasswordProvenance =
  | 'flag-password-file'
  | 'flag-password-stdin'
  | 'env-OSPEX_PASSWORD_FILE'
  | 'config-passwordFile'
  | 'session-cache'
  | 'none';

type ExpectedAddressProvenance = 'flag' | 'config' | 'none';

type FoundryKeystoresDirProvenance =
  | 'flag'
  | 'env-OSPEX_FOUNDRY_KEYSTORES_DIR'
  | 'env-FOUNDRY_DIR'
  | 'config'
  | 'default';

// ── Static EIP-712 challenge (deterministic) ────────────────────────

/**
 * Deterministic EIP-712 payload used by `--sign-challenge`. Domain
 * intentionally omits `chainId` and `verifyingContract` — this is a
 * self-test, not a protocol message, and binding to a chain would
 * make Amoy vs mainnet checks need different signatures for the same
 * key (noise without value). Same key → same signature, forever.
 *
 * Exported for tests + the agent-contract doc.
 */
export const AUTH_CHALLENGE = {
  domain: {
    name: 'Ospex Auth Check',
    version: '1',
  },
  types: {
    AuthChallenge: [
      { name: 'product', type: 'string' },
      { name: 'purpose', type: 'string' },
    ],
  },
  primaryType: 'AuthChallenge',
  message: {
    product: 'ospex',
    purpose: 'auth-check signing self-test',
  },
} as const;

// ── JSON envelope (stable agent contract) ───────────────────────────

export interface AuthCheckJsonEnvelope {
  schemaVersion: 1;
  ok: boolean;
  strict: boolean;
  resolution: {
    keystore: {
      provenance: KeystoreProvenance;
      path: string;
      account: string | null;
      exists: boolean;
    };
    password: {
      provenance: PasswordProvenance;
      path: string | null;
      exists: boolean | null;
    };
    expectedAddress: {
      provenance: ExpectedAddressProvenance;
      value: `0x${string}` | null;
    };
    foundryKeystoresDir: {
      provenance: FoundryKeystoresDirProvenance;
      value: string;
    };
  };
  unlock: {
    attempted: boolean;
    succeeded: boolean | null;
    address: `0x${string}` | null;
    skippedReason: 'no_non_interactive_password' | null;
  };
  passwordFilePermissions: {
    checked: boolean;
    platformSkipped: boolean;
    mode: number | null;
    octal: string | null;
    loose: boolean | null;
  };
  challenge: {
    requested: boolean;
    signed: boolean;
    signature: `0x${string}` | null;
  };
  warnings: string[];
  errors: Array<{ code: string; message: string }>;
}

// ── Option schema ───────────────────────────────────────────────────

const optionsSchema = z
  .object({
    strict: z.boolean().optional(),
    signChallenge: z.boolean().optional(),
    json: z.boolean().optional(),
  })
  .passthrough();

// ── Command ─────────────────────────────────────────────────────────

export const authCheckCommand = addSignerOptions(
  new Command('check')
    .description(
      'Diagnose the configured signer source without signing a transaction. ' +
        'Walks the same precedence ladder (flag > env > config > default) a real ' +
        'write command would, and reports the resolved source for each field. ' +
        'When a non-interactive password source is available, unlocks the keystore ' +
        'and reports the address — useful for verifying an agent setup before going live. ' +
        'Use --strict in CI to hard-fail on loose password-file permissions, and ' +
        '--sign-challenge to prove end-to-end signing works.',
    ),
)
  .option('--strict', 'fail on warnings (e.g. group/other-readable password file)')
  .option('--sign-challenge', 'sign a deterministic EIP-712 challenge to prove signing works end-to-end')
  .addOption(new Option('--json').hideHelp(false))
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const intent = parseSignerIntent(rawOpts);
    const strict = opts.strict === true;
    const signChallengeRequested = opts.signChallenge === true;
    const json = opts.json === true;

    const config = await loadConfigFile();
    const env = process.env;

    const envelope = await buildEnvelope({
      intent,
      env,
      config,
      strict,
      signChallengeRequested,
    });

    if (json) {
      formatOutput(envelope, { json: true });
    } else {
      renderHuman(envelope, process.stdout);
    }
    process.exit(envelope.ok ? 0 : 1);
  });

// ── Envelope assembly ───────────────────────────────────────────────

export interface BuildEnvelopeArgs {
  intent: SignerIntent;
  env: NodeJS.ProcessEnv;
  config: CliConfigFile;
  strict: boolean;
  signChallengeRequested: boolean;
}

/**
 * Pure-ish envelope builder. Exposed for tests so the CLI shell stays
 * a thin process.exit wrapper around the same code path. The few impure
 * bits (`fs.access`, `loadConfigFile`, SDK helpers) are all driven by
 * the passed-in `intent`/`env`/`config` so tests can inject a tmpdir
 * config + a record-restore env without monkey-patching globals.
 */
export async function buildEnvelope(args: BuildEnvelopeArgs): Promise<AuthCheckJsonEnvelope> {
  const { intent, env, config, strict, signChallengeRequested } = args;
  const warnings: string[] = [];
  const errors: Array<{ code: string; message: string }> = [];

  const keystore = await resolveKeystoreField(intent, env, config);
  const foundryKeystoresDir = resolveFoundryDirField(intent, env, config);
  const password = await resolvePasswordField(intent, env, config, keystore);
  const expectedAddress = resolveExpectedAddressField(intent, config, keystore);

  // Hermes PR 50 blocker #2: a missing keystore file is not a fatal
  // error when the session cache is the unlock path. Real `loadSigner`
  // reaches the session-cache branch (path 2) before any attempt to
  // read the legacy default keystore (path 3), so `keystore.exists`
  // becomes purely informational in that case.
  if (!keystore.exists && password.provenance !== 'session-cache') {
    errors.push({
      code: 'keystore_not_found',
      message: `Keystore not found at ${keystore.path}.`,
    });
  }
  if (password.path !== null && password.exists === false) {
    errors.push({
      code: 'password_file_not_found',
      message: `Password file not found at ${password.path}.`,
    });
  }

  // Permission check — runs whenever we have a password FILE (not
  // stdin / session). Strict mode promotes a loose result to an error.
  const passwordFilePermissions = await checkPermissions(password);
  if (
    passwordFilePermissions.checked &&
    passwordFilePermissions.loose === true
  ) {
    const msg =
      `Password file ${password.path as string} is readable by group/other ` +
      `(mode 0${passwordFilePermissions.octal as string}). Tighten with \`chmod 600 <file>\`.`;
    if (strict) {
      errors.push({ code: 'password_file_permissions_loose', message: msg });
    } else {
      warnings.push(msg);
    }
  }

  // Unlock attempt — fires when non-interactive credentials are
  // available AND there are no upstream fatal errors yet. The session-
  // cache branch is the one case where `keystore.exists` is irrelevant
  // (path 2 of `loadSigner` uses session.privateKey without ever
  // reading the keystore file — Hermes PR 50 blocker #2).
  const canAttemptUnlock =
    errors.length === 0 &&
    (password.provenance === 'session-cache' ||
      (keystore.exists &&
        (password.provenance === 'flag-password-file' ||
          password.provenance === 'flag-password-stdin' ||
          password.provenance === 'env-OSPEX_PASSWORD_FILE' ||
          password.provenance === 'config-passwordFile')));

  const unlock: AuthCheckJsonEnvelope['unlock'] = {
    attempted: false,
    succeeded: null,
    address: null,
    skippedReason: null,
  };
  let signer: Signer | undefined;

  if (canAttemptUnlock) {
    unlock.attempted = true;
    try {
      signer = await performUnlock({
        keystore,
        password,
        expectedAddress,
        strict,
        foundryKeystoresDir,
      });
      unlock.succeeded = true;
      unlock.address = (await signer.getAddress()).toLowerCase() as `0x${string}`;
    } catch (err) {
      unlock.succeeded = false;
      if (err instanceof OspexSignerResolutionError) {
        errors.push({ code: err.reason, message: err.message });
      } else if (err instanceof OspexError) {
        errors.push({ code: err.code, message: err.message });
      } else if (err instanceof Error) {
        errors.push({ code: 'unlock_failed', message: err.message });
      } else {
        errors.push({ code: 'unlock_failed', message: String(err) });
      }
    }
  } else if (errors.length === 0 && keystore.exists) {
    unlock.skippedReason = 'no_non_interactive_password';
  }

  const challenge: AuthCheckJsonEnvelope['challenge'] = {
    requested: signChallengeRequested,
    signed: false,
    signature: null,
  };
  if (signChallengeRequested) {
    if (signer === undefined) {
      errors.push({
        code: 'non_interactive_password_required',
        message:
          '--sign-challenge requires a non-interactive password source. ' +
          'Pass --password-file / --password-stdin / OSPEX_PASSWORD_FILE, or run `ospex auth use-foundry`.',
      });
    } else {
      try {
        const signature = await signer.signTypedData({
          domain: { ...AUTH_CHALLENGE.domain },
          types: { AuthChallenge: [...AUTH_CHALLENGE.types.AuthChallenge] },
          primaryType: AUTH_CHALLENGE.primaryType,
          message: { ...AUTH_CHALLENGE.message },
        });
        challenge.signed = true;
        challenge.signature = signature;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ code: 'challenge_sign_failed', message });
      }
    }
  }

  const ok = errors.length === 0;

  return {
    schemaVersion: 1,
    ok,
    strict,
    resolution: {
      keystore,
      password,
      expectedAddress,
      foundryKeystoresDir,
    },
    unlock,
    passwordFilePermissions,
    challenge,
    warnings,
    errors,
  };
}

// ── Resolution walkers ──────────────────────────────────────────────

/**
 * Walk the keystore resolution ladder (mirrors `loadSigner`'s
 * combined `materializeIntent` + `mergeIntentFromConfig` + path-3
 * fallback) and track which source contributed the resolved path.
 */
async function resolveKeystoreField(
  intent: SignerIntent,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
): Promise<AuthCheckJsonEnvelope['resolution']['keystore']> {
  let provenance: KeystoreProvenance;
  let resolvedPath: string;
  let account: string | null = null;

  if (intent.account !== undefined) {
    provenance = 'flag-account';
    account = intent.account;
    resolvedPath = path.join(
      resolveFoundryKeystoresDir(intent, env, config),
      intent.account,
    );
  } else if (intent.keystorePath !== undefined) {
    provenance = 'flag-keystore-path';
    resolvedPath = expandTilde(intent.keystorePath);
  } else if (
    typeof env.OSPEX_KEYSTORE_PATH === 'string' &&
    env.OSPEX_KEYSTORE_PATH.length > 0
  ) {
    provenance = 'env-OSPEX_KEYSTORE_PATH';
    resolvedPath = expandTilde(env.OSPEX_KEYSTORE_PATH);
  } else if (
    config.foundryAccount !== undefined &&
    config.foundryAccount.length > 0
  ) {
    provenance = 'config-foundryAccount';
    account = config.foundryAccount;
    resolvedPath = path.join(
      resolveFoundryKeystoresDir(intent, env, config),
      config.foundryAccount,
    );
  } else if (
    config.foundryKeystorePath !== undefined &&
    config.foundryKeystorePath.length > 0
  ) {
    provenance = 'config-foundryKeystorePath';
    resolvedPath = expandTilde(config.foundryKeystorePath);
  } else if (
    config.keystorePath !== undefined &&
    config.keystorePath.length > 0
  ) {
    provenance = 'config-keystorePath-legacy';
    resolvedPath = expandTilde(config.keystorePath);
  } else {
    provenance = 'default-legacy';
    // Same fallback `loadSigner` ends up at via `readKeystore` → `getKeystorePath`.
    resolvedPath = await getKeystorePath();
  }

  return {
    provenance,
    path: resolvedPath,
    account,
    exists: await fileExists(resolvedPath),
  };
}

async function resolvePasswordField(
  intent: SignerIntent,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
  keystore: AuthCheckJsonEnvelope['resolution']['keystore'],
): Promise<AuthCheckJsonEnvelope['resolution']['password']> {
  if (intent.passwordFile !== undefined) {
    const p = expandTilde(intent.passwordFile);
    return {
      provenance: 'flag-password-file',
      path: p,
      exists: await fileExists(p),
    };
  }
  if (intent.fromStdin === true) {
    return { provenance: 'flag-password-stdin', path: null, exists: null };
  }
  if (
    typeof env.OSPEX_PASSWORD_FILE === 'string' &&
    env.OSPEX_PASSWORD_FILE.length > 0
  ) {
    const p = expandTilde(env.OSPEX_PASSWORD_FILE);
    return {
      provenance: 'env-OSPEX_PASSWORD_FILE',
      path: p,
      exists: await fileExists(p),
    };
  }
  if (config.passwordFile !== undefined && config.passwordFile.length > 0) {
    const p = expandTilde(config.passwordFile);
    return {
      provenance: 'config-passwordFile',
      path: p,
      exists: await fileExists(p),
    };
  }
  // Session cache applies ONLY when the keystore came from a legacy
  // source. Hermes PR 50 blocker #1: real `loadSigner` skips the
  // session cache once an explicit signer source (flag / env /
  // config-foundry*) is resolved — otherwise a `--sign-challenge`
  // could happily sign with the cached session wallet even though
  // the agent asked for a specific Foundry account.
  const sessionApplies =
    keystore.provenance === 'config-keystorePath-legacy' ||
    keystore.provenance === 'default-legacy';
  if (sessionApplies) {
    const session = await readSession();
    if (session) {
      return { provenance: 'session-cache', path: null, exists: null };
    }
  }
  return { provenance: 'none', path: null, exists: null };
}

/**
 * Mirror the conditional `expectedAddress` lift from
 * `client.ts:mergeIntentFromConfig`. The config-pinned address is a
 * guardrail for "the configured signer always resolves to this
 * address"; it applies only when the resolved keystore source
 * corresponds to the configured one.
 *
 * Hermes PR 50 blocker #3: the previous implementation used an
 * intent-only check (`intent.account === undefined && intent.keystorePath === undefined`)
 * which was true when env `OSPEX_KEYSTORE_PATH` was set without a
 * flag — making the config pin falsely apply to an env-selected
 * keystore. Real `loadSigner`'s `materializeIntent` lifts env into
 * the intent first, so `noExplicitSource` is false in that case.
 * We mirror that by deriving "explicitness" from `keystore.provenance`
 * (which already factors in env), not from raw intent fields.
 */
function resolveExpectedAddressField(
  intent: SignerIntent,
  config: CliConfigFile,
  keystore: AuthCheckJsonEnvelope['resolution']['keystore'],
): AuthCheckJsonEnvelope['resolution']['expectedAddress'] {
  if (intent.expectedAddress !== undefined) {
    return { provenance: 'flag', value: intent.expectedAddress };
  }
  if (config.expectedAddress === undefined || config.expectedAddress.length === 0) {
    return { provenance: 'none', value: null };
  }

  // "Explicit" mirrors what `materializeIntent` + the path-1 check
  // in `resolveSignerByPrecedence` consider an explicit signer source:
  // flag account, flag keystore-path, OR env `OSPEX_KEYSTORE_PATH`
  // (lifted into intent.keystorePath at runtime).
  const cameFromExplicitSource =
    keystore.provenance === 'flag-account' ||
    keystore.provenance === 'flag-keystore-path' ||
    keystore.provenance === 'env-OSPEX_KEYSTORE_PATH';

  if (!cameFromExplicitSource) {
    // Keystore came from config-foundryAccount / config-foundryKeystorePath
    // (caller inherited the configured source) OR a legacy fallback
    // (config-keystorePath-legacy / default-legacy — `mergeIntentFromConfig`
    // also lifts the pin when `noExplicitSource` is true). Pin applies.
    return {
      provenance: 'config',
      value: config.expectedAddress.toLowerCase() as `0x${string}`,
    };
  }

  // Explicit source — pin applies only on an exact match with the
  // configured account or keystore-path.
  const flagAccountMatchesConfig =
    keystore.provenance === 'flag-account' &&
    config.foundryAccount !== undefined &&
    config.foundryAccount.length > 0 &&
    intent.account === config.foundryAccount;

  // `keystore.path` is already expanded for both flag-keystore-path
  // and env-OSPEX_KEYSTORE_PATH; expand config.foundryKeystorePath
  // for the comparison.
  const explicitPathMatchesConfigPath =
    (keystore.provenance === 'flag-keystore-path' ||
      keystore.provenance === 'env-OSPEX_KEYSTORE_PATH') &&
    config.foundryKeystorePath !== undefined &&
    config.foundryKeystorePath.length > 0 &&
    keystore.path === expandTilde(config.foundryKeystorePath);

  if (flagAccountMatchesConfig || explicitPathMatchesConfigPath) {
    return {
      provenance: 'config',
      value: config.expectedAddress.toLowerCase() as `0x${string}`,
    };
  }
  return { provenance: 'none', value: null };
}

function resolveFoundryDirField(
  intent: SignerIntent,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
): AuthCheckJsonEnvelope['resolution']['foundryKeystoresDir'] {
  if (intent.foundryKeystoresDir !== undefined) {
    return { provenance: 'flag', value: expandTilde(intent.foundryKeystoresDir) };
  }
  if (
    typeof env.OSPEX_FOUNDRY_KEYSTORES_DIR === 'string' &&
    env.OSPEX_FOUNDRY_KEYSTORES_DIR.length > 0
  ) {
    return {
      provenance: 'env-OSPEX_FOUNDRY_KEYSTORES_DIR',
      value: expandTilde(env.OSPEX_FOUNDRY_KEYSTORES_DIR),
    };
  }
  if (typeof env.FOUNDRY_DIR === 'string' && env.FOUNDRY_DIR.length > 0) {
    return {
      provenance: 'env-FOUNDRY_DIR',
      value: path.join(expandTilde(env.FOUNDRY_DIR), 'keystores'),
    };
  }
  if (
    config.foundryKeystoresDir !== undefined &&
    config.foundryKeystoresDir.length > 0
  ) {
    return {
      provenance: 'config',
      value: expandTilde(config.foundryKeystoresDir),
    };
  }
  return {
    provenance: 'default',
    value: path.join(os.homedir(), '.foundry', 'keystores'),
  };
}

/** Same selection logic as resolveFoundryDirField but returns only the path. */
function resolveFoundryKeystoresDir(
  intent: SignerIntent,
  env: NodeJS.ProcessEnv,
  config: CliConfigFile,
): string {
  return resolveFoundryDirField(intent, env, config).value;
}

// ── Permission check ────────────────────────────────────────────────

async function checkPermissions(
  password: AuthCheckJsonEnvelope['resolution']['password'],
): Promise<AuthCheckJsonEnvelope['passwordFilePermissions']> {
  // Only file-backed password sources have meaningful POSIX perms.
  // stdin / session / none → nothing to check.
  if (password.path === null || password.exists === false) {
    return {
      checked: false,
      platformSkipped: false,
      mode: null,
      octal: null,
      loose: null,
    };
  }
  const result = await checkPasswordFilePermissions(password.path);
  if (result.platformSkipped) {
    return {
      checked: false,
      platformSkipped: true,
      mode: null,
      octal: null,
      loose: null,
    };
  }
  return {
    checked: true,
    platformSkipped: false,
    mode: result.mode,
    octal: result.mode.toString(8).padStart(3, '0'),
    loose: result.loose,
  };
}

// ── Unlock ──────────────────────────────────────────────────────────

interface PerformUnlockArgs {
  keystore: AuthCheckJsonEnvelope['resolution']['keystore'];
  password: AuthCheckJsonEnvelope['resolution']['password'];
  expectedAddress: AuthCheckJsonEnvelope['resolution']['expectedAddress'];
  strict: boolean;
  foundryKeystoresDir: AuthCheckJsonEnvelope['resolution']['foundryKeystoresDir'];
}

/**
 * Run the actual decrypt via the SDK helpers — same code path a real
 * write command would take, so a green `auth check` is a meaningful
 * pre-flight for live writes.
 *
 * Session-cache path uses `KeystoreSigner.fromPrivateKey` because the
 * decrypted key is already in `~/.ospex/session`; re-decrypting the
 * keystore would prompt for the passphrase and defeat the point of
 * the cache (which the user explicitly opted into via `wallet unlock`).
 */
async function performUnlock(args: PerformUnlockArgs): Promise<Signer> {
  const { keystore, password, expectedAddress, strict } = args;

  if (password.provenance === 'session-cache') {
    const session = await readSession();
    if (session === undefined) {
      // Session expired between resolve and unlock; surface a typed
      // error so the caller's envelope flags it cleanly.
      throw new OspexSignerResolutionError(
        'Session cache disappeared during auth check (likely expired between resolve and unlock). ' +
          'Re-run `ospex wallet unlock` or supply a non-interactive password source.',
        { reason: 'non_interactive_password_required' },
      );
    }
    const signer = KeystoreSigner.fromPrivateKey(session.privateKey as `0x${string}`);
    if (expectedAddress.value !== null) {
      const actual = (await signer.getAddress()).toLowerCase();
      if (actual !== expectedAddress.value) {
        throw new OspexSignerResolutionError(
          `Cached session unlocks to ${actual} but expected ${expectedAddress.value}.`,
          {
            reason: 'address_mismatch',
            expectedAddress: expectedAddress.value,
            actualAddress: actual,
          },
        );
      }
    }
    return signer;
  }

  const passphraseArg: { passwordFile?: string; fromStdin?: boolean } = {};
  if (password.provenance === 'flag-password-stdin') {
    passphraseArg.fromStdin = true;
  } else if (password.path !== null) {
    passphraseArg.passwordFile = password.path;
  }

  const commonArgs: { expectedAddress?: `0x${string}`; strict?: boolean } = {
    strict,
  };
  if (expectedAddress.value !== null) {
    commonArgs.expectedAddress = expectedAddress.value;
  }

  if (keystore.account !== null) {
    const a: FromFoundryAccountArgs = {
      account: keystore.account,
      foundryKeystoresDir: args.foundryKeystoresDir.value,
      ...passphraseArg,
      ...commonArgs,
    };
    return KeystoreSigner.fromFoundryAccount(a);
  }

  const a: FromKeystoreFileArgs = {
    keystorePath: keystore.path,
    ...passphraseArg,
    ...commonArgs,
  };
  return KeystoreSigner.fromKeystoreFile(a);
}

// ── Human renderer ──────────────────────────────────────────────────

function renderHuman(
  env: AuthCheckJsonEnvelope,
  out: NodeJS.WritableStream,
): void {
  const INDENT = '  ';
  out.write('\nResolved sources\n');
  out.write(`${INDENT}keystore               ${formatProvenance(env.resolution.keystore.provenance)}\n`);
  out.write(`${INDENT}  path                 ${env.resolution.keystore.path}${env.resolution.keystore.exists ? '' : '   (missing)'}\n`);
  if (env.resolution.keystore.account !== null) {
    out.write(`${INDENT}  account              ${env.resolution.keystore.account}\n`);
  }
  out.write(`${INDENT}password               ${formatProvenance(env.resolution.password.provenance)}\n`);
  if (env.resolution.password.path !== null) {
    const missing = env.resolution.password.exists === false ? '   (missing)' : '';
    out.write(`${INDENT}  path                 ${env.resolution.password.path}${missing}\n`);
  }
  out.write(`${INDENT}expectedAddress        ${formatProvenance(env.resolution.expectedAddress.provenance)}\n`);
  if (env.resolution.expectedAddress.value !== null) {
    out.write(`${INDENT}  value                ${env.resolution.expectedAddress.value}\n`);
  }
  out.write(`${INDENT}foundryKeystoresDir    ${formatProvenance(env.resolution.foundryKeystoresDir.provenance)}\n`);
  out.write(`${INDENT}  value                ${env.resolution.foundryKeystoresDir.value}\n`);

  out.write('\nPermissions\n');
  if (env.passwordFilePermissions.platformSkipped) {
    out.write(`${INDENT}password file        (skipped — Windows / non-POSIX)\n`);
  } else if (!env.passwordFilePermissions.checked) {
    out.write(`${INDENT}password file        (no file source — nothing to check)\n`);
  } else {
    const loose = env.passwordFilePermissions.loose === true;
    const tag = loose
      ? env.strict
        ? 'LOOSE (rejected by --strict)'
        : 'LOOSE (warning)'
      : 'ok';
    out.write(`${INDENT}password file        mode 0${env.passwordFilePermissions.octal as string}    ${tag}\n`);
  }

  out.write('\nUnlock\n');
  if (env.unlock.attempted) {
    if (env.unlock.succeeded === true) {
      out.write(`${INDENT}attempted            yes\n`);
      out.write(`${INDENT}address              ${env.unlock.address as string}\n`);
    } else {
      out.write(`${INDENT}attempted            yes\n`);
      out.write(`${INDENT}succeeded            no\n`);
    }
  } else if (env.unlock.skippedReason !== null) {
    out.write(`${INDENT}attempted            no (${env.unlock.skippedReason})\n`);
  } else {
    out.write(`${INDENT}attempted            no\n`);
  }

  if (env.challenge.requested) {
    out.write('\nChallenge\n');
    if (env.challenge.signed) {
      out.write(`${INDENT}signed               yes\n`);
      out.write(`${INDENT}signature            ${env.challenge.signature as string}\n`);
    } else {
      out.write(`${INDENT}signed               no\n`);
    }
  }

  if (env.warnings.length > 0) {
    out.write('\nWarnings\n');
    for (const w of env.warnings) out.write(`${INDENT}- ${w}\n`);
  }
  if (env.errors.length > 0) {
    out.write('\nErrors\n');
    for (const e of env.errors) {
      out.write(`${INDENT}- (${e.code}) ${e.message}\n`);
    }
  }

  out.write(`\nStatus: ${env.ok ? 'ok' : 'NOT ok'}\n\n`);
}

function formatProvenance(p: string): string {
  // Friendly translation for human output; the JSON envelope keeps
  // the stable enum codes so agents have a discrete switch surface.
  switch (p) {
    case 'flag-account': return '--account';
    case 'flag-keystore-path': return '--keystore-path';
    case 'env-OSPEX_KEYSTORE_PATH': return 'env OSPEX_KEYSTORE_PATH';
    case 'config-foundryAccount': return 'config foundryAccount';
    case 'config-foundryKeystorePath': return 'config foundryKeystorePath';
    case 'config-keystorePath-legacy': return 'config keystorePath (legacy, from `ospex init`)';
    case 'default-legacy': return 'default (legacy ~/.ospex/keystore.json)';
    case 'flag-password-file': return '--password-file';
    case 'flag-password-stdin': return '--password-stdin';
    case 'env-OSPEX_PASSWORD_FILE': return 'env OSPEX_PASSWORD_FILE';
    case 'config-passwordFile': return 'config passwordFile';
    case 'session-cache': return 'session cache (legacy `wallet unlock`)';
    case 'none': return 'none (would prompt interactively)';
    case 'flag': return 'flag';
    case 'env-OSPEX_FOUNDRY_KEYSTORES_DIR': return 'env OSPEX_FOUNDRY_KEYSTORES_DIR';
    case 'env-FOUNDRY_DIR': return 'env FOUNDRY_DIR';
    case 'config': return 'config';
    case 'default': return 'default (~/.foundry/keystores)';
    default: return p;
  }
}

// ── small helpers ───────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
