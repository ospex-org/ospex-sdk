/**
 * `ospex commitments cancel <hash>` — off-chain cancel via DELETE
 * /v1/commitments/:hash. Authoritative cancel is on-chain
 * (MatchingModule.cancelCommitment / raiseMinNonce); this just removes
 * the row from the open book.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { formatOutput } from '../../lib/format.js';
import { getClient } from '../../lib/client.js';
import type { Hex } from '@ospex/sdk';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const commitmentsCancelCommand = new Command('cancel')
  .description('Off-chain cancel: marks the commitment cancelled in the API.')
  .argument('<hash>', '0x-prefixed 32-byte commitment hash')
  .option('--json', 'output as JSON')
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const hash = hashArg as Hex;
    // Cancel doesn't go on chain, but the EIP-712 cancel signature is
    // verified against MatchingModule's domain — so we still need the
    // chain id. Off-chain cancel doesn't need rpcUrl, however.
    const client = await getClient({ requiresSigner: true });
    const result = await client.commitments.cancel(hash);
    if (opts.json === true) {
      formatOutput(result, { json: true });
      return;
    }
    formatOutput({ ok: result.ok, hash }, { json: false });
  });
