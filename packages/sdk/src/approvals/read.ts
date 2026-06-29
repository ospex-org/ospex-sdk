/**
 * `client.approvals.read({ owner? })` — single round-trip read of
 * every Ospex-relevant allowance for one wallet.
 *
 * Two reads run in parallel:
 *   - USDC → PositionModule (bet risk)
 *   - USDC → TreasuryModule (contest creation + lazy spec creation fees)
 *
 * The owner argument is optional. When omitted, the configured signer's
 * address is used; passing it explicitly avoids a passphrase prompt
 * for Foundry-keystore-backed signers and is the path the CLI
 * `approvals show --address` and `doctor` commands take when the user
 * has not already unlocked.
 */

import { readAllowance } from '../commitments/allowance.js';
import type { ApprovalsContext } from './context.js';
import type {
  AllowanceEntry,
  ApprovalsSnapshot,
  ReadApprovalsArgs,
} from './types.js';
import type { Hex } from '../types/signer.js';

export async function read(
  ctx: ApprovalsContext,
  args: ReadApprovalsArgs = {},
): Promise<ApprovalsSnapshot> {
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
  const positionModule = addresses.positionModule as Hex;
  const treasuryModule = addresses.treasuryModule as Hex;

  const [usdcPositionModule, usdcTreasuryModule] = await Promise.all([
    readAllowance(publicClient, usdc, owner, positionModule),
    readAllowance(publicClient, usdc, owner, treasuryModule),
  ]);

  const positionEntry: AllowanceEntry = {
    spender: positionModule,
    spenderModule: 'positionModule',
    raw: usdcPositionModule,
  };
  const treasuryEntry: AllowanceEntry = {
    spender: treasuryModule,
    spenderModule: 'treasuryModule',
    raw: usdcTreasuryModule,
  };

  return {
    owner,
    chainId,
    usdc: {
      address: usdc,
      decimals: 6,
      allowances: {
        positionModule: positionEntry,
        treasuryModule: treasuryEntry,
      },
    },
  };
}
