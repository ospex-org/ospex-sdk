/**
 * `commitments.cancelOnchain(hash)` — call
 * `MatchingModule.cancelCommitment(commitment)` on chain.
 *
 * The on-chain cancel is authoritative: once `s_cancelledCommitments[hash]`
 * is set, `matchCommitment` reverts with `MatchingModule__CommitmentCancelled`
 * (MatchingModule.sol:490). The off-chain DELETE only stops the API
 * relay from rebroadcasting — it does NOT prevent a taker who already
 * holds the signed payload from matching the commitment.
 *
 * Pipeline:
 *   1. Validate the hash format.
 *   2. Fetch the full commitment via GET /v1/commitments/:hash.
 *   3. Verify all 9 EIP-712 struct fields are populated (some indexer-
 *      only rows have nulls — those can't be reconstructed).
 *   4. Encode `cancelCommitment(struct)` calldata.
 *   5. Sign + broadcast via the standard pipeline.
 *   6. Map `MatchingModule__NotCommitmentMaker` reverts to a typed
 *      `OspexChainError({ reason: 'NotCommitmentMaker' })`.
 *
 * Idempotency note: the contract has NO `AlreadyCancelled` revert path.
 * Calling `cancelOnchain` on a hash that is already cancelled succeeds —
 * it rewrites `s_cancelledCommitments[hash] = true` and re-emits the
 * `CommitmentCancelled` event. Do not infer "first cancel" from tx
 * success.
 */

import {
  encodeFunctionData,
  type Hash,
  type TransactionReceipt,
} from 'viem';
import { matchingModuleAbi } from '../contracts/abi/index.js';
import { OspexValidationError } from '../errors.js';
import { buildSignAndSend } from './sendTx.js';
import { sendWithMatchingErrorClassification } from './matchingErrors.js';
import type { CommitmentsContext } from './context.js';
import type { CommitmentBody } from '../api/types.js';
import type { Hex } from '../types/signer.js';

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface CancelOnchainResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  commitmentHash: Hex;
}

export async function cancelOnchain(
  ctx: CommitmentsContext,
  hash: Hex,
): Promise<CancelOnchainResult> {
  if (!HASH_PATTERN.test(hash)) {
    throw new OspexValidationError(
      'cancelOnchain hash must be a 0x-prefixed 32-byte hex string.',
      { field: 'hash' },
    );
  }
  const lowercaseHash = hash.toLowerCase() as Hex;

  // Fetch the full commitment so we can reconstruct the struct. The
  // contract recomputes the hash from the struct internally and reverts
  // if it doesn't match what was originally stored.
  const body = await ctx.api.request<CommitmentBody>(
    `/v1/commitments/${lowercaseHash}`,
  );

  // Indexer-only rows can have nulls in fields the contract requires.
  // Fail fast with a clear error rather than hitting a silent revert.
  const required = (
    [
      'contestId',
      'scorer',
      'lineTicks',
      'positionType',
      'oddsTick',
      'expiry',
    ] as const
  ).filter((k) => body[k] === null);
  if (required.length > 0) {
    const first = required[0];
    throw new OspexValidationError(
      `Commitment ${lowercaseHash} is missing fields needed to reconstruct the struct: ${required.join(
        ', ',
      )}.`,
      first !== undefined ? { field: first } : undefined,
    );
  }

  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const { matchingModule } = ctx.getAddresses();
  const chainId = ctx.getChainId();

  const data = encodeFunctionData({
    abi: matchingModuleAbi,
    functionName: 'cancelCommitment',
    args: [
      {
        maker: body.maker as Hex,
        contestId: BigInt(body.contestId as string),
        scorer: body.scorer as Hex,
        lineTicks: body.lineTicks as number,
        positionType: body.positionType as number,
        oddsTick: body.oddsTick as number,
        riskAmount: BigInt(body.riskAmount),
        nonce: BigInt(body.nonce),
        expiry: BigInt(
          Math.floor(new Date(body.expiry as string).getTime() / 1000),
        ),
      },
    ],
  });

  const { txHash, receipt } = await sendWithMatchingErrorClassification(
    'cancelCommitment',
    () =>
      buildSignAndSend({
        publicClient,
        signer,
        chainId,
        to: matchingModule,
        data,
      }),
  );

  return { txHash, receipt, commitmentHash: lowercaseHash };
}
