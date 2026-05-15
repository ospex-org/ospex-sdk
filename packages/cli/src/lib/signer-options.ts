/**
 * Shared option group + intent parser for the non-interactive Foundry
 * signer flow (spec §17, PR 2). Lets every CLI write command pick up
 * the same set of `--account` / `--keystore-path` / `--password-file`
 * / `--password-stdin` / `--expected-address` / `--foundry-keystores-dir`
 * flags by one helper call:
 *
 *     export const myCommand = addSignerOptions(
 *       new Command('mine')
 *         .description('...')
 *         .option('--my-flag', ...)
 *     )
 *       .action(async (rawOpts) => {
 *         const myOpts = mySchema.parse(rawOpts);
 *         const signerIntent = parseSignerIntent(rawOpts);
 *         ...
 *       });
 *
 * `loadSignerFromIntent` (in `client.ts`) consumes a `SignerIntent`
 * and either invokes the SDK's `KeystoreSigner.fromFoundryAccount` /
 * `fromKeystoreFile` non-interactive helpers, or falls back to the
 * legacy session-cache + interactive prompt when no non-interactive
 * source is configured.
 *
 * The CLI flag layer never reads a raw passphrase. `--password-file`
 * carries a file path (the passphrase stays on disk); `--password-stdin`
 * reads from a pipe; an interactive `promptHidden` prompt is the
 * fallback. There is intentionally no `--password <value>` — that
 * would leak the secret into shell history and process listings.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';

const SIGNER_OPTION_DESCRIPTIONS = {
  account: 'Foundry account name (resolves to <foundryKeystoresDir>/<name>). Mutually exclusive with --keystore-path.',
  keystorePath: 'Absolute path to a v3 keystore JSON. Mutually exclusive with --account.',
  passwordFile: 'Read the passphrase from a file (file should be 0600). Skips the interactive prompt.',
  passwordStdin: 'Read the passphrase from stdin (first line). Skips the interactive prompt. Mutually exclusive with --password-file.',
  expectedAddress:
    'Refuse to sign if the resolved keystore unlocks to a different address. Also used as the maker/taker for --json preview-only flows so previews work without a keystore unlock.',
  foundryKeystoresDir:
    'Override the Foundry keystores directory (default: ~/.foundry/keystores, or $OSPEX_FOUNDRY_KEYSTORES_DIR, or $FOUNDRY_DIR/keystores).',
} as const;

/**
 * Install the shared signer flag group on a Command. Use as a fluent
 * step inside the command builder chain:
 *
 *     export const cmd = addSignerOptions(new Command('foo'))
 *       .option('--my-other-flag', ...)
 *       .action(...);
 *
 * The type parameter `C extends Command<any, any, any>` lets this
 * accept Commands that already have args/options accumulated by
 * `@commander-js/extra-typings`. The body re-asserts `as unknown as C`
 * because the progressive `.option(...)` calls would otherwise narrow
 * the type and lose the caller's accumulated state — at runtime the
 * options are just appended to the same Command instance.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addSignerOptions<C extends Command<any, any, any>>(cmd: C): C {
  return cmd
    .option('--account <name>', SIGNER_OPTION_DESCRIPTIONS.account)
    .option('--keystore-path <path>', SIGNER_OPTION_DESCRIPTIONS.keystorePath)
    .option('--password-file <path>', SIGNER_OPTION_DESCRIPTIONS.passwordFile)
    .option('--password-stdin', SIGNER_OPTION_DESCRIPTIONS.passwordStdin)
    .option('--expected-address <addr>', SIGNER_OPTION_DESCRIPTIONS.expectedAddress)
    .option('--foundry-keystores-dir <path>', SIGNER_OPTION_DESCRIPTIONS.foundryKeystoresDir) as unknown as C;
}

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Zod schema for parsing the signer options off a command's raw
 * options object. Tolerant of extra keys — commander-js passes the
 * whole rawOpts to the action; the standard pattern is to parse with
 * a schema that only describes the keys this layer cares about.
 */
export const signerOptionsSchema = z
  .object({
    account: z.string().min(1).optional(),
    keystorePath: z.string().min(1).optional(),
    passwordFile: z.string().min(1).optional(),
    passwordStdin: z.boolean().optional(),
    expectedAddress: z
      .string()
      .regex(HEX_ADDRESS_RE, '--expected-address must be a 0x-prefixed 20-byte hex address')
      .optional(),
    foundryKeystoresDir: z.string().min(1).optional(),
  })
  .passthrough();

export type SignerOptionsInput = z.infer<typeof signerOptionsSchema>;

/**
 * Resolved per-invocation signer intent. Carries only what the loader
 * needs: which keystore to read, where to read the passphrase from,
 * and what address to verify. No I/O has happened yet at this layer —
 * the loader (`loadSignerFromIntent`) is responsible for that.
 */
export interface SignerIntent {
  account?: string;
  keystorePath?: string;
  passwordFile?: string;
  fromStdin?: boolean;
  /** Always lowercased for consistent comparison. */
  expectedAddress?: `0x${string}`;
  foundryKeystoresDir?: string;
}

/**
 * Convert parsed CLI options into a `SignerIntent`. The conversion is
 * purely mechanical: we keep field names compatible with the SDK
 * helpers (`KeystoreSigner.fromFoundryAccount` / `fromKeystoreFile`)
 * and lower-case the expected address so downstream compare doesn't
 * have to repeat that normalization.
 *
 * Pass either the raw `rawOpts` argument or the parsed signer-only
 * subset; the schema tolerates extra keys.
 */
export function parseSignerIntent(rawOpts: unknown): SignerIntent {
  const parsed = signerOptionsSchema.parse(rawOpts);
  const intent: SignerIntent = {};
  if (parsed.account !== undefined) intent.account = parsed.account;
  if (parsed.keystorePath !== undefined) intent.keystorePath = parsed.keystorePath;
  if (parsed.passwordFile !== undefined) intent.passwordFile = parsed.passwordFile;
  if (parsed.passwordStdin === true) intent.fromStdin = true;
  if (parsed.expectedAddress !== undefined) {
    intent.expectedAddress = parsed.expectedAddress.toLowerCase() as `0x${string}`;
  }
  if (parsed.foundryKeystoresDir !== undefined) {
    intent.foundryKeystoresDir = parsed.foundryKeystoresDir;
  }
  return intent;
}

/**
 * True when the intent contains a non-interactive passphrase source
 * (or the env var OSPEX_PASSWORD_FILE is set). Used by command-side
 * lazy-unlock branches that need to decide whether they can compute
 * a preview without prompting the user.
 *
 * Note: this does NOT check whether the path / file actually exists
 * — that's the loader's job. We only check whether a source was
 * supplied at all.
 */
export function hasNonInteractivePassphrase(
  intent: SignerIntent,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (intent.passwordFile !== undefined) return true;
  if (intent.fromStdin === true) return true;
  if (typeof env.OSPEX_PASSWORD_FILE === 'string' && env.OSPEX_PASSWORD_FILE.length > 0) {
    return true;
  }
  return false;
}

/**
 * True when the intent has any non-default keystore source — `--account`,
 * `--keystore-path`, or the env vars consulted by the SDK helpers. Used
 * by the loader to decide whether to take the new helper path or fall
 * back to the legacy session-cache flow.
 */
export function hasExplicitKeystoreSource(
  intent: SignerIntent,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (intent.account !== undefined) return true;
  if (intent.keystorePath !== undefined) return true;
  if (typeof env.OSPEX_KEYSTORE_PATH === 'string' && env.OSPEX_KEYSTORE_PATH.length > 0) {
    return true;
  }
  return false;
}
