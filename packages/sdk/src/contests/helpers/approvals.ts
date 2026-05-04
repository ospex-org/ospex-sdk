/**
 * LINK + USDC pre-flight checks for contest creation / scoring.
 *
 * - LINK is approved to OracleModule (the modifier `handleLinkPayment`
 *   pulls via `safeTransferFrom(msg.sender, address(this), payment)` —
 *   `address(this)` is OracleModule, so OracleModule is the spender).
 * - USDC is approved to TreasuryModule for the contest creation fee.
 *   `TreasuryModule.processFee` calls `i_token.safeTransferFrom(payer,
 *   i_protocolReceiver, amount)` — `i_token.safeTransferFrom` runs in
 *   TreasuryModule's context, so TreasuryModule is the spender.
 *
 *   Note: this differs from the M2 commitments fee path where
 *   PositionModule is the spender. The contest creation fee path is
 *   distinct.
 */
import type { PublicClient } from 'viem';
import { erc20Abi } from '../../contracts/abi/erc20.js';
import { OspexAllowanceError, OspexSubscriptionError } from '../../errors.js';
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

export async function assertLinkSufficient(
  publicClient: PublicClient,
  link: Hex,
  owner: Hex,
  oracleModule: Hex,
  required: bigint,
): Promise<void> {
  const { balance, allowance } = await readBalanceAndAllowance(publicClient, link, owner, oracleModule);
  if (balance < required) {
    throw new OspexSubscriptionError(
      `Insufficient LINK balance. Required ${required}, current ${balance}. Fund the wallet ${owner} with LINK.`,
      { reason: 'link_balance_insufficient' },
    );
  }
  if (allowance < required) {
    throw new OspexAllowanceError(
      `Insufficient LINK allowance. Required ${required}, current ${allowance}. Approve OracleModule (${oracleModule}) for LINK.`,
      { required, current: allowance, spender: oracleModule, token: link },
    );
  }
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
