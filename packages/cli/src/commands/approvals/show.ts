/**
 * `ospex approvals show [--address <addr>]` — read-only summary of the
 * wallet's USDC allowances against every Ospex spender.
 *
 * The command is the user-facing entry point to "do I have headroom
 * to bet / make a market / create a contest?" without inferring it
 * from a failed `commitments submit` or `contests create` call. It
 * also backs the upcoming `ospex doctor` and `ospex approvals setup`
 * commands.
 *
 * `--address` is the read-only escape hatch: pass any address to look
 * up its allowances without unlocking your own keystore. Without it,
 * the CLI resolves the configured wallet's address (cheap path first;
 * only prompts for the passphrase as a last resort).
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { Hex } from '@ospex/sdk';
import { getClient } from '../../lib/client.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  withReadFailureEnvelope,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import {
  renderApprovalsSnapshot,
  snapshotToJson,
} from '../../lib/approvalsRender.js';
import { resolveWalletAddress } from '../../lib/walletAddress.js';

const optionsSchema = z.object({
  address: z.string().optional(),
  json: z.boolean().optional(),
});

/** Named once so the success envelope and the §6 failure envelope cannot drift. */
const ACTION = 'approvals.show';

export const approvalsShowCommand = new Command('show')
  .description(
    'Show the configured wallet\'s USDC allowances against every Ospex spender. ' +
      'Pass --address to inspect any wallet without unlocking your keystore.',
  )
  .option('--address <addr>', 'wallet address to inspect (defaults to your keystore)')
  .option('--json', 'output as JSON')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const wantJson = opts.json === true;
    const owner = await resolveWalletAddress(opts.address);

    const client = await getClient({ requiresChain: true });
    // Hoisted out of the `--json` branch so the catch can name the chain.
    const chainId = client.chainId();
    // `owner` is resolved BEFORE getClient, so the subject stays known in the
    // catch. Lowercased once, here, so the failure and success envelopes cannot
    // report two spellings of one wallet.
    const wallet = owner.toLowerCase() as Hex;

    await withReadFailureEnvelope(
      {
        action: ACTION,
        chainId,
        json: wantJson,
        subject: () => ({ wallet, walletRole: 'subject' }),
      },
      async () => {
        const snapshot = await client.approvals.read({ owner });

        if (wantJson) {
          // Per spec §3.1, reads always emit `approvalRequirements: []` —
          // the live allowance snapshot lives in `payload`. The shoulder
          // field is "what would be needed to advance to the next stage";
          // a read has no next stage.
          writeAgentEnvelope(
            buildAgentEnvelope({
              ok: true,
              action: ACTION,
              stage: 'read',
              network: networkForChainId(chainId),
              chainId,
              wallet,
              walletRole: 'subject',
              payload: snapshotToJson(snapshot),
            }),
          );
          return;
        }

        renderApprovalsSnapshot(snapshot, process.stdout);
      },
    );
  });
