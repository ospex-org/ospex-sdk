/**
 * USDC `approve()` helpers for the commitments flow. Two spenders
 * matter — they're separate approvals and the SDK exposes one method
 * per spender so call sites are explicit:
 *
 *   - `commitments.approve(amount | 'max')`  → PositionModule
 *     The maker's `riskAmount` is pulled from this allowance at match
 *     time (PositionModule.recordFill safeTransferFrom). Required for
 *     EVERY match, lazy or otherwise.
 *
 *   - `commitments.approveCreationFee(amount | 'max')`  → TreasuryModule
 *     The maker's HALF of the speculation creation fee
 *     (`SPECULATION_CREATION_FEE_MAKER_SHARE_WEI6`, currently 0.25 USDC
 *     on Polygon mainnet) is pulled from THIS allowance — but ONLY on
 *     the first match of a `(contestId, scorer, lineTicks)` key (i.e.
 *     when `speculation.mode === 'lazy'` at submit time). Once the
 *     speculation exists, no further matches incur the fee.
 *
 * The SDK never auto-approves; the CLI prompts users on
 * `OspexAllowanceError` or on the preview's `approvals[]` and calls
 * one of these as the user-confirmed remediation.
 */

import { encodeFunctionData, maxUint256, type Hash } from 'viem';
import { erc20Abi } from '../contracts/abi/erc20.js';
import { OspexValidationError } from '../errors.js';
import { buildSignAndSend } from './sendTx.js';
import type { CommitmentsContext } from './context.js';
import type { Hex } from '../types/signer.js';
import type { TransactionReceipt } from 'viem';

export type ApproveArgs = bigint | 'max';

export interface ApproveResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  spender: string;
  token: string;
  amount: bigint;
}

/**
 * Internal: encode + sign + send `USDC.approve(spender, amount)`.
 * Both public approve methods funnel through here so the only
 * difference between them is the spender address.
 */
async function approveUsdc(
  ctx: CommitmentsContext,
  spender: Hex,
  amount: ApproveArgs,
): Promise<ApproveResult> {
  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const { usdc } = ctx.getAddresses();
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
    to: usdc,
    data,
  });

  return { txHash, receipt, spender, token: usdc, amount: amountWei };
}

export function approve(
  ctx: CommitmentsContext,
  amount: ApproveArgs,
): Promise<ApproveResult> {
  const { positionModule } = ctx.getAddresses();
  return approveUsdc(ctx, positionModule as Hex, amount);
}

/**
 * Approve TreasuryModule for USDC — covers the maker's half of the
 * lazy speculation creation fee. See file header for when this
 * allowance is consumed (first match of a lazy spec).
 *
 * Note: this is the same spender targeted by
 * `client.contests.approveFee` (TreasuryModule). The contest creation
 * fee and the lazy speculation creation fee both pull from this single
 * allowance; one approval covers both. This method is named in the
 * commitments flow's vocabulary so call sites in the submit path
 * don't have to reach into `client.contests` for an approval that's
 * conceptually about commitments.
 */
export function approveCreationFee(
  ctx: CommitmentsContext,
  amount: ApproveArgs,
): Promise<ApproveResult> {
  const { treasuryModule } = ctx.getAddresses();
  return approveUsdc(ctx, treasuryModule as Hex, amount);
}
