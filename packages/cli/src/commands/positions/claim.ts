/**
 * `ospex claim <speculationId> --type <upper|lower>` — claim a single
 * settled position. Uses the configured signer + RPC.
 *
 * If the API surfaces this position as `pendingSettle` (its parent
 * speculation hasn't been settled yet), `claim` does NOT auto-settle —
 * the user explicitly chose `claim`. We surface a clear error pointing
 * at `ospex settle` or `ospex claim-all` instead.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type {
  AgentEnvelope,
  AgentPayout,
  ChainId,
  Hex,
  OspexClient,
  PerspectiveAmount,
} from '@ospex/sdk';
import { OspexChainError, wei6ToDecimalUSDC } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { getClient } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';

const positionSchema = z.enum(['upper', 'lower', '0', '1']);
const optionsSchema = z.object({
  type: positionSchema,
  json: z.boolean().optional(),
});

function parsePosition(raw: string): 0 | 1 {
  const parsed = positionSchema.parse(raw);
  if (parsed === 'upper' || parsed === '0') return 0;
  return 1;
}

export const positionsClaimCommand = addSignerOptions(
  new Command('claim')
    .description('Claim a single settled position. Reverts if the parent speculation is not yet settled.')
    .argument('<speculationId>', 'speculation id (uint256)')
    .requiredOption('--type <upper|lower>', 'position side (upper = away/over, lower = home/under)')
    .option('--json', 'output as JSON'),
)
  .action(async (speculationIdArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const signerIntent = parseSignerIntent(rawOpts);
    const speculationId = BigInt(speculationIdArg);
    const positionType = parsePosition(opts.type);

    const client = await getClient({ requiresSigner: true, requiresChain: true, signerIntent });

    let result;
    try {
      result = await client.positions.claim({ speculationId, positionType });
    } catch (err) {
      if (err instanceof OspexChainError && /NotSettled/i.test(err.message)) {
        process.stderr.write(
          'This position requires settlement first. Run `ospex settle ' +
            `${speculationIdArg}` +
            '` (or `ospex claim-all` to handle both steps automatically).\n',
        );
        throw err;
      }
      throw err;
    }

    if (opts.json === true) {
      const signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;
      writeAgentEnvelope(
        toClaimAgentEnvelope(result, {
          chainId: client.chainId(),
          signerAddress,
          speculationId,
          positionType,
        }),
      );
      return;
    }
    formatOutput(
      {
        txHash: result.txHash,
        blockNumber: result.blockNumber.toString(),
        payoutUSDC: result.payoutUSDC,
        payoutWei6: result.payoutWei6.toString(),
      },
      { json: false },
    );
  });

// ── v1 → v2 envelope transform ──────────────────────────────────────

export type ClaimResult = Awaited<ReturnType<OspexClient['positions']['claim']>>;

export interface ClaimPayload {
  txHash: string;
  blockNumber: string;
  payoutWei6: string;
  payoutUSDC: number;
  speculationId: string;
  positionType: 0 | 1;
}

export interface ToClaimEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex;
  speculationId: bigint;
  positionType: 0 | 1;
}

export function toClaimAgentEnvelope(
  result: ClaimResult,
  args: ToClaimEnvelopeArgs,
): AgentEnvelope<ClaimPayload> {
  const status = result.receipt.status === 'success' ? 'confirmed' : 'reverted';
  // Build a PerspectiveAmount-shaped payout: profit and totalReturn
  // are the same on a settled claim (the payout IS the return — the
  // risk was locked in long ago at submit/match time).
  const payoutAmount: PerspectiveAmount = {
    wei6: result.payoutWei6.toString(),
    usdc: wei6ToDecimalUSDC(result.payoutWei6),
  };
  const payout: AgentPayout = {
    profit: payoutAmount,
    totalReturn: payoutAmount,
  };
  return buildAgentEnvelope<ClaimPayload>({
    ok: result.receipt.status === 'success',
    action: 'claim',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    payout,
    effects: [
      {
        type: 'transaction',
        purpose: 'claim-position',
        ok: result.receipt.status === 'success',
        txHash: result.txHash as Hex,
        blockNumber: result.blockNumber.toString(),
        status,
      },
    ],
    payload: {
      txHash: result.txHash,
      blockNumber: result.blockNumber.toString(),
      payoutWei6: result.payoutWei6.toString(),
      payoutUSDC: result.payoutUSDC,
      speculationId: args.speculationId.toString(),
      positionType: args.positionType,
    },
  });
}

