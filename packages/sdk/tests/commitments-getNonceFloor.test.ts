/**
 * `client.commitments.getNonceFloor(args)` — reads MatchingModule.s_minNonces
 * for one speculation. Pins the arg validation and, critically, the recovery
 * invariant: like the other nonce-floor / cancel paths it uses the int32-only
 * `validateLineTicks`, NOT the create/fill magnitude guard, so a maker can read
 * the floor on an already-poisoned key while neutralizing it on-chain.
 */

import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { getNonceFloor } from '../src/commitments/getNonceFloor.js';
import { MAX_LINE_TICKS } from '../src/commitments/validation.js';
import { NonceCounter } from '../src/commitments/context.js';
import { OspexValidationError } from '../src/errors.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { Hex } from '../src/types/signer.js';

const MAKER = ('0x' + 'aa'.repeat(20)) as Hex;
const SCORER = ('0x' + 'dd'.repeat(20)) as Hex;

function fakeContext(floor: bigint): CommitmentsContext {
  const publicClient = {
    readContract: async () => floor,
  } as unknown as PublicClient;
  return {
    api: {} as CommitmentsContext['api'],
    getChainId: () => 137,
    getAddresses: () =>
      ({ matchingModule: ('0x' + '11'.repeat(20)) as Hex }) as unknown as ReturnType<
        CommitmentsContext['getAddresses']
      >,
    requireChainClient: () => publicClient,
    nonceCounter: new NonceCounter(),
  } as unknown as CommitmentsContext;
}

describe('commitments.getNonceFloor', () => {
  const baseArgs = { maker: MAKER, contestId: 42n, scorer: SCORER, lineTicks: -35 };

  it('reads the on-chain floor for a valid speculation', async () => {
    const floor = await getNonceFloor(fakeContext(1_700_000_000n), baseArgs);
    expect(floor).toBe(1_700_000_000n);
  });

  it('rejects an invalid scorer address before any RPC call', async () => {
    await expect(
      getNonceFloor(fakeContext(0n), { ...baseArgs, scorer: '0xnope' as Hex }),
    ).rejects.toBeInstanceOf(OspexValidationError);
  });

  it('rejects a non-int32 lineTicks', async () => {
    await expect(
      getNonceFloor(fakeContext(0n), { ...baseArgs, lineTicks: 2_147_483_648 }),
    ).rejects.toBeInstanceOf(OspexValidationError);
  });

  it('ACCEPTS an out-of-magnitude lineTicks (recovery must reach any int32 key)', async () => {
    // Reading the floor on a poisoned key is how a maker confirms their
    // neutralizing raiseMinNonce landed. Uses int32-only validateLineTicks, not
    // the create/fill magnitude guard — so it must reach the on-chain read, not
    // reject. Pins the call site against a future swap to
    // validateCommitmentLineTicks.
    const floor = await getNonceFloor(fakeContext(5n), {
      ...baseArgs,
      lineTicks: MAX_LINE_TICKS + 1,
    });
    expect(floor).toBe(5n);
  });
});
