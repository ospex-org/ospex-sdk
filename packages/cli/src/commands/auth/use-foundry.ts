/**
 * `ospex auth use-foundry --account <name> --password-file <path>
 *                          [--keystore-path <path>] [--foundry-keystores-dir <path>]
 *                          [--no-pin-address] [--json]`
 *
 * Pin a Foundry account + password file as the signer for every
 * future `ospex` command. Validates by decrypting once (so a bad
 * passphrase fails the setup, not the next bet) and — by default —
 * pins the resulting address in config so a surprise key rotation
 * (the user re-imports a different PK under the same account name)
 * is caught the next time `loadSigner` runs.
 *
 * Agent recipe after a one-time setup:
 *
 *     ospex auth use-foundry \
 *       --account ospex-stage-maker-a \
 *       --password-file ~/.ospex/secrets/maker-a.pass
 *
 *     # every subsequent write picks up the config:
 *     ospex commitments submit ... --yes
 *
 * `--no-pin-address` opts out of the address pin (useful if the user
 * intentionally rotates keys and wants the next account-name lookup
 * to silently follow). The default is to pin — agent safety wins.
 */

import path from 'node:path';
import { Command, Option } from '@commander-js/extra-typings';
import { z } from 'zod';
import { OspexValidationError } from '@ospex/sdk';
import {
  KeystoreSigner,
  resolveKeystoreSource,
  type FromFoundryAccountArgs,
  type FromKeystoreFileArgs,
} from '@ospex/sdk/signers/keystore';
import { formatOutput } from '../../lib/format.js';
import {
  expandTilde,
  loadConfigFile,
  saveConfigFile,
  type CliConfigFile,
} from '../../lib/config.js';

const optionsSchema = z
  .object({
    account: z.string().min(1).optional(),
    keystorePath: z.string().min(1).optional(),
    passwordFile: z.string().min(1),
    foundryKeystoresDir: z.string().min(1).optional(),
    pinAddress: z.boolean().optional(),
    json: z.boolean().optional(),
  })
  .refine(
    (data) =>
      (data.account !== undefined) !== (data.keystorePath !== undefined),
    {
      message:
        'auth use-foundry: pass exactly one of --account or --keystore-path.',
      path: ['account'],
    },
  );

