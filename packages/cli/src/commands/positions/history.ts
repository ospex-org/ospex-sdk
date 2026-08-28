/**
 * `ospex positions history [--address <addr>] [--include-claimed]`
 *
 * Read-only: paginated history view of all positions for a wallet.
 * `--include-claimed` (default: false) controls whether already-claimed
 * positions are shown alongside open / unclaimed ones.
 *
 * The underlying endpoint (/v1/positions/:address) returns every row;
 * filtering happens client-side here. That's fine for the CLI's
 * use case — the 200-row cap inside the SDK is more than enough for
 * a human review session.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { Hex } from '@ospex/sdk';
import { getClient } from '../../lib/client.js';
import {
  NO_READ_SUBJECT,
  buildAgentEnvelope,
  networkForChainId,
  withReadFailureEnvelope,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'address must be a 0x-prefixed 20-byte hex string').optional(),
  includeClaimed: z.boolean().optional(),
  json: z.boolean().optional(),
});

/** Named once so the success envelope and the §6 failure envelope cannot drift. */
const ACTION = 'positions.history';

export const positionsHistoryCommand = new Command('history')
  .description('Show position history for an address (defaults to the configured signer).')
  .option('--address <addr>', 'wallet to read (defaults to the configured signer\'s address)')
  .option('--include-claimed', 'include already-claimed positions in the output')
  .option('--json', 'output as JSON')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const includeClaimed = opts.includeClaimed === true;

    // No chain required — pure read.
    const requiresSigner = opts.address === undefined;
    const client = await getClient({ requiresSigner });
    // Hoisted out of the `--json` branch so the catch can name the chain.
    const chainId = client.chainId();

    // Declared out here so the failure envelope can report the subject when
    // one was resolved. `--address` is known from argv; without it the address
    // comes off the signer INSIDE the guarded window and a failure at that step
    // legitimately has no subject to name (§6: `null` is reserved for exactly
    // that). Lowercased on assignment, because the option's regex accepts
    // mixed-case hex and the success envelope lowercases — the same argv must
    // not produce two spellings of one wallet.
    let subject: Hex | null =
      opts.address === undefined ? null : (opts.address.toLowerCase() as Hex);

    await withReadFailureEnvelope(
      {
        action: ACTION,
        chainId,
        json: opts.json === true,
        // A thunk, not an object: `subject` is still null at call time on the
        // signer-derived path and only becomes known part-way through the body.
        subject: () =>
          subject === null ? NO_READ_SUBJECT : { wallet: subject, walletRole: 'subject' },
      },
      async () => {
        let address = opts.address;
        if (address === undefined) {
          const signer = client.signer();
          address = (await signer.getAddress()).toLowerCase();
          subject = address as Hex;
        }

        const all = await client.positions.byAddress(address);
        const filtered = includeClaimed ? all : all.filter((p) => !p.claimed);

        if (opts.json === true) {
          const wallet = address.toLowerCase() as Hex;
          writeAgentEnvelope(
            buildAgentEnvelope({
              ok: true,
              action: ACTION,
              stage: 'read',
              network: networkForChainId(chainId),
              chainId,
              wallet,
              walletRole: 'subject',
              payload: filtered,
            }),
          );
          return;
        }
        formatOutput(filtered, { json: false });
      },
    );
  });
