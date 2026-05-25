/**
 * Read the current on-chain state of a speculation via
 * `SpeculationModule.getSpeculation(speculationId)`. The contract is the
 * source of truth for settlement status — the core-API `pendingSettle`
 * bucket is a projection that can lag the chain by seconds, which is
 * exactly the gap `ensureSpeculationSettled` closes.
 *
 * `getSpeculation` returns the full `Speculation` struct; we only need
 * the lifecycle status and the resolved winning side, so the result is
 * narrowed to those two fields.
 */

import type { PublicClient } from 'viem';
import { speculationModuleAbi } from '../contracts/abi/index.js';
import { OspexChainError } from '../errors.js';
import { mapWinSide } from './settle.js';
import type { SettleResult } from './settle.js';
import type { Hex } from '../types/signer.js';

export interface SpeculationState {
  /** `'closed'` ⇔ on-chain `SpeculationStatus.Closed` (settled, claimable). */
  status: 'open' | 'closed';
  /** Resolved winning side; `'tbd'` until settled. */
  winSide: SettleResult['winSide'];
}

// On-chain `SpeculationStatus` enum (OspexTypes.sol): Open = 0, Closed = 1.
const SPECULATION_STATUS_CLOSED = 1;

export async function readSpeculationState(
  publicClient: PublicClient,
  speculationModule: Hex,
  speculationId: bigint,
): Promise<SpeculationState> {
  let spec: { speculationStatus: number; winSide: number };
  try {
    spec = (await publicClient.readContract({
      address: speculationModule,
      abi: speculationModuleAbi,
      functionName: 'getSpeculation',
      args: [speculationId],
    })) as { speculationStatus: number; winSide: number };
  } catch (err) {
    throw new OspexChainError(
      `Failed to read speculation ${speculationId} from SpeculationModule.`,
      { cause: err },
    );
  }
  return {
    status: spec.speculationStatus === SPECULATION_STATUS_CLOSED ? 'closed' : 'open',
    winSide: mapWinSide(spec.winSide),
  };
}
