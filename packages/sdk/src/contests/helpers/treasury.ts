/**
 * Reads the contest creation fee from TreasuryModule.s_feeRates. The
 * mapping is set immutably in the constructor, so a single read at SDK
 * boot is sufficient — but we re-read on each create call to stay
 * truthful in the (rare) case of a redeploy where the SDK's bundled
 * addresses point at a new TreasuryModule with a different fee.
 *
 * FeeType.ContestCreation = 0 (first enum value in OspexTypes.sol).
 */
import type { PublicClient } from 'viem';
import { OspexChainError } from '../../errors.js';
import type { Hex } from '../../types/signer.js';

const TREASURY_MODULE_FEE_RATES_ABI = [
  {
    type: 'function',
    name: 's_feeRates',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint8' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const FEE_TYPE_CONTEST_CREATION = 0;

export async function readContestCreationFee(
  publicClient: PublicClient,
  treasuryModule: Hex,
): Promise<bigint> {
  try {
    return (await publicClient.readContract({
      address: treasuryModule,
      abi: TREASURY_MODULE_FEE_RATES_ABI,
      functionName: 's_feeRates',
      args: [FEE_TYPE_CONTEST_CREATION],
    })) as bigint;
  } catch (err) {
    throw new OspexChainError('Failed to read contest creation fee from TreasuryModule.', {
      cause: err,
    });
  }
}
