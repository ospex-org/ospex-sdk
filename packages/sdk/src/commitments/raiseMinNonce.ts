/**
 * `commitments.raiseMinNonce({ contestId, scorer, lineTicks, newMinNonce })`
 * — raw passthrough to `MatchingModule.raiseMinNonce`. Lifts the per-
 * (maker, speculationKey) nonce floor; every commitment with `nonce <
 * newMinNonce` becomes unmatchable on chain (`matchCommitment` reverts
 * with `MatchingModule__NonceTooLow`). The indexer projects this by
 * setting `nonce_invalidated = true` on the affected rows — the row's
 * `status` is NOT changed.
 *
 * Use `cancelAllOnSpeculation` for the convenience wrapper that
 * computes a sensible default `newMinNonce`. This raw method is for
 * callers that want exact control over the floor value (e.g. after
 * external coordination through a Redis-backed counter).
 *
 * Reverts mapped:
 *   `MatchingModule__NonceMustIncrease` →
 *      OspexChainError({ reason: 'NonceMustIncrease' })
 */

import { encodeFunctionData, type Hash, type TransactionReceipt } from 'viem';
import { matchingModuleAbi } from '../contracts/abi/index.js';
import { OspexValidationError } from '../errors.js';
import { deriveSpeculationKey } from '../chain/eip712.js';
import { buildSignAndSend } from './sendTx.js';
import { sendWithMatchingErrorClassification } from './matchingErrors.js';
import { validateLineTicks } from './validation.js';
import type { CommitmentsContext } from './context.js';
import type { Hex } from '../types/signer.js';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface RaiseMinNonceArgs {
  contestId: bigint;
  scorer: Hex;
  lineTicks: number;
  newMinNonce: bigint;
}

export interface RaiseMinNonceResult {
  txHash: Hash;
  receipt: TransactionReceipt;
}

export async function raiseMinNonce(
  ctx: CommitmentsContext,
  args: RaiseMinNonceArgs,
): Promise<RaiseMinNonceResult> {
  if (args.contestId < 0n) {
    throw new OspexValidationError('contestId must be non-negative.', { field: 'contestId' });
  }
  if (!ADDRESS_PATTERN.test(args.scorer)) {
    throw new OspexValidationError('scorer must be a 0x-prefixed 20-byte address.', { field: 'scorer' });
  }
  validateLineTicks(args.lineTicks);
  if (args.newMinNonce <= 0n) {
    throw new OspexValidationError('newMinNonce must be positive.', { field: 'newMinNonce' });
  }

  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const { matchingModule } = ctx.getAddresses();
  const chainId = ctx.getChainId();
  const scorer = args.scorer.toLowerCase() as Hex;

  const data = encodeFunctionData({
    abi: matchingModuleAbi,
    functionName: 'raiseMinNonce',
    args: [args.contestId, scorer, args.lineTicks, args.newMinNonce],
  });

  const { txHash, receipt } = await sendWithMatchingErrorClassification(
    'raiseMinNonce',
    () =>
      buildSignAndSend({
        publicClient,
        signer,
        chainId,
        to: matchingModule,
        data,
      }),
  );

  // Bump the in-process counter so subsequent submits in this process
  // start above the new floor without an extra eth_call to refresh.
  const maker = (await signer.getAddress()).toLowerCase() as Hex;
  const speculationKey = deriveSpeculationKey(args.contestId, scorer, args.lineTicks);
  ctx.nonceCounter.observe(maker, speculationKey, args.newMinNonce);

  return { txHash, receipt };
}
