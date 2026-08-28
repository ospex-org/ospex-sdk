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
 * mirrored on the other. Review round 1 caught three
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
 *
 *   4. In the legacy-keystore branch (`config-keystorePath-legacy` /
 *      `default-legacy`), flag / env / config password sources are
 *      reported as 'none' — NOT as their configured value — because
 *      `loadSigner`'s path-3 (`readKeystore` + `promptHidden`) is
 *      interactive and ignores any lifted `intent.passwordFile`.
 *      Only `session-cache` produces a real non-interactive unlock
 *      on the legacy path; everything else collapses to 'would
 *      prompt'. Review round 2 caught the regression: a
 *      legacy `config.keystorePath` + `config.passwordFile` (wallet A)
 *      with an active session (wallet B) had `auth check` unlocking
 *      A while real `loadSigner({})` returned B.
 */

import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  OspexError,
  OspexSignerResolutionError,
  type AgentEnvelope,
  type AgentWarning,
  type ChainId,
  type Hex,
  type Signer,
  type WalletRole,
} from '@ospex/sdk';
import {
  KeystoreSigner,
  type FromFoundryAccountArgs,
  type FromKeystoreFileArgs,
} from '@ospex/sdk/signers/keystore';
import {
  buildAgentEnvelope,
  exitAfterStdoutFlush,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { readSession } from '../../lib/client.js';
import {
  loadConfigFile,
  resolveCliConfig,
  type CliConfigFile,
} from '../../lib/config.js';
import {
  addSignerOptions,
  parseSignerIntent,
  type SignerIntent,
} from '../../lib/signer-options.js';
import {
  checkPasswordFilePerms,
  resolveAuthSources,
  type ExpectedAddressProvenance,
  type FoundryKeystoresDirProvenance,
  type KeystoreProvenance,
  type PasswordProvenance,
  type ResolvedExpectedAddressField,
  type ResolvedFoundryKeystoresDirField,
  type ResolvedKeystoreField,
  type ResolvedPasswordField,
} from '../../lib/authResolution.js';

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
      // Resolve chainId for the v2 envelope shoulder block. Auth
      // check itself doesn't construct an OspexClient (it only walks
      // signer resolution), so pull from CLI config + fall back to
      // mainnet.
      const cfg = await resolveCliConfig();
      const chainId = (cfg.chainId ?? 137) as ChainId;
      writeAgentEnvelope(
        toAgentEnvelope(envelope, { chainId, signChallengeRequested }),
      );
    } else {
      renderHuman(envelope, process.stdout);
    }
    await exitAfterStdoutFlush(envelope.ok ? 0 : 1);
  });

// ── v1 → v2 envelope transform ──────────────────────────────────────

export interface ToAgentEnvelopeArgs {
  chainId: ChainId;
  /** Mirrors the action handler's `--sign-challenge` flag. Drives walletRole. */
  signChallengeRequested: boolean;
}

/**
 * Wrap the existing v1 `AuthCheckJsonEnvelope` in the v2 agent
 * envelope. Hoists `ok` / `warnings` / `errors` to the outer shoulder
 * block; leaves `strict` / `resolution` / `unlock` /
 * `passwordFilePermissions` / `challenge` inside `payload`.
 *
 * Exposed so tests can assert on the v2 transform without booting a
 * full CLI invocation.
 */
export function toAgentEnvelope(
  v1: AuthCheckJsonEnvelope,
  args: ToAgentEnvelopeArgs,
): AgentEnvelope<AuthCheckPayload> {
  const wallet: Hex | null = v1.unlock.address;
  // The wallet role distinguishes "we're inspecting this signer's
  // config" (default, --sign-challenge omitted) from "we're asking
  // this signer to sign something" (--sign-challenge set). Both
  // resolve to the same address, but the role tells agents whether
  // they should treat the address as a signing identity.
  const walletRole: WalletRole = wallet === null
    ? 'none'
    : args.signChallengeRequested
      ? 'signer'
      : 'subject';
  return buildAgentEnvelope<AuthCheckPayload>({
    ok: v1.ok,
    action: 'auth.check',
    stage: 'read',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet,
    walletRole,
    signer: wallet,
    warnings: liftAuthCheckWarnings(v1.warnings),
    errors: v1.errors,
    payload: {
      strict: v1.strict,
      resolution: v1.resolution,
      unlock: v1.unlock,
      passwordFilePermissions: v1.passwordFilePermissions,
      challenge: v1.challenge,
    },
  });
}

/**
 * v1 `AuthCheckJsonEnvelope.warnings` is a plain `string[]`. Lift
 * each known message into a structured `AgentWarning` with a stable
 * `code`. Today the only warning produced by `buildEnvelope` is the
 * loose-password-file-perms case; unknown messages fall back to a
 * generic `'auth-check-warning'` code so unfamiliar copy still
 * surfaces structurally (agents log + ignore).
 */
export function liftAuthCheckWarnings(messages: string[]): AgentWarning[] {
  return messages.map((message) => {
    if (
      /^Password file .* readable by group\/other/i.test(message) ||
      /password file .* mode 0/i.test(message)
    ) {
      return {
        code: 'password-file-permissions-loose',
        message,
        severity: 'warning',
      };
    }
    return {
      code: 'auth-check-warning',
      message,
      severity: 'warning',
    };
  });
}

/**
 * Shape of `payload` for `ospex auth check --json` under v2.
 * Mirrors `AuthCheckJsonEnvelope` minus the four fields hoisted to
 * the outer envelope (`schemaVersion`, `ok`, `warnings`, `errors`).
 */
export interface AuthCheckPayload {
  strict: boolean;
  resolution: AuthCheckJsonEnvelope['resolution'];
  unlock: AuthCheckJsonEnvelope['unlock'];
  passwordFilePermissions: AuthCheckJsonEnvelope['passwordFilePermissions'];
  challenge: AuthCheckJsonEnvelope['challenge'];
}

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

  const { keystore, password, expectedAddress, foundryKeystoresDir } =
    await resolveAuthSources(intent, env, config);

  // review blocker #2: a missing keystore file is not a fatal
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
  const passwordFilePermissions = await checkPasswordFilePerms(password);
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
  // reading the keystore file — review blocker #2).
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
