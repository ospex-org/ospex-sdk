/**
 * `commitments.getNonceFloor({ maker, contestId, scorer, lineTicks })` —
 * read the maker's current minimum nonce for one speculation directly
 * from `MatchingModule.s_minNonces`. The contract is the canonical
 * authority; the Supabase mirror (`maker_nonce_floors`) is a derivative
 * that may lag the chain by 5–20s.
 *
 * Returns 0n when the maker has never raised the floor for this
 * speculation (the storage default). Consumers can treat 0n as
 * "no floor set yet" without a separate sentinel.
 */

import { OspexValidationError } from '../errors.js';
import { deriveSpeculationKey } from '../chain/eip712.js';
import { readNonceFloor } from './nonce.js';
import { validateLineTicks } from './validation.js';
import type { CommitmentsContext } from './context.js';
import type { Hex } from '../types/signer.js';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface GetNonceFloorArgs {
  maker: Hex;
  contestId: bigint;
  scorer: Hex;
  lineTicks: number;
}

export async function getNonceFloor(
  ctx: CommitmentsContext,
  args: GetNonceFloorArgs,
): Promise<bigint> {
  if (!ADDRESS_PATTERN.test(args.maker)) {
    throw new OspexValidationError('maker must be a 0x-prefixed 20-byte address.', { field: 'maker' });
  }
  if (!ADDRESS_PATTERN.test(args.scorer)) {
    throw new OspexValidationError('scorer must be a 0x-prefixed 20-byte address.', { field: 'scorer' });
  }
  if (args.contestId < 0n) {
    throw new OspexValidationError('contestId must be non-negative.', { field: 'contestId' });
  }
  validateLineTicks(args.lineTicks);

  const publicClient = ctx.requireChainClient();
  const { matchingModule } = ctx.getAddresses();
  const maker = args.maker.toLowerCase() as Hex;
  const scorer = args.scorer.toLowerCase() as Hex;
  const speculationKey = deriveSpeculationKey(args.contestId, scorer, args.lineTicks);
  return readNonceFloor(publicClient, matchingModule, maker, speculationKey);
}
