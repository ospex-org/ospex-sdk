/**
 * `ospex contests scripts` — debug helper. Prints the script-approval
 * state pulled from core-api `/v1/contests/scripts/approved`. Hidden
 * from default --help; surfaces under --help when invoked.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { getClient } from '../../lib/client.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({ json: z.boolean().optional() });

export const contestScriptsCommand = new Command('scripts')
  .description(
    'Show the EIP-712 script approvals (debug). Useful for diagnosing ' +
      '"ScriptApprovalExpired" / hash-mismatch reverts during create/score.',
  )
  .option('--json', 'output as JSON')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });
    const data = await client.contests.scripts();

    if (opts.json === true) {
      formatOutput(data, { json: true });
      return;
    }
    formatOutput(
      {
        network: data.network,
        approvedSigner: data.approvedSigner,
        verifyHash: data.verify.scriptHash,
        verifyExpiry:
          data.verify.validUntil === 0 ? 'permanent' : new Date(data.verify.validUntil * 1000).toISOString(),
        marketUpdateHash: data.marketUpdate.scriptHash,
        scoreHash: data.score.scriptHash,
      },
      { json: false },
    );
  });
