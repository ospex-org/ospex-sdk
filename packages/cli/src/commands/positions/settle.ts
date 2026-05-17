/**
 * `ospex settle <speculationId>` — call SpeculationModule.settleSpeculation.
 *
 * Permissionless; useful for settling a position you hold (so you can
 * later claim) or for helping another holder finalize a speculation
 * they own a winning position on. Prints the resolved on-chain
 * winSide.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type {
  AgentEnvelope,
  ChainId,
  Hex,
  OspexClient,
} from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';

const optionsSchema = z.object({
  json: z.boolean().optional(),
});

export const positionsSettleCommand = addSignerOptions(
  new Command('settle')
    .description('Settle a speculation on-chain (permissionless). Required before any of its positions can be claimed.')
    .argument('<speculationId>', 'speculation id (uint256)')
    .option('--json', 'output as JSON'),
)
  .action(async (speculationIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const speculationId = BigInt(speculationIdArg);

    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });
    const result = await client.positions.settleSpeculation({ speculationId });

    if (opts.json === true) {
      const signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;
      writeAgentEnvelope(
        toSettleAgentEnvelope(result, {
          chainId: client.chainId(),
          signerAddress,
          speculationId,
        }),
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        blockNumber: result.blockNumber.toString(),
        winSide: result.winSide,
      },
      { json: false },
    );
  });

// ── v1 → v2 envelope transform ──────────────────────────────────────

export type SettleResult = Awaited<ReturnType<OspexClient['positions']['settleSpeculation']>>;

export interface SettlePayload {
  txHash: string;
  blockNumber: string;
  winSide: SettleResult['winSide'];
  speculationId: string;
}

export interface ToSettleEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex;
  speculationId: bigint;
}

export function toSettleAgentEnvelope(
  result: SettleResult,
  args: ToSettleEnvelopeArgs,
): AgentEnvelope<SettlePayload> {
  const status = result.receipt.status === 'success' ? 'confirmed' : 'reverted';
  return buildAgentEnvelope<SettlePayload>({
    ok: result.receipt.status === 'success',
    action: 'settle',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    effects: [
      {
        type: 'transaction',
        purpose: 'settle-speculation',
        ok: result.receipt.status === 'success',
        txHash: result.txHash as Hex,
        blockNumber: result.blockNumber.toString(),
        status,
      },
    ],
    payload: {
      txHash: result.txHash,
      blockNumber: result.blockNumber.toString(),
      winSide: result.winSide,
      speculationId: args.speculationId.toString(),
    },
  });
}
