/**
 * `ospex claim <speculationId> --type <upper|lower>` — idempotently claim
 * a single settled position. Uses the configured signer + RPC.
 *
 * Routes through `client.positions.ensurePositionClaimed` ("make this
 * claimed"), NOT the strict `claim` primitive. If the position was already
 * claimed — a prior run, a manual claim, a concurrent caller, or core-API
 * `claimable`-projection lag — this reports success instead of a scary
 * `AlreadyClaimed` revert. Three outcomes:
 *   - `claimed`        — this call sent the claim tx (event-sourced payout).
 *   - `alreadyClaimed` — a pre-flight read found it claimed; no tx, no payout.
 *   - `recovered`      — a benign already-claimed won a race mid-flight (may
 *                        carry `revertedTxHash` if this wallet's claim
 *                        actually broadcast and reverted).
 *
 * Only `AlreadyClaimed` is benign. If the parent speculation isn't settled
 * yet, the claim reverts `NotSettled` and `claim` does NOT auto-settle — we
 * surface a clear error pointing at `ospex settle` / `ospex claim-all`.
 * `NoPayout` and other reverts stay loud too.
 *
 * The strict `client.positions.claim` primitive (always sends a tx; throws
 * `AlreadyClaimed`) stays available for programmatic callers that need the
 * receipt + event-sourced payout of a claim they specifically sent.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import type {
  AgentEffect,
  AgentEnvelope,
  AgentPayout,
  AgentWarning,
  ChainId,
  Hex,
  OspexClient,
  PerspectiveAmount,
} from '@ospex/sdk';
import { isNotSettledRevert, wei6ToDecimalUSDC } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  emitJsonFailureAndExit,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { type SideContext } from '../../lib/sideContext.js';
import { resolvePositionSideContext } from '../../lib/resolveSideContext.js';
import {
  VERIFY_POSITION_STATUS,
  deriveRemediationNextCommands,
} from '../../lib/nextCommandTemplates.js';
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
    .description('Claim a single settled position (idempotent). Reports success if it was already claimed; reverts if the parent speculation is not yet settled.')
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
    const chainId = client.chainId();
    const wantJson = opts.json === true;
    let signerAddress: Hex | null = null;

    try {
      // Resolve the signer up-front so a failure envelope from the
      // catch below carries wallet/signer populated.
      signerAddress = ((await client.signer().getAddress()) as string).toLowerCase() as Hex;

      const result = await client.positions.ensurePositionClaimed({ speculationId, positionType });
      // Additive Team Identity enrichment — NON-BLOCKING: the claim already
      // resolved above; resolvePositionSideContext never throws, so a
      // metadata-fetch failure degrades to context:null + a warning rather
      // than reporting a successful claim as failed. (context:null because the
      // held side can't be derived from positionType without the market.)
      const { context: positionSideContext, warning: enrichmentWarning } =
        await resolvePositionSideContext(client, speculationId, positionType);

      if (wantJson) {
        writeAgentEnvelope(
          toClaimAgentEnvelope(result, {
            chainId,
            signerAddress,
            speculationId,
            positionType,
            sideContext: positionSideContext,
            enrichmentWarning,
          }),
        );
        return;
      }

      // Human output, per outcome. `formatOutput` renders a single object
      // as aligned key/value lines (and skips empty fields).
      if (result.outcome === 'claimed') {
        formatOutput(
          {
            outcome: result.outcome,
            ...(positionSideContext ? { side: positionSideContext.display } : {}),
            txHash: result.txHash,
            blockNumber: result.blockNumber?.toString(),
            payoutUSDC: result.payoutUSDC,
            payoutWei6: result.payoutWei6?.toString(),
          },
          { json: false },
        );
      } else if (result.outcome === 'alreadyClaimed') {
        formatOutput(
          {
            outcome: result.outcome,
            ...(positionSideContext ? { side: positionSideContext.display } : {}),
            note: 'Already claimed on-chain — no transaction sent.',
          },
          { json: false },
        );
      } else {
        formatOutput(
          {
            outcome: result.outcome,
            ...(positionSideContext ? { side: positionSideContext.display } : {}),
            note: 'Already claimed by a concurrent/prior transaction — recovered, no claim needed.',
            ...(result.revertedTxHash !== undefined ? { revertedTx: result.revertedTxHash } : {}),
          },
          { json: false },
        );
      }
    } catch (err) {
      // Only AlreadyClaimed is benign (handled above as a success outcome).
      // A NotSettled revert means the parent speculation hasn't been settled
      // yet — `claim` does NOT auto-settle, so point the user at the settle
      // path. Typed selector decoding, not message-string matching.
      if (isNotSettledRevert(err)) {
        process.stderr.write(
          'This position requires settlement first. Run `ospex settle ' +
            `${speculationIdArg}` +
            '` (or `ospex claim-all` to handle both steps automatically).\n',
        );
      }
      if (wantJson) {
        await emitJsonFailureAndExit({
          action: 'claim',
          stage: 'execute',
          chainId,
          wallet: signerAddress,
          walletRole: 'signer',
          signer: signerAddress,
          requiresSignature: true,
          requiresTransaction: true,
          nextCommands: deriveRemediationNextCommands(err, chainId),
          error: err,
        });
      }
      throw err;
    }
  });

// ── v1 → v2 envelope transform ──────────────────────────────────────

export type EnsureClaimedResult = Awaited<
  ReturnType<OspexClient['positions']['ensurePositionClaimed']>
>;

export interface ClaimPayload {
  outcome: EnsureClaimedResult['outcome'];
  /** The confirmed claim tx — present only when `outcome === 'claimed'`. */
  txHash: string | null;
  blockNumber: string | null;
  /** A claim tx this wallet broadcast that then reverted (inclusion-time
   * race loss) — present only on `recovered` when one was broadcast. */
  revertedTxHash: string | null;
  /** Event-sourced payout — present only when `outcome === 'claimed'`.
   * `alreadyClaimed` / `recovered` carry no payout (the contract zeroes
   * economic fields post-claim; the CLI never fabricates one). */
  payoutWei6: string | null;
  payoutUSDC: number | null;
  speculationId: string;
  positionType: 0 | 1;
  /** Additive Team Identity context for the side this position represents
   * (derived from positionType + market) — next to the bare positionType,
   * never instead of it (agents route on `positionType`; `display` is
   * human-facing). Null when enrichment metadata was unavailable (the side
   * can't be derived without the market). See AGENT_ENVELOPE_SPEC §2.7. */
  positionSideContext: SideContext | null;
}

