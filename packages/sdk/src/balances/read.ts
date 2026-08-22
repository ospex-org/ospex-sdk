/**
 * `client.balances.read({ owner? })` — single round-trip read of the
 * two balances `ospex doctor` cares about: native gas (POL) and USDC.
 *
 * Two reads run in parallel:
 *   - native: publicClient.getBalance({ address })
 *   - USDC:   ERC20.balanceOf(owner)
 *
 * Like `client.approvals.read()`, passing `owner` keeps the call fully
 * read-only and avoids a Foundry-keystore passphrase prompt.
 *
 * Passing `blockNumber` pins both reads to that block — see
 * `ReadBalancesArgs.blockNumber` and the `commitments.getFilledRisk`
 * docblock for why a funding comparison wants one instant.
 */

import { erc20Abi } from '../contracts/abi/erc20.js';
import type { BalancesContext } from './context.js';
import type { BalancesSnapshot, ReadBalancesArgs } from './types.js';
import type { Hex } from '../types/signer.js';

export async function read(
  ctx: BalancesContext,
  args: ReadBalancesArgs = {},
): Promise<BalancesSnapshot> {
  const publicClient = ctx.requireChainClient();
  const addresses = ctx.getAddresses();
  const chainId = ctx.getChainId();

  let owner: Hex;
  if (args.owner !== undefined) {
    owner = args.owner;
  } else {
    owner = (await ctx.requireSigner().getAddress()) as Hex;
  }

  const usdc = addresses.usdc as Hex;

  // Spread rather than pass `blockNumber: undefined` — `getBalance`'s
  // parameters are a discriminated union over blockNumber/blockTag/blockHash,
  // and `exactOptionalPropertyTypes` refuses an explicit undefined.
  const at = args.blockNumber === undefined ? {} : { blockNumber: args.blockNumber };

  const [native, usdcBalance] = await Promise.all([
    publicClient.getBalance({ address: owner, ...at }),
    publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
      ...at,
    }) as Promise<bigint>,
  ]);

  return {
    owner,
    chainId,
    native,
    usdc: usdcBalance,
    usdcAddress: usdc,
  };
}
