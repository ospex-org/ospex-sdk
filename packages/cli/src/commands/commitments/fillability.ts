/**
 * `ospex commitments fillability <hash-or-prefix> [flags]` — advisory,
 * read-only "can a taker fill this commitment right now?" check. Surfaces
 * the SDK's `commitments.checkCommitmentFillability` verdict so an agent can
 * avoid wasting gas on a commitment that is visible and validly signed but
 * would revert at fill time (maker/taker moved USDC or dropped allowance).
 *
 * It sends NO transaction and requires no signature — pass `--taker` (or rely
 * on `--expected-address` / your configured wallet) to name the prospective
 * filler. Requires an `rpcUrl` (the funding reads are on-chain). Resolves the
 * commitment over ALL statuses, so a terminal row reports `NOT_LIVE` /
 * `EXPIRED` rather than failing to resolve.
 *
 * The verdict is ADVISORY: "fillable now, based on the latest reads" — never a
 * guarantee. The standalone read companion to the (forthcoming) `commitments
 * match` preflight that refuses an obviously-unfillable match before sending.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  OspexValidationError,
  usdcDecimalToAmountWei6,
  wei6ToDecimalUSDC,
  type FillabilityReason,
  type Hex,
} from '@ospex/sdk';
import { getClient, resolvePreviewAddress } from '../../lib/client.js';
import { addSignerOptions, parseSignerIntent } from '../../lib/signer-options.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({
  riskUsdc: z.string().min(1, '--risk-usdc cannot be empty').optional(),
  taker: z.string().optional(),
  json: z.boolean().optional(),
});

export const commitmentsFillabilityCommand = addSignerOptions(
  new Command('fillability')
    .description(
      'Advisory check: can a taker fill this commitment right now? Reads the maker/taker ' +
        'USDC balances and PositionModule allowance plus liveness, and reports a structured ' +
        'verdict (fillable / not-fillable / unknown) WITHOUT sending a tx. Accepts a full ' +
        '0x-prefixed hash OR a unique 0x-prefixed hex prefix. Advisory only — funding can change ' +
        'between this read and the fill.',
    )
    .argument('<hash-or-prefix>', 'full commitment hash, or unique 0x-prefixed hex prefix')
    .option(
      '--risk-usdc <decimal>',
      "taker's desired fill risk in decimal USDC (e.g. \"1\" or \"0.5\"). Default: fully fill the " +
        "maker's remaining capacity.",
    )
    .option(
      '--taker <address>',
      'prospective taker address to check. Default: your configured wallet (or --expected-address). ' +
        'Pass it to check fillability for any address without unlocking a keystore.',
    )
    .option('--json', 'machine-readable agent envelope (schemaVersion 2)'),
).action(async (hashArg, rawOpts) => {
  const opts = optionsSchema.parse(rawOpts);
  const signerIntent = parseSignerIntent(rawOpts);

  // Read-only: chain client for the funding reads, no signer unlock. The taker
  // is named explicitly via --taker, else resolved from --expected-address /
  // non-interactive creds / a cached session (never an interactive prompt).
  const client = await getClient({ requiresChain: true });
  let taker: Hex;
  if (opts.taker !== undefined) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(opts.taker)) {
      throw new OspexValidationError(
        `--taker must be a 0x-prefixed 20-byte address; got "${opts.taker}".`,
        { field: 'taker' },
      );
    }
    taker = opts.taker.toLowerCase() as Hex;
  } else {
    taker = await resolvePreviewAddress(signerIntent);
  }

  // 'any' status — fillability reports on cancelled/expired/filled rows too
  // (NOT_LIVE / EXPIRED / NO_REMAINING_CAPACITY) rather than failing to resolve.
  const commitment = await client.commitments.resolveByPrefix(hashArg, { status: 'any' });
  if (commitment.commitmentHash.toLowerCase() !== hashArg.toLowerCase()) {
    process.stderr.write(`Resolved ${hashArg} → ${commitment.commitmentHash}\n`);
  }

  const checkArgs: Parameters<typeof client.commitments.checkCommitmentFillability>[0] = {
    commitment,
    taker,
  };
  if (opts.riskUsdc !== undefined) {
    checkArgs.takerDesiredRiskWei6 = usdcDecimalToAmountWei6(opts.riskUsdc);
  }
  const result = await client.commitments.checkCommitmentFillability(checkArgs);

  if (opts.json === true) {
    const chainId = client.chainId();
    // ok:true — the CHECK ran successfully; the verdict (fillableNow / outcome /
    // reasons) lives in the payload. A genuine error (404, missing rpcUrl) still
    // bubbles to the top-level handler. The taker is the subject of the check.
    writeAgentEnvelope(
      buildAgentEnvelope({
        ok: true,
        action: 'commitments.fillability',
        stage: 'read',
        network: networkForChainId(chainId),
        chainId,
        wallet: taker,
        walletRole: 'subject',
        commitment,
        payload: result,
      }),
    );
    return;
  }

  formatOutput(
    {
      hash: result.commitmentHash,
      taker,
      fillableNow: result.fillableNow,
      outcome: result.outcome,
      ...(result.fill !== undefined
        ? {
            takerRisk: `${wei6ToDecimalUSDC(result.fill.takerRiskWei6)} USDC`,
            fillMakerRisk: `${wei6ToDecimalUSDC(result.fill.makerRiskWei6)} USDC`,
            selfMatch: result.fill.selfMatch,
          }
        : {}),
      ...(result.checkedAtBlock !== undefined
        ? { checkedAtBlock: result.checkedAtBlock.toString() }
        : {}),
      reasons: result.reasons.length > 0 ? result.reasons.map(formatReason).join('; ') : 'none',
    },
    { json: false },
  );
});

/** One-line human rendering of a reason — funding reasons carry the
 * required-vs-actual amounts so the shortfall is legible at a glance. */
function formatReason(r: FillabilityReason): string {
  if (r.requiredWei6 !== undefined && r.actualWei6 !== undefined) {
    return `${r.code} (need ${wei6ToDecimalUSDC(r.requiredWei6)} USDC, have ${wei6ToDecimalUSDC(r.actualWei6)})`;
  }
  return r.code;
}
