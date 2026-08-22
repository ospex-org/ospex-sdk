/**
 * `ospex commitments filled-risk <hash...> [--block <n>] [--json]`
 *
 * Read-only utility — prints `MatchingModule.s_filledRisk[hash]` for one or
 * more commitment hashes. The hashes go out as one viem `multicall`
 * operation, which viem may split into several Multicall3 aggregates when the
 * calldata outgrows its batch limit; every aggregate carries the same pinned
 * block, so a split cannot cost coherence. No signer required; only an
 * `rpcUrl`.
 *
 * The contract is the canonical authority for how much of a commitment is
 * already matched; the indexed mirror lags it. `remaining = riskAmount -
 * filledRisk`, which is the same arithmetic `MatchingModule.matchCommitment`
 * performs. `atBlock` is printed so a funding read taken at the same block
 * (`ospex approvals show`, `ospex doctor`) can be compared against it — see
 * the `commitments.getFilledRisk` SDK docblock.
 *
 * A hash with no fill prints `0`. That is the storage default and a real
 * answer: `s_filledRisk` is a mapping, so an unfilled commitment and an
 * unknown hash are the same slot and this read cannot separate them. Every
 * failure path raises instead, so `0` never stands in for a failed read.
 *
 * Under `--json` every failure after `getClient()` returns is emitted as a v2
 * failure envelope on stdout (`AGENT_ENVELOPE_SPEC.md` §6) — this is a Class A
 * command (§4.1), so `--json | jq .` has something to parse whether the read
 * succeeded or the RPC refused it. Failures BEFORE the client exists (argument
 * validation, missing config) keep the stderr fallback §6 carves out.
 */

import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import { wei6ToDecimalUSDC, type Hex } from '@ospex/sdk';
import { formatOutput } from '../../lib/format.js';
import {
  buildAgentEnvelope,
  emitJsonFailure,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { getClient } from '../../lib/client.js';

const argsSchema = z
  .array(z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte commitment hash'))
  .min(1, 'at least one commitment hash is required');

const optionsSchema = z.object({
  block: z.string().regex(/^[0-9]+$/, 'must be a non-negative integer block number').optional(),
  json: z.boolean().optional(),
});

export const commitmentsFilledRiskCommand = new Command('filled-risk')
  .description(
    'Read the on-chain filled risk for one or more commitment hashes. Sent as one viem ' +
      'multicall operation pinned to one block — viem may split it into several Multicall3 ' +
      'aggregates, all at that same block; prints the block so a funding read can be taken ' +
      'at the same instant. A hash with no fill reads 0.',
  )
  .argument('<hash...>', 'one or more full 0x-prefixed commitment hashes')
  .option(
    '--block <n>',
    'pin the read to this block number. Default: the current block, resolved first so the ' +
      'printed atBlock is the block the values were read at.',
  )
  .option('--json', 'output as JSON')
  .action(async (rawHashes, rawOpts) => {
    const hashes = argsSchema.parse(rawHashes) as Hex[];
    const opts = optionsSchema.parse(rawOpts);
    const client = await getClient({ requiresChain: true });
    const chainId = client.chainId();
    const wantJson = opts.json === true;

    try {
      const args =
        opts.block === undefined
          ? { hashes }
          : { hashes, blockNumber: BigInt(opts.block) };
      const { atBlock, filledRisk } = await client.commitments.getFilledRisk(args);

      // Iterate the INPUT list, not the map, so the printed order is the order
      // the caller asked in and a missing entry surfaces as a crash here rather
      // than as a silently shorter table.
      const rows = hashes.map((hash) => {
        const value = filledRisk.get(hash);
        if (value === undefined) {
          throw new Error(`filled risk missing for ${hash}`);
        }
        return {
          hash,
          filledRiskWei6: value.toString(),
          filledRiskUSDC: wei6ToDecimalUSDC(value),
        };
      });

      if (wantJson) {
        writeAgentEnvelope(
          buildAgentEnvelope({
            ok: true,
            action: 'commitments.filled-risk',
            stage: 'read',
            network: networkForChainId(chainId),
            chainId,
            // No wallet shoulder field: this read is keyed by commitment hash
            // and is maker-agnostic — any address can run it for any hash.
            payload: {
              atBlock: atBlock.toString(),
              filledRisk: rows,
            },
          }),
        );
        return;
      }

      formatOutput({ atBlock: atBlock.toString() }, { json: false });
      formatOutput(rows, { json: false });
    } catch (err) {
      if (wantJson) {
        // Shoulder fields stay at the envelope defaults (`wallet: null`,
        // `walletRole: 'none'`, `signer: null`, both intent flags false) —
        // the same maker-agnostic, read-only shape §5.3 gives the success
        // envelope. A failure here must not advertise write intent.
        emitJsonFailure({
          action: 'commitments.filled-risk',
          stage: 'read',
          chainId,
          error: err,
        });
        process.exit(1);
      }
      throw err;
    }
  });
