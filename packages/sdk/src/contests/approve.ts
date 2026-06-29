/**
 * `client.contests.approveFee(amount | 'max')` — approve TreasuryModule
 * to spend USDC for the contest creation fee. Distinct from the
 * commitments USDC approval (which targets PositionModule).
 *
 * The SDK never auto-approves; the CLI prompts on OspexAllowanceError
 * and calls this as the user-confirmed remediation. (R5/CRE removed the
 * LINK approval — contest creation/scoring carries no LINK payment.)
 */
import { encodeFunctionData, maxUint256, type Hash, type TransactionReceipt } from 'viem';
import { erc20Abi } from '../contracts/abi/erc20.js';
import { OspexValidationError } from '../errors.js';
import { buildSignAndSend } from '../commitments/sendTx.js';
import type { ContestsContext } from './context.js';

export type ApproveArgs = bigint | 'max';

export interface ApproveResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  spender: string;
  token: string;
  amount: bigint;
}

async function approveErc20(
  ctx: ContestsContext,
  token: `0x${string}`,
  spender: `0x${string}`,
  amount: ApproveArgs,
): Promise<ApproveResult> {
  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
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
    args: [spender, amountWei],
  });

  const { txHash, receipt } = await buildSignAndSend({
    publicClient,
    signer,
    chainId,
    to: token,
    data,
  });
  return { txHash, receipt, spender, token, amount: amountWei };
}

export function approveFee(ctx: ContestsContext, amount: ApproveArgs): Promise<ApproveResult> {
  const { usdc, treasuryModule } = ctx.getAddresses();
  return approveErc20(ctx, usdc, treasuryModule, amount);
}