export const authUseFoundryCommand = new Command('use-foundry')
  .description(
    'Pin a Foundry account + password file as the default signer for all future ospex commands. ' +
      'Validates by decrypting once and, by default, pins the resulting address in config as a safety check.',
  )
  .option('--account <name>', 'Foundry account name (under ~/.foundry/keystores)')
  .option(
    '--keystore-path <path>',
    'or absolute path to a v3 keystore JSON (mutually exclusive with --account)',
  )
  .requiredOption(
    '--password-file <path>',
    'path to a passphrase file (file should be 0600). Saved to config so future commands unlock non-interactively.',
  )
  .option(
    '--foundry-keystores-dir <path>',
    'override the Foundry keystores directory (default: ~/.foundry/keystores, $OSPEX_FOUNDRY_KEYSTORES_DIR, or $FOUNDRY_DIR/keystores)',
  )
  .option(
    '--no-pin-address',
    'do not pin the resolved address in config. Without this flag, future commands will reject a wallet that unlocks to a different address than the one validated here — guards against accidental key rotation under the same account name.',
  )
  .addOption(new Option('--json').hideHelp(false))
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);

    // Validate by unlocking once. The SDK helper throws clear errors
    // for missing files, wrong passphrase, etc. — failing here is
    // strictly better than failing on the next bet.
    //
    // For --account mode we first call `resolveKeystoreSource` so we
    // know the EFFECTIVE Foundry directory used during validation
    // (flag > OSPEX_FOUNDRY_KEYSTORES_DIR > FOUNDRY_DIR/keystores >
    // ~/.foundry/keystores). That same directory then gets persisted
    // to config — without this step, a re-run without
    // `--foundry-keystores-dir` could silently leave a stale
    // `config.foundryKeystoresDir` in place, breaking the next no-
    // flag write (Hermes PR 49 round 2 blocker).
    let signer: KeystoreSigner;
    let effectiveFoundryKeystoresDir: string | undefined;
    if (opts.account !== undefined) {
      const dirArg =
        opts.foundryKeystoresDir !== undefined
          ? expandTilde(opts.foundryKeystoresDir)
          : undefined;
      const source = await resolveKeystoreSource({
        account: opts.account,
        ...(dirArg !== undefined ? { foundryKeystoresDir: dirArg } : {}),
      });
      effectiveFoundryKeystoresDir = path.dirname(source.keystorePath);

      const args: FromFoundryAccountArgs = {
        account: opts.account,
        passwordFile: opts.passwordFile,
        foundryKeystoresDir: effectiveFoundryKeystoresDir,
      };
      signer = await KeystoreSigner.fromFoundryAccount(args);
    } else if (opts.keystorePath !== undefined) {
      const args: FromKeystoreFileArgs = {
        keystorePath: opts.keystorePath,
        passwordFile: opts.passwordFile,
      };
      signer = await KeystoreSigner.fromKeystoreFile(args);
    } else {
      // Schema refine() should make this unreachable, but appease the
      // type narrower without a non-null assertion.
      throw new OspexValidationError(
        'auth use-foundry: pass exactly one of --account or --keystore-path.',
      );
    }
    const address = (await signer.getAddress()).toLowerCase() as `0x${string}`;

    // Merge into config. The two foundry-signer source fields are
    // mutually exclusive — clear whichever the user did NOT pick so
    // a re-run with a different mode doesn't leave a stale field.
    //
    // Note: we write to `foundryKeystorePath`, NOT the legacy
    // `keystorePath`. The latter is set by `ospex init` for the
    // legacy default-keystore + interactive-prompt path 3 of
    // `loadSigner`; promoting it to explicit intent would change
    // behavior for every user with only an `init` setup. The
    // distinct `foundryKeystorePath` field is unambiguously the
    // sticky signer source, lifted by `mergeIntentFromConfig`.
    const config = await loadConfigFile();
    const next: CliConfigFile = { ...config };
    if (opts.account !== undefined) {
      next.foundryAccount = opts.account;
      delete next.foundryKeystorePath;
      // Persist the same dir validation used (computed above). This
      // overrides any stale config value so the next no-flag write
      // resolves against the same source we just validated.
      next.foundryKeystoresDir = effectiveFoundryKeystoresDir as string;
    } else {
      next.foundryKeystorePath = opts.keystorePath as string;
      delete next.foundryAccount;
      // --keystore-path mode: the Foundry directory is irrelevant for
      // signer resolution. Clear any stale value left over from a
      // previous --account-mode setup.
      delete next.foundryKeystoresDir;
    }
    next.passwordFile = opts.passwordFile;

    // `--no-pin-address` sets pinAddress to false; otherwise default
    // is to pin.
    const pinAddress = opts.pinAddress !== false;
    if (pinAddress) {
      next.expectedAddress = address;
    } else {
      delete next.expectedAddress;
    }

    await saveConfigFile(next);

    if (opts.json === true) {
      formatOutput(
        {
          schemaVersion: 1,
          foundryAccount: next.foundryAccount ?? null,
          foundryKeystorePath: next.foundryKeystorePath ?? null,
          passwordFile: next.passwordFile,
          foundryKeystoresDir: next.foundryKeystoresDir ?? null,
          expectedAddress: next.expectedAddress ?? null,
          validatedAddress: address,
          addressPinned: pinAddress,
        },
        { json: true },
      );
      return;
    }

    const sourceLabel =
      opts.account !== undefined
        ? `  account:               ${opts.account}\n`
        : `  foundryKeystorePath:   ${opts.keystorePath as string}\n`;
    const dirLabel =
      opts.foundryKeystoresDir !== undefined
        ? `  foundryKeystoresDir:   ${opts.foundryKeystoresDir}\n`
        : '';
    const addrLabel = pinAddress
      ? `  expectedAddress:       ${address}\n`
      : `  (--no-pin-address: address NOT pinned in config)\n`;

    process.stdout.write(
      `Validated: ${address}\n` +
        `Wrote ~/.ospex/config.json with the Foundry signer defaults:\n` +
        sourceLabel +
        `  passwordFile:          ${opts.passwordFile}\n` +
        dirLabel +
        addrLabel +
        `\nFuture write commands will pick these up automatically. ` +
        `Use \`ospex auth clear-foundry\` to remove.\n`,
    );
  });
