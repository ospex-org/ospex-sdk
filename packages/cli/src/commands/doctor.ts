/**
 * `ospex doctor` — comprehensive readiness check for the configured
 * wallet. Composes Core API health + USDC/LINK approvals + POL/USDC/
 * LINK balances into a single report and tells the user (or agent)
 * whether they can match commitments, submit new ones, or create
 * contests right now.
 *
 * Read-only. `--address <addr>` keeps the call fully read-only and
 * avoids a Foundry-keystore passphrase prompt; without it, the
 * wallet's address is resolved via the cheap path first
 * (in-keystore field, session cache) and only prompts on a Foundry
 * keystore that has neither.
 *
 * `--strict` promotes a group/other-readable password file (i.e.
 * `mode & 0o077 !== 0`) from a stderr warning to a hard fail (exit 1)
 * before any chain calls run — gives CI a one-shot gate against
 * sloppy secret-file perms. Same semantic as `ospex auth check
 * --strict`; for details on the resolved source itself, run that
 * dedicated diagnostic.
 *
 * Exit code is 0 iff `matchCommitments` is yes — gives agents a
 * convenient guard, e.g. `ospex doctor && ospex commitments match …`.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { checkPasswordFilePermissions } from '@ospex/sdk/signers/keystore';
import { formatOutput } from '../lib/format.js';
import { getClient } from '../lib/client.js';
import {
  buildDoctorReport,
  renderDoctorReport,
} from '../lib/doctorRender.js';
import { resolveWalletAddress } from '../lib/walletAddress.js';
import { expandTilde, loadConfigFile } from '../lib/config.js';

const optionsSchema = z.object({
  address: z.string().optional(),
  strict: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const doctorCommand = new Command('doctor')
  .description(
    'Comprehensive readiness check: chain, API, balances, allowances, and a "Ready to" matrix. ' +
      'Pass --address to check any wallet without unlocking your keystore. ' +
      'Pass --strict in CI to hard-fail on a group/other-readable password file. ' +
      'Exits 0 if the wallet can match commitments, 1 otherwise.',
  )
  .option('--address <addr>', 'wallet address to check (defaults to your keystore)')
  .option('--strict', 'hard-fail (exit 1) on warnings such as a group/other-readable password file')
  .option('--json', 'machine-readable output')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    await runPasswordFilePermissionGate(opts.strict === true);
    const owner = await resolveWalletAddress(opts.address);
    const client = await getClient({ requiresChain: true });

    // Fan out every read in parallel — none depend on each other and
    // the doctor's whole pitch is "give me everything in one trip."
    // The health check is independent of the chain reads, so let it
    // fail soft: a flaky API shouldn't bubble up as the doctor's exit.
    const [healthResult, approvals, balances] = await Promise.all([
      client.health.check().then(
        () => ({ ok: true }),
        () => ({ ok: false }),
      ),
      client.approvals.read({ owner }),
      client.balances.read({ owner }),
    ]);

    const report = buildDoctorReport({
      approvals,
      balances,
      apiOk: healthResult.ok,
    });

    if (opts.json === true) {
      formatOutput(report, { json: true });
    } else {
      renderDoctorReport(report, process.stdout);
    }

    process.exit(report.ready.matchCommitments.ok ? 0 : 1);
  });

/**
 * Check the permissions of the configured password file (env >
 * config). Loose perms → warning by default; with `--strict` they
 * become a hard exit before any chain work runs.
 *
 * Resolves in the same order `loadSigner` would consult: flag is not
 * a doctor surface, so env wins, then config. A missing file or
 * Windows / non-POSIX host short-circuits silently (no perm semantics
 * to enforce).
 *
 * Exported for tests via the dedicated `runPasswordFilePermissionGate`
 * import — keeps the test fixture from needing to round-trip through
 * the full doctor pipeline just to assert the strict-mode gate.
 */
export async function runPasswordFilePermissionGate(strict: boolean): Promise<void> {
  const envFile = process.env.OSPEX_PASSWORD_FILE;
  let passwordFile: string | undefined;
  if (envFile !== undefined && envFile.length > 0) {
    passwordFile = expandTilde(envFile);
  } else {
    const config = await loadConfigFile();
    if (config.passwordFile !== undefined && config.passwordFile.length > 0) {
      passwordFile = expandTilde(config.passwordFile);
    }
  }
  if (passwordFile === undefined) return;
  let perms;
  try {
    perms = await checkPasswordFilePermissions(passwordFile);
  } catch {
    // File doesn't exist or stat failed — not this gate's problem.
    return;
  }
  if (perms.platformSkipped) return;
  if (!perms.loose) return;

  const octal = perms.mode.toString(8).padStart(3, '0');
  const msg =
    `password file ${passwordFile} is readable by group/other (mode 0${octal}). ` +
    'Tighten with `chmod 600 <file>`.';
  if (strict) {
    process.stderr.write(`error (password_file_permissions_loose): ${msg}\n`);
    process.exit(1);
  }
  process.stderr.write(`warning: ${msg}\n`);
}
