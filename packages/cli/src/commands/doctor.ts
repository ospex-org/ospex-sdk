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
 * Exit code is 0 iff `matchCommitments` is yes — gives agents a
 * convenient guard, e.g. `ospex doctor && ospex commitments match …`.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { formatOutput } from '../lib/format.js';
import { getClient } from '../lib/client.js';
import {
  buildDoctorReport,
  renderDoctorReport,
} from '../lib/doctorRender.js';
import { resolveWalletAddress } from '../lib/walletAddress.js';

const optionsSchema = z.object({
  address: z.string().optional(),
  json: z.boolean().optional(),
});

export const doctorCommand = new Command('doctor')
  .description(
    'Comprehensive readiness check: chain, API, balances, allowances, and a "Ready to" matrix. ' +
      'Pass --address to check any wallet without unlocking your keystore. ' +
      'Exits 0 if the wallet can match commitments, 1 otherwise.',
  )
  .option('--address <addr>', 'wallet address to check (defaults to your keystore)')
  .option('--json', 'machine-readable output')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
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
