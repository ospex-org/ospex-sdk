/**
 * Read the current on-chain state of a single position via
 * `PositionModule.getPosition(speculationId, user, positionType)`. The
 * contract is the source of truth for claim status — the core-API
 * `claimable` projection can lag the chain by seconds, which is exactly
 * the gap `ensurePositionClaimed` closes.
 *
 * `getPosition` returns the full `Position` struct
 * `{ riskAmount, profitAmount, positionType, claimed, firstFillTimestamp,
 * acquiredViaSecondaryMarket }`. We narrow to `claimed` — the claim-side
 * analog of `getSpeculation().speculationStatus`.
 *
 * Deliberately NOT surfaced: `riskAmount` / `profitAmount`. The live
 * contract ZEROES those economic fields once `claimed` flips true, so
 * they're useless for deriving an already-claimed payout (a checked
 * mainnet already-claimed position read `riskAmount=0, profitAmount=0,
 * claimed=true`). The realized payout for an out-of-window claim must
 * come from the original `POSITION_CLAIMED` event or an API/indexer
 * projection — never a post-claim `getPosition`. Surfacing them here
 * would invite that bug, so this read intentionally drops them.
 */

import type { PublicClient } from 'viem';
import { positionModuleAbi } from '../contracts/abi/index.js';
import { OspexChainError } from '../errors.js';
import type { Hex } from '../types/signer.js';

export interface PositionState {
  /** On-chain claim flag. `true` ⇔ this position's payout has been
   * collected (the economic fields are zeroed at that point). */
  claimed: boolean;
}

export async function readPositionState(
  publicClient: PublicClient,
  positionModule: Hex,
  speculationId: bigint,
  user: Hex,
  positionType: 0 | 1,
): Promise<PositionState> {
  let position: { claimed: boolean };
  try {
    position = (await publicClient.readContract({
      address: positionModule,
      abi: positionModuleAbi,
      functionName: 'getPosition',
      args: [speculationId, user, positionType],
    })) as { claimed: boolean };
  } catch (err) {
    throw new OspexChainError(
      `Failed to read position (speculation ${speculationId}, type ${positionType}) from PositionModule.`,
      { cause: err },
    );
  }
  return { claimed: position.claimed === true };
}
