/**
 * `client.balances.read({ owner? })` — single round-trip read of the
 * three balances `ospex doctor` cares about: native gas (POL), USDC,
 * LINK.
 *
 * Three reads run in parallel:
 *   - native: publicClient.getBalance({ address })
 *   - USDC:   ERC20.balanceOf(owner)
 *   - LINK:   ERC20.balanceOf(owner)
 *
 * Like `client.approvals.read()`, passing `owner` keeps the call fully
 * read-only and avoids a Foundry-keystore passphrase prompt.
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
  const link = addresses.linkToken as Hex;

  const [native, usdcBalance, linkBalance] = await Promise.all([
    publicClient.getBalance({ address: owner }),
    publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: link,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    }) as Promise<bigint>,
  ]);

  return {
    owner,
    chainId,
    native,
    usdc: usdcBalance,
    link: linkBalance,
    usdcAddress: usdc,
    linkAddress: link,
  };
}
