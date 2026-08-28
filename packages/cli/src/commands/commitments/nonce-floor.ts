/**
 * `ospex commitments nonce-floor --maker <addr> --contest-id <id>
 *                                --scorer <addr> --line <ticks>`
 *
 * Read-only utility — prints the current on-chain `s_minNonces[maker][specKey]`.
 * No signer required; only an `rpcUrl`. Use this before `cancel-all
 * --new-min-nonce <n>` to know the lower bound for `n`.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type { Hex } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  withReadFailureEnvelope,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { getClient } from '../../lib/client.js';

const optionsSchema = z.object({
  maker: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address'),
  contestId: z.string().regex(/^[0-9]+$/, 'must be a non-negative integer'),
  scorer: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address'),
  line: z.string().regex(/^-?[0-9]+$/, 'must be an int32'),
  json: z.boolean().optional(),
});

/** Named once so the success envelope and the §6 failure envelope cannot drift. */
const ACTION = 'commitments.nonce-floor';

export const commitmentsNonceFloorCommand = new Command('nonce-floor')
  .description('Read the on-chain nonce floor for a (maker, speculation) pair.')
  .requiredOption('--maker <addr>', 'maker address')
  .requiredOption('--contest-id <id>', 'contest id (uint256)')
  .requiredOption('--scorer <addr>', 'scorer module address')
  .requiredOption('--line <ticks>', 'line ticks (int32, 10× scale)')
  .option('--json', 'output as JSON')
  .action(async (rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresChain: true });
    // Hoisted out of the `--json` branch so the catch can name the chain.
    const chainId = client.chainId();
    // The subject is a parsed option, so it is known before the read and stays
    // known if the read fails. Lowercased on assignment, because `--maker`
    // accepts mixed-case hex and both envelopes must report one spelling.
    const wallet = opts.maker.toLowerCase() as Hex;

    await withReadFailureEnvelope(
      {
        action: ACTION,
        chainId,
        json: opts.json === true,
        subject: () => ({ wallet, walletRole: 'subject' }),
      },
      async () => {
        const floor = await client.commitments.getNonceFloor({
          maker: opts.maker as Hex,
          contestId: BigInt(opts.contestId),
          scorer: opts.scorer as Hex,
          lineTicks: Number(opts.line),
        });
        if (opts.json === true) {
          writeAgentEnvelope(
            buildAgentEnvelope({
              ok: true,
              action: ACTION,
              stage: 'read',
              network: networkForChainId(chainId),
              chainId,
              wallet,
              walletRole: 'subject',
              // Top-level `contest` / `speculation` shoulder fields not
              // populated: would require Contest→PreviewContest +
              // SpeculationDetail→SpeculationMode mappers that don't
              // exist yet. Payload carries the IDs; PR-6 enriches.
              payload: {
                maker: opts.maker.toLowerCase(),
                contestId: opts.contestId,
                scorer: opts.scorer.toLowerCase(),
                lineTicks: Number(opts.line),
                minNonce: floor.toString(),
              },
            }),
          );
          return;
        }
        formatOutput(
          {
            maker: opts.maker.toLowerCase(),
            contestId: opts.contestId,
            scorer: opts.scorer.toLowerCase(),
            lineTicks: Number(opts.line),
            minNonce: floor.toString(),
          },
          { json: false },
        );
      },
    );
  });