export interface ToClaimEnvelopeArgs {
  chainId: ChainId;
  signerAddress: Hex;
  speculationId: bigint;
  positionType: 0 | 1;
  /** Additive structured Team Identity context for the held position's side.
   * Omitted by older callers / null when enrichment was unavailable. */
  sideContext?: SideContext | null;
  /** A non-fatal enrichment-degradation warning (team/role metadata
   * unavailable) — appended to `warnings[]` when present. */
  enrichmentWarning?: AgentWarning | undefined;
}

/**
 * Wrap an `ensurePositionClaimed` result in the v2 envelope. Only reached
 * on a successful outcome (a genuine claim failure throws and is handled by
 * the command's catch → failure envelope), so `ok` is always true here.
 *
 *   claimed        → payout shoulder + one confirmed claim-position effect.
 *   alreadyClaimed → no effect, no payout; a `claim-skipped-already-claimed`
 *                    info warning.
 *   recovered      → a `claim-recovered-already-claimed` info warning, plus a
 *                    reverted claim-position effect IFF this wallet had
 *                    broadcast a claim that reverted (gas spent). No payout.
 */
export function toClaimAgentEnvelope(
  result: EnsureClaimedResult,
  args: ToClaimEnvelopeArgs,
): AgentEnvelope<ClaimPayload> {
  const effects: AgentEffect[] = [];
  const warnings: AgentWarning[] = [];
  let payout: AgentPayout | null = null;

  if (result.outcome === 'claimed') {
    // profit and totalReturn are the same on a settled claim (the payout IS
    // the return — the risk was locked in long ago at submit/match time).
    const payoutWei6 = result.payoutWei6 as bigint;
    const payoutAmount: PerspectiveAmount = {
      wei6: payoutWei6.toString(),
      usdc: wei6ToDecimalUSDC(payoutWei6),
    };
    payout = { profit: payoutAmount, totalReturn: payoutAmount };
    const claimedEffect: AgentEffect = {
      type: 'transaction',
      purpose: 'claim-position',
      ok: true,
      txHash: result.txHash as Hex,
      status: 'confirmed',
    };
    // exactOptionalPropertyTypes: omit blockNumber rather than set undefined.
    if (result.blockNumber !== undefined) claimedEffect.blockNumber = result.blockNumber.toString();
    effects.push(claimedEffect);
  } else if (result.outcome === 'alreadyClaimed') {
    warnings.push({
      code: 'claim-skipped-already-claimed',
      message: `Position (speculation ${args.speculationId}, type ${args.positionType}) was already claimed on-chain — no transaction sent.`,
      severity: 'info',
      details: {
        speculationId: args.speculationId.toString(),
        positionType: args.positionType,
        positionSideContext: args.sideContext ?? null,
      },
    });
  } else {
    if (result.revertedTxHash !== undefined) {
      effects.push({
        type: 'transaction',
        purpose: 'claim-position',
        ok: false,
        txHash: result.revertedTxHash as Hex,
        status: 'reverted',
      });
    }
    warnings.push({
      code: 'claim-recovered-already-claimed',
      message: `Position (speculation ${args.speculationId}, type ${args.positionType}) was already claimed by a concurrent transaction — recovered, no claim needed.`,
      severity: 'info',
      details: {
        speculationId: args.speculationId.toString(),
        positionType: args.positionType,
        positionSideContext: args.sideContext ?? null,
      },
    });
  }

  // Append the non-fatal enrichment-degradation warning, if any (team/role
  // metadata couldn't be fetched). Distinct from the outcome warnings above.
  if (args.enrichmentWarning) warnings.push(args.enrichmentWarning);

  return buildAgentEnvelope<ClaimPayload>({
    ok: true,
    action: 'claim',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.signerAddress,
    walletRole: 'signer',
    signer: args.signerAddress,
    payout,
    warnings,
    effects,
    nextCommands: [VERIFY_POSITION_STATUS.build({ address: args.signerAddress })],
    payload: {
      outcome: result.outcome,
      txHash: result.outcome === 'claimed' ? result.txHash ?? null : null,
      blockNumber: result.outcome === 'claimed' ? result.blockNumber?.toString() ?? null : null,
      revertedTxHash: result.revertedTxHash ?? null,
      payoutWei6: result.outcome === 'claimed' ? (result.payoutWei6 as bigint).toString() : null,
      payoutUSDC: result.outcome === 'claimed' ? result.payoutUSDC ?? null : null,
      speculationId: args.speculationId.toString(),
      positionType: args.positionType,
      positionSideContext: args.sideContext ?? null,
    },
  });
}
