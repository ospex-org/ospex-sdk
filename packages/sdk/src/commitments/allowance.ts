/**
 * USDC allowance check + the OspexAllowanceError builder.
 *
 * The spender is ALWAYS PositionModule (NOT MatchingModule). This is
 * the most common new-integrator confusion — keep it pinned here.
 * MatchingModule never custodies funds; PositionModule's `recordFill`
 * is where `safeTransferFrom` happens (`PositionModule._recordFill`).
 */

import type { PublicClient } from 'viem';
import { erc20Abi } from '../contracts/abi/erc20.js';
import { OspexAllowanceError } from '../errors.js';
import type { Hex } from '../types/signer.js';

export async function readAllowance(
  publicClient: PublicClient,
  token: Hex,
  owner: Hex,
  spender: Hex,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })) as bigint;
}

/**
 * Throws OspexAllowanceError if the wallet's USDC allowance for
 * PositionModule is below `required`. The structured error carries
 * everything the CLI needs to prompt-and-retry without re-reading
 * the chain.
 */
export async function assertSufficientAllowance(
  publicClient: PublicClient,
  token: Hex,
  owner: Hex,
  spender: Hex,
  required: bigint,
): Promise<void> {
  const current = await readAllowance(publicClient, token, owner, spender);
  if (current < required) {
    throw new OspexAllowanceError(
      `Insufficient USDC allowance. Required ${required}, current ${current}. Approve PositionModule (${spender}) for USDC.`,
      { required, current, spender, token },
    );
  }
}
