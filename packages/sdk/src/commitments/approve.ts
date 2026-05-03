/**
 * `commitments.approve(amount | 'max')` — approve PositionModule to
 * spend USDC. The CLI wraps this around submit/match when allowance
 * is short; the SDK never auto-approves on its own.
 */

import { encodeFunctionData, maxUint256, type Hash } from 'viem';
import { erc20Abi } from '../contracts/abi/erc20.js';
import { OspexValidationError } from '../errors.js';
import { buildSignAndSend } from './sendTx.js';
import type { CommitmentsContext } from './context.js';
import type { TransactionReceipt } from 'viem';

export type ApproveArgs = bigint | 'max';

export interface ApproveResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  spender: string;
  token: string;
  amount: bigint;
}

export async function approve(
  ctx: CommitmentsContext,
  amount: ApproveArgs,
): Promise<ApproveResult> {
  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const { positionModule, usdc } = ctx.getAddresses();
  const chainId = ctx.getChainId();

  let amountWei: bigint;
  if (amount === 'max') {
    amountWei = maxUint256;
  } else {
    if (amount < 0n) {
      throw new OspexValidationError('approve amount must be non-negative.', { field: 'amount' });
    }
    amountWei = amount;
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [positionModule, amountWei],
  });

  const { txHash, receipt } = await buildSignAndSend({
    publicClient,
    signer,
    chainId,
    to: usdc,
    data,
  });

  return { txHash, receipt, spender: positionModule, token: usdc, amount: amountWei };
}
