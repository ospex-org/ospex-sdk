/**
 * `ospex auth clear-foundry [--account] [--password-file]
 *                            [--expected-address] [--all] [--json]`
 *
 * Remove `auth use-foundry`-pinned signer defaults from
 * `~/.ospex/config.json`. With no flags (or `--all`), clears every
 * foundry-signer field (account / keystorePath / passwordFile /
 * foundryKeystoresDir / expectedAddress). Targeted flags clear only
 * the named fields.
 *
 * Use cases:
 *   - Switching to a different wallet: clear all, then re-run
 *     `auth use-foundry` with new credentials.
 *   - Removing only the address pin (after intentional key rotation):
 *     `auth clear-foundry --expected-address`. Subsequent commands
 *     unlock under the configured account again with no mismatch
 *     guardrail.
 *   - Removing the password file pointer (e.g., rotating the .pass
 *     file location): `auth clear-foundry --password-file`. The
 *     account stays configured; future commands will prompt or
 *     require an inline `--password-file`.
 *
 * Unaffected fields: `apiUrl`, `supabaseUrl`, `supabaseAnonKey`,
 * `rpcUrl`, `chainId`, and the legacy `keystorePath`. They're written
 * via `ospex init` and have their own lifecycle.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { formatOutput } from '../../lib/format.js';
import {
  loadConfigFile,
  saveConfigFile,
  type CliConfigFile,
} from '../../lib/config.js';

const optionsSchema = z.object({
  account: z.boolean().optional(),
  passwordFile: z.boolean().optional(),
  expectedAddress: z.boolean().optional(),
  foundryKeystoresDir: z.boolean().optional(),
  all: z.boolean().optional(),
  json: z.boolean().optional(),
});

const FOUNDRY_FIELDS = [
  'foundryAccount',
  'passwordFile',
  'foundryKeystoresDir',
  'expectedAddress',
] as const;

export const authClearFoundryCommand = new Command('clear-foundry')
  .description(
    'Remove `auth use-foundry`-pinned signer defaults from ~/.ospex/config.json. ' +
      'Without flags (or with --all), clears every foundry-signer field. ' +
      'Targeted flags clear only the named fields.',
  )
  .option('--account', 'clear only `foundryAccount` (and `keystorePath` if it was set via this command)')
  .option('--password-file', 'clear only `passwordFile`')
  .option('--expected-address', 'clear only `expectedAddress` (keeps account + password)')
  .option('--foundry-keystores-dir', 'clear only `foundryKeystoresDir`')
  .option('--all', 'clear every foundry-signer field (default when no targeted flags are set)')
  .option('--json', 'machine-readable output')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);

    const targeted =
      opts.account === true ||
      opts.passwordFile === true ||
      opts.expectedAddress === true ||
      opts.foundryKeystoresDir === true;
    const clearAll = opts.all === true || !targeted;

    const before = await loadConfigFile();
    const next: CliConfigFile = { ...before };

    const cleared: string[] = [];

    if (clearAll || opts.account === true) {
      if (next.foundryAccount !== undefined) {
        delete next.foundryAccount;
        cleared.push('foundryAccount');
      }
      // `keystorePath` from `auth use-foundry`'s `--keystore-path` mode
      // is the same conceptual slot as `foundryAccount`. Clear it
      // alongside on the catch-all `--account` flag — but only if
      // there's no separate signal that it came from `ospex init`.
      // (We can't perfectly distinguish; clearing on --all is safe;
      // clearing on --account alone leaves it for now since the user
      // didn't explicitly ask. `--all` will clear it via the next
      // block.)
    }
    if (clearAll) {
      if (next.keystorePath !== undefined) {
        delete next.keystorePath;
        cleared.push('keystorePath');
      }
    }
    if (clearAll || opts.passwordFile === true) {
      if (next.passwordFile !== undefined) {
        delete next.passwordFile;
        cleared.push('passwordFile');
      }
    }
    if (clearAll || opts.foundryKeystoresDir === true) {
      if (next.foundryKeystoresDir !== undefined) {
        delete next.foundryKeystoresDir;
        cleared.push('foundryKeystoresDir');
      }
    }
    if (clearAll || opts.expectedAddress === true) {
      if (next.expectedAddress !== undefined) {
        delete next.expectedAddress;
        cleared.push('expectedAddress');
      }
    }

    await saveConfigFile(next);

    if (opts.json === true) {
      formatOutput(
        {
          schemaVersion: 1,
          cleared,
          remaining: {
            foundryAccount: next.foundryAccount ?? null,
            keystorePath: next.keystorePath ?? null,
            passwordFile: next.passwordFile ?? null,
            foundryKeystoresDir: next.foundryKeystoresDir ?? null,
            expectedAddress: next.expectedAddress ?? null,
          },
        },
        { json: true },
      );
      return;
    }

    if (cleared.length === 0) {
      process.stdout.write('Nothing to clear — no matching fields were set in ~/.ospex/config.json.\n');
      return;
    }
    process.stdout.write(
      `Cleared from ~/.ospex/config.json: ${cleared.join(', ')}\n`,
    );
    const remainingFoundry = FOUNDRY_FIELDS.filter((k) => next[k] !== undefined);
    if (remainingFoundry.length > 0) {
      process.stdout.write(
        `Remaining foundry-signer fields: ${remainingFoundry.join(', ')}\n`,
      );
    }
  });
