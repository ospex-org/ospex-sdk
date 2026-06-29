/**
 * USDC pre-flight check for contest creation.
 *
 * USDC is approved to TreasuryModule for the contest creation fee.
 * `TreasuryModule.processFee` calls `i_token.safeTransferFrom(payer,
 * i_protocolReceiver, amount)` — `i_token.safeTransferFrom` runs in
 * TreasuryModule's context, so TreasuryModule is the spender.
 *
 * Note: this differs from the M2 commitments fee path where
 * PositionModule is the spender. The contest creation fee path is
 * distinct. (R5/CRE creation is permissionless and charges only this
 * USDC fee — there is no LINK payment.)
 */
import type { PublicClient } from 'viem';
import { erc20Abi } from '../../contracts/abi/erc20.js';
import { OspexAllowanceError } from '../../errors.js';
import type { Hex } from '../../types/signer.js';

interface BalanceAndAllowance {
  balance: bigint;
  allowance: bigint;
}

export async function readBalanceAndAllowance(
  publicClient: PublicClient,
  token: Hex,
  owner: Hex,
  spender: Hex,
): Promise<BalanceAndAllowance> {
  const [balance, allowance] = await Promise.all([
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    }) as Promise<bigint>,
  ]);
  return { balance, allowance };
}

export async function assertUsdcSufficient(
  publicClient: PublicClient,
  usdc: Hex,
  owner: Hex,
  treasuryModule: Hex,
  required: bigint,
  tokenLabel = 'USDC',
): Promise<void> {
  const { balance, allowance } = await readBalanceAndAllowance(publicClient, usdc, owner, treasuryModule);
  if (balance < required) {
    throw new OspexAllowanceError(
      `Insufficient ${tokenLabel} balance. Required ${required}, current ${balance}. Fund the wallet ${owner} with ${tokenLabel}.`,
      { required, current: balance, spender: treasuryModule, token: usdc },
    );
  }
  if (allowance < required) {
    throw new OspexAllowanceError(
      `Insufficient ${tokenLabel} allowance. Required ${required}, current ${allowance}. Approve TreasuryModule (${treasuryModule}) for ${tokenLabel}.`,
      { required, current: allowance, spender: treasuryModule, token: usdc },
    );
  }
}
