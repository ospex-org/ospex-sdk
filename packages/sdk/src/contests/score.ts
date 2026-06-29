/**
 * `client.contests.score({ contestId })` — submits a
 * `CreOracleReceiver.requestScore` transaction (R5 / CRE).
 *
 * Permissionless and free (no USDC fee, no LINK, no Chainlink subscription,
 * no EIP-712 script approval, no encrypted secrets — all retired with the
 * Functions oracle). The contest must already be `Verified`, and the call
 * reverts (`CreOracleReceiver__PrematureScoreRequest`) until the contest's
 * on-chain start time has passed — request it after the game has started.
 *
 * Scoring is asynchronous: an off-chain Chainlink CRE workflow resolves the
 * emitted `CreOracleRequested` log and reports back via the KeystoneForwarder,
 * which flips the contest to `Scored` and emits `ContestScoresSet`. The SDK
 * does not block waiting for it — poll `client.contests.get(contestId)` until
 * `status === 'scored'`.
 */
import {
  encodeFunctionData,
  type Hash,
  type TransactionReceipt,
} from 'viem';
import { creOracleReceiverAbi } from '../contracts/abi/index.js';
import { OSPEX_SCORE_CONTEST_TX_GAS } from '../contracts/constants.js';
import { OspexValidationError } from '../errors.js';
import { buildSignAndSend } from '../commitments/sendTx.js';
import type { ContestsContext } from './context.js';

export interface ScoreContestArgs {
  contestId: bigint | string | number;
}

export interface ScoreContestResult {
  contestId: bigint;
  txHash: Hash;
  receipt: TransactionReceipt;
}

export async function score(
  ctx: ContestsContext,
  args: ScoreContestArgs,
): Promise<ScoreContestResult> {
  const id = typeof args.contestId === 'bigint' ? args.contestId : BigInt(args.contestId);
  if (id <= 0n) {
    throw new OspexValidationError('contestId must be a positive integer.', { field: 'contestId' });
  }

  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const addresses = ctx.getAddresses();

  const data = encodeFunctionData({
    abi: creOracleReceiverAbi,
    functionName: 'requestScore',
    args: [id],
  });

  // Hardcoded outer-tx gas (OSPEX_SCORE_CONTEST_TX_GAS) bypasses estimateGas;
  // EIP-1559 refunds the unused portion. requestScore is a light tx (a flag +
  // events) but the budget stays a safe ceiling.
  const { txHash, receipt } = await buildSignAndSend({
    publicClient,
    signer,
    chainId: ctx.getChainId(),
    to: addresses.creOracleReceiver,
    data,
    gas: OSPEX_SCORE_CONTEST_TX_GAS,
  });

  return { contestId: id, txHash, receipt };
}
