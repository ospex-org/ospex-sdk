/**
 * `commitments.cancel(hash)` — off-chain cancel via signed
 * CancelCommitment action and DELETE /v1/commitments/:hash. The
 * authoritative cancel is on-chain (MatchingModule.cancelCommitment /
 * raiseMinNonce), but the off-chain DELETE removes the row from the
 * open book so takers stop seeing it. Idempotent server-side.
 *
 * The signature expiry is short (now + 5 min). The API caps it at 1h;
 * a tighter cap means a signature dropped on the floor doesn't sit
 * around as a replay token.
 */

import { buildDomain, CANCEL_COMMITMENT_TYPES } from '../chain/eip712.js';
import type { CommitmentsContext } from './context.js';
import type { Hex } from '../types/signer.js';
import { OspexValidationError } from '../errors.js';
import { nowUnixSec } from './validation.js';

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const CANCEL_EXPIRY_OFFSET_SEC = 5n * 60n;

export interface CancelResult {
  ok: true;
}

export async function cancel(ctx: CommitmentsContext, hash: Hex): Promise<CancelResult> {
  if (!HASH_PATTERN.test(hash)) {
    throw new OspexValidationError(
      'cancel hash must be a 0x-prefixed 32-byte hex string.',
      { field: 'hash' },
    );
  }
  const lowercaseHash = hash.toLowerCase() as Hex;

  const signer = ctx.requireSigner();
  const chainId = ctx.getChainId();
  const { matchingModule } = ctx.getAddresses();
  const expiry = nowUnixSec() + CANCEL_EXPIRY_OFFSET_SEC;
  const domain = buildDomain(chainId, matchingModule);

  const message = { commitmentHash: lowercaseHash, expiry };
  const signature = await signer.signTypedData({
    domain,
    types: { ...CANCEL_COMMITMENT_TYPES },
    primaryType: 'CancelCommitment',
    message: { ...message },
  });

  await ctx.api.request<unknown>(`/v1/commitments/${lowercaseHash}`, {
    method: 'DELETE',
    body: {
      action: {
        type: 'CancelCommitment',
        commitmentHash: lowercaseHash,
        expiry: expiry.toString(),
      },
      signature,
    },
  });

  return { ok: true };
}
