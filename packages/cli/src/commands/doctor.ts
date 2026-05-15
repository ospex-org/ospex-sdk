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
import { formatOutput } from '../lib/format.js';
import { getClient } from '../lib/client.js';
import {
  buildDoctorReport,
  renderDoctorReport,
  type DoctorReportInputs,
} from '../lib/doctorRender.js';
import {
  probeContractsDeployed,
  probeRpc,
  type ContractCheckResult,
  type RpcProbeResult,
} from '../lib/doctorProbe.js';
import { sanitizeMessageForUrl } from '../lib/redact.js';
import {
  resolveWalletAddress,
  WalletAddressUnresolvedError,
} from '../lib/walletAddress.js';
import {
  loadConfigFile,
  resolveCliConfigDetailed,
} from '../lib/config.js';
import {
  checkPasswordFilePerms,
  resolveAuthSources,
} from '../lib/authResolution.js';
import { parseSignerIntent } from '../lib/signer-options.js';

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
    const strict = opts.strict === true;

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

    // PR 3: pull all three configs in one read so the envelope can
    // surface provenance + the doctor can probe upstream URLs.
    const cliConfig = await resolveCliConfigDetailed();
    const { apiUrl, rpcUrl, chainId: expectedChainId } = cliConfig;
    const rpcUrlValue = rpcUrl.value;
    const rpcUrlMissing = rpcUrlValue === null;

    // PR 4: run the same signer-resolution walker `ospex auth check`
    // uses, in non-unlocking mode. The walker is pure resolution —
    // no decrypt, no prompt — so the doctor's no-prompt guarantee
    // is preserved. Permission check fans out separately.
    const rawFile = await loadConfigFile();
    const signerIntent = parseSignerIntent(rawOpts);
    const authResolution = await resolveAuthSources(
      signerIntent,
      process.env,
      rawFile,
    );
    const passwordFilePermissions = await checkPasswordFilePerms(
      authResolution.password,
    );

    // PR 2: probe RPC + contracts in parallel before chain reads.
    // PR 3: also probe /v1/config/public (Realtime bootstrap) so the
    // structured `connectivity.api_public_config` line is populated.
    let rpcProbe: RpcProbeResult | null = null;
    let contractCheck: ContractCheckResult | null = null;
    if (!rpcUrlMissing && rpcUrlValue !== null) {
      [rpcProbe, contractCheck] = await Promise.all([
        probeRpc(rpcUrlValue),
        probeContractsDeployed(rpcUrlValue, expectedChainId.value),
      ]);
    }
    const apiPublicConfigResult = await probeApiPublicConfig(apiUrl.value);

    const inputs = await fetchDoctorInputs(owner, rpcUrlMissing, rpcProbe, rpcUrlValue);
    const reportInputs: DoctorReportInputs = {
      apiOk: inputs.apiOk,
      approvals: inputs.approvals,
      balances: inputs.balances,
      signerAddress: owner,
      expectedChainId,
      rpcProbe,
      contractCheck,
      rpcUrlMissing,
      apiUrl,
      rpcUrl,
      apiPublicConfigOk: apiPublicConfigResult.ok,
      authResolution,
      passwordFilePermissions,
      strict,
      ...(inputs.balancesError !== undefined ? { balancesError: inputs.balancesError } : {}),
      ...(inputs.approvalsError !== undefined ? { approvalsError: inputs.approvalsError } : {}),
      ...(signerAddressError !== undefined ? { signerAddressError } : {}),
      ...(apiPublicConfigResult.error !== undefined
        ? { apiPublicConfigError: apiPublicConfigResult.error }
        : {}),
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

export interface SafeReadResult<T> {
  value: T | null;
  error?: string;
}

/**
 * Fetch the chain + API snapshots with per-source soft-fail.
 *
 * Skip-cascade rules:
 *   - `owner === null` → no address to query, skip all chain reads.
 *   - `rpcUrlMissing` or `rpcProbe.ok === false` → skip all chain reads.
 *     The probe-driven `connectivity.rpc` check is the authoritative
 *     signal; downstream balance/allowance checks declare it as a
 *     `dependsOn`.
 *   - Otherwise, attempt the reads even on chain mismatch — the values
 *     are from the actual chain and the `network.chain_id_match` check
 *     surfaces the discrepancy by downgrading those reads to `warn`.
 *
 * The API health probe runs regardless of RPC state — it's
 * independent and a flaky API shouldn't bubble up alongside an RPC
 * issue.
 */
async function fetchDoctorInputs(
  owner: `0x${string}` | null,
  rpcUrlMissing: boolean,
  rpcProbe: RpcProbeResult | null,
  rpcUrl: string | null,
): Promise<FetchedInputs> {
  const canChainRead =
    owner !== null &&
    !rpcUrlMissing &&
    rpcProbe !== null &&
    rpcProbe.ok;

  if (!canChainRead) {
    const healthResult = await probeApiHealth(null);
    return {
      apiOk: healthResult.ok,
      balances: null,
      approvals: null,
    };
  }

  // canChainRead implies owner !== null; satisfy the type narrowing.
  const resolvedOwner = owner as `0x${string}`;

  // getClient may still throw synchronously on other config issues
  // (e.g. a malformed apiUrl). Defensive — degrade rather than crash.
  let client: OspexClient;
  try {
    client = await getClient({ requiresChain: true });
  } catch (err) {
    const apiResult = await probeApiHealth(null);
    // Sanitise the getClient error message too — it can mention the
    // rpcUrl when complaining about a malformed transport config.
    const msg = sanitizeMessageForUrl(errorMessage(err), rpcUrl);
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
    readApprovalsSafe(client, resolvedOwner, rpcUrl),
    readBalancesSafe(client, resolvedOwner, rpcUrl),
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

// Exported for regression tests — Hermes PR 54 review #2 specifically
// targeted this leak surface, so the test asserts the sanitisation
// happens here rather than higher up the stack.
export async function readBalancesSafe(
  client: OspexClient,
  owner: `0x${string}`,
  rpcUrl: string | null,
): Promise<SafeReadResult<BalancesSnapshot>> {
  try {
    const value = await client.balances.read({ owner });
    return { value };
  } catch (err) {
    // Hermes PR 54 review #2: the probe path already sanitises its
    // own errors, but viem's HttpRequestError thrown from the chain
    // read inside the OspexClient also includes the raw URL in
    // err.message. That message then lands in `checks[].details` via
    // `balancesError`. Sanitise here so balance/allowance read
    // errors don't leak credentials.
    return {
      value: null,
      error: sanitizeMessageForUrl(errorMessage(err), rpcUrl),
    };
  }
}

export async function readApprovalsSafe(
  client: OspexClient,
  owner: `0x${string}`,
  rpcUrl: string | null,
): Promise<SafeReadResult<ApprovalsSnapshot>> {
  try {
    const value = await client.approvals.read({ owner });
    return { value };
  } catch (err) {
    return {
      value: null,
      error: sanitizeMessageForUrl(errorMessage(err), rpcUrl),
    };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const API_PUBLIC_CONFIG_TIMEOUT_MS = 5_000;

/**
 * Probe `GET <apiUrl>/v1/config/public` to confirm the Realtime
 * bootstrap endpoint is reachable. Independent of `OspexClient` so it
 * works even when chain config is broken — this endpoint serves the
 * publishable Supabase URL + anon key, which Realtime consumers need
 * before they can subscribe.
 *
 * Returns `{ ok: true }` on 2xx and `{ ok: false, error }` on non-2xx
 * or transport failure. Never throws.
 */
async function probeApiPublicConfig(
  apiUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  const endpoint = apiUrl.replace(/\/+$/, '') + '/v1/config/public';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_PUBLIC_CONFIG_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    // Defense-in-depth: a custom apiUrl with auth could appear in
    // node:fetch error text. Apply the same sanitiser the chain
    // probes use. Hermes PR 54 blocker #1 extends to this path.
    return { ok: false, error: sanitizeMessageForUrl(errorMessage(err), endpoint) };
  } finally {
    clearTimeout(timer);
  }
}
