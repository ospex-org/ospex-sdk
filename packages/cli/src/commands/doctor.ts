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
import type {
  ApprovalsSnapshot,
  BalancesSnapshot,
  OspexClient,
} from '@ospex/sdk';
import { checkPasswordFilePermissions } from '@ospex/sdk/signers/keystore';
import { formatOutput } from '../lib/format.js';
import { getClient } from '../lib/client.js';
import {
  buildDoctorReport,
  renderDoctorReport,
  type DoctorReportInputs,
} from '../lib/doctorRender.js';
import {
  resolveWalletAddress,
  WalletAddressUnresolvedError,
} from '../lib/walletAddress.js';
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

    // No-prompt guarantee: in --json mode or when stdin isn't a TTY,
    // the doctor must never block on hidden-input read. Address
    // resolution that would otherwise require an unlock throws
    // structured instead — the doctor catches it and emits
    // `signer.address_known: fail` rather than hanging.
    const noPrompt = opts.json === true || process.stdin.isTTY !== true;

    let owner: `0x${string}` | null = null;
    let signerAddressError: string | undefined;
    try {
      owner = await resolveWalletAddress(opts.address, { noPrompt });
    } catch (err) {
      if (err instanceof WalletAddressUnresolvedError) {
        owner = null;
        signerAddressError = err.message;
      } else {
        throw err;
      }
    }

    const inputs = await fetchDoctorInputs(owner);
    const reportInputs: DoctorReportInputs = {
      apiOk: inputs.apiOk,
      approvals: inputs.approvals,
      balances: inputs.balances,
      signerAddress: owner,
      ...(inputs.balancesError !== undefined ? { balancesError: inputs.balancesError } : {}),
      ...(inputs.approvalsError !== undefined ? { approvalsError: inputs.approvalsError } : {}),
      ...(signerAddressError !== undefined ? { signerAddressError } : {}),
    };

    const report = buildDoctorReport(reportInputs);

    if (opts.json === true) {
      formatOutput(report, { json: true });
    } else {
      renderDoctorReport(report, process.stdout);
    }

    process.exit(report.ready.matchCommitments.ok ? 0 : 1);
  });

interface FetchedInputs {
  apiOk: boolean;
  balances: BalancesSnapshot | null;
  balancesError?: string;
  approvals: ApprovalsSnapshot | null;
  approvalsError?: string;
}

interface SafeReadResult<T> {
  value: T | null;
  error?: string;
}

/**
 * Fetch the chain + API snapshots with per-source soft-fail. A flaky
 * RPC produces `balances: null` (and `balancesError: '<message>'`)
 * instead of throwing — the report builder turns that into structured
 * `skip` lines on the affected checks, leaving the rest of the
 * envelope intact.
 *
 * When `owner === null` (no-prompt resolution failed), the chain
 * reads are skipped — there's no address to query against.
 */
async function fetchDoctorInputs(owner: `0x${string}` | null): Promise<FetchedInputs> {
  if (owner === null) {
    const healthResult = await probeApiHealth(null);
    return {
      apiOk: healthResult.ok,
      balances: null,
      approvals: null,
    };
  }

  // requiresChain may throw synchronously when no rpcUrl is configured.
  // Catch it here so the doctor still emits an envelope rather than a
  // stack trace — PR 2 will add the structured `config.rpc_url` check
  // that surfaces this as `fail`; for PR 1 we just degrade gracefully.
  let client: OspexClient;
  try {
    client = await getClient({ requiresChain: true });
  } catch (err) {
    const apiResult = await probeApiHealth(null);
    const msg = errorMessage(err);
    return {
      apiOk: apiResult.ok,
      balances: null,
      approvals: null,
      balancesError: msg,
      approvalsError: msg,
    };
  }

  const [healthResult, approvalsResult, balancesResult] = await Promise.all([
    probeApiHealth(client),
    readApprovalsSafe(client, owner),
    readBalancesSafe(client, owner),
  ]);

  const result: FetchedInputs = {
    apiOk: healthResult.ok,
    approvals: approvalsResult.value,
    balances: balancesResult.value,
  };
  if (approvalsResult.value === null && approvalsResult.error !== undefined) {
    result.approvalsError = approvalsResult.error;
  }
  if (balancesResult.value === null && balancesResult.error !== undefined) {
    result.balancesError = balancesResult.error;
  }
  return result;
}

async function probeApiHealth(client: OspexClient | null): Promise<{ ok: boolean }> {
  if (client === null) {
    // No client (e.g. rpcUrl missing). Probe the API via a fresh
    // signer-less client so the health line still reports authoritatively.
    let healthClient: OspexClient;
    try {
      healthClient = await getClient();
    } catch {
      return { ok: false };
    }
    return healthClient.health.check().then(
      () => ({ ok: true }),
      () => ({ ok: false }),
    );
  }
  return client.health.check().then(
    () => ({ ok: true }),
    () => ({ ok: false }),
  );
}

async function readBalancesSafe(
  client: OspexClient,
  owner: `0x${string}`,
): Promise<SafeReadResult<BalancesSnapshot>> {
  try {
    const value = await client.balances.read({ owner });
    return { value };
  } catch (err) {
    return { value: null, error: errorMessage(err) };
  }
}

async function readApprovalsSafe(
  client: OspexClient,
  owner: `0x${string}`,
): Promise<SafeReadResult<ApprovalsSnapshot>> {
  try {
    const value = await client.approvals.read({ owner });
    return { value };
  } catch (err) {
    return { value: null, error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

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
