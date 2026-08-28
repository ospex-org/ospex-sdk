/**
 * `ospex commitments show <hash-or-prefix>` — single-row lookup. Accepts
 * either the full EIP-712 hash OR a unique 0x-prefixed hex prefix
 * (≥ 8 hex chars after 0x). The prefix path resolves over ALL statuses
 * (`status: 'any'`) — `show` is a read, no constraint on whether the
 * commitment is still live.
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
import { formatOutput } from '../../lib/format.js';

const optionsSchema = z.object({ json: z.boolean().optional() });

/** Named once so the success envelope and the §6 failure envelope cannot drift. */
const ACTION = 'commitments.show';

export const commitmentsShowCommand = new Command('show')
  .description('Show a single commitment by full hash or unique 0x-prefixed prefix (≥ 8 hex chars).')
  .argument('<hash-or-prefix>', 'full commitment hash, or unique 0x-prefixed hex prefix')
  .option('--json', 'output as JSON')
  .action(async (hashArg, rawOpts) => {
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresSigner: false });
    // Hoisted out of the `--json` branch so the catch can name the chain.
    const chainId = client.chainId();

    // No `subject`: this read is NOT maker-agnostic — its success envelope
    // reports the resolved maker as `wallet` / `walletRole: 'subject'`. But the
    // maker arrives in the RESPONSE, so a failure of the read that would have
    // carried it has no subject to name (§6: `null` is reserved for exactly
    // those 'never came into scope' failures).
    await withReadFailureEnvelope({ action: ACTION, chainId, json: opts.json === true }, async () => {
      // 'any' status — show is a read, resolves cancelled/expired/invalidated rows too.
      const commitment = await client.commitments.resolveByPrefix(hashArg, {
        status: 'any',
      });
      if (commitment.commitmentHash.toLowerCase() !== hashArg.toLowerCase()) {
        process.stderr.write(`Resolved ${hashArg} → ${commitment.commitmentHash}\n`);
      }

      if (opts.json === true) {
        const wallet = commitment.maker.toLowerCase() as Hex;
        // Detail-fetch command: per spec §3.4, populate the
        // `commitment` shoulder field even though the full object is
        // also in `payload`. Lets generic agents render context from
        // the shoulder block without inspecting payload shape.
        writeAgentEnvelope(
          buildAgentEnvelope({
            ok: true,
            action: ACTION,
            stage: 'read',
            network: networkForChainId(chainId),
            chainId,
            wallet,
            walletRole: 'subject',
            commitment,
            payload: commitment,
          }),
        );
        return;
      }
      if (commitment.redacted === true) {
        // Hidden body — only the public allow-list fields are present (own-state
        // SSE plan §2.3). Render those plus a sentinel for the redacted ones so
        // the operator immediately sees what's not available without a
        // confusing "undefined" cell. The maker recovers the full payload via
        // `client.ownState.snapshot({address, cursor?})` (returns ONE page;
        // drain via cursor loop while truncated:true) or
        // `client.ownState.getCommitment({address, hash})` for a single-row
        // snapshot-scope lookup — M5/PR3b.
        const HIDDEN = '[redacted: book_visible=false]';
        formatOutput(
          {
            hash: commitment.commitmentHash,
            maker: commitment.maker,
            contestId: commitment.contestId ?? '-',
            scorer: HIDDEN,
            market: HIDDEN,
            line: HIDDEN,
            side: commitment.positionType === 0 ? 'upper' : commitment.positionType === 1 ? 'lower' : '-',
            odds: HIDDEN,
            risk: HIDDEN,
            filled: commitment.filledRiskAmount,
            remaining: HIDDEN,
            nonce: HIDDEN,
            expiry: commitment.expiry ?? '-',
            speculationKey: HIDDEN,
            status: commitment.status,
            createdAt: HIDDEN,
          },
          { json: false },
        );
        return;
      }
      formatOutput(
        {
          hash: commitment.commitmentHash,
          maker: commitment.maker,
          contestId: commitment.contestId ?? '-',
          scorer: commitment.scorer ?? '-',
          market: commitment.marketType ?? '-',
          line: commitment.lineTicks ?? '-',
          side: commitment.positionType === 0 ? 'upper' : commitment.positionType === 1 ? 'lower' : '-',
          odds: commitment.oddsTick ?? '-',
          risk: commitment.riskAmount,
          filled: commitment.filledRiskAmount,
          remaining: commitment.remainingRiskAmount,
          nonce: commitment.nonce,
          expiry: commitment.expiry ?? '-',
          speculationKey: commitment.speculationKey ?? '-',
          status: commitment.status,
          createdAt: commitment.createdAt,
        },
        { json: false },
      );
    });
  });
