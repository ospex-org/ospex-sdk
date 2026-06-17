/**
 * `commitments.submitPrepared(preview)` — sign exactly `preview.raw`
 * and POST to `/v1/commitments`. Companion to `prepareSubmit`.
 *
 * Trust-model contract:
 *   - Signs the EIP-712 OspexCommitment built from `preview.raw`,
 *     verbatim. Does NOT silently change nonce / expiry / any tuple
 *     field. The caller's preview readback is what gets bound.
 *   - On `NONCE_TOO_LOW` from the API (concurrent maker activity
 *     between prepare and submit), surfaces the underlying
 *     `OspexAPIError` so the caller can re-run `prepareSubmit` and
 *     re-confirm. We do NOT silently retry with a fresh nonce here —
 *     that would change the message the user previously confirmed.
 *   - Verifies `preview.raw.chainId` and `preview.raw.verifyingContract`
 *     match this client's configuration. A mismatch means the preview
 *     was prepared on a different client; refuses to sign.
 *
 * The split between `prepareSubmit` (resolution + I/O) and
 * `submitPrepared` (signing only) exists so the CLI can render a
 * confirmation prompt between them.
 */

import {
  buildDomain,
  deriveSpeculationKey,
  hashCommitment,
  OSPEX_COMMITMENT_TYPES,
  type OspexCommitmentMessage,
} from '../chain/eip712.js';
import { toCommitment } from '../api/commitments.js';
import { requireVisibleCommitment } from './requireVisible.js';
import { validateCommitmentLineTicks } from './validation.js';
import { OspexValidationError } from '../errors.js';
import type { CommitmentsContext } from './context.js';
import type { SubmitPreview } from '../types/preview.js';
import { withCommitmentHash, type SubmitResult } from './submitRaw.js';
import type { CommitmentBody } from '../api/types.js';
import type { Hex } from '../types/signer.js';

export async function submitPrepared(
  ctx: CommitmentsContext,
  preview: SubmitPreview,
): Promise<SubmitResult> {
  const chainId = ctx.getChainId();
  const { matchingModule } = ctx.getAddresses();

  // Sanity: preview must match this client's chain context.
  if (preview.raw.chainId !== chainId) {
    throw new OspexValidationError(
      `Preview was prepared for chainId ${preview.raw.chainId}, but this client is configured for chainId ${chainId}. ` +
        'Re-run prepareSubmit on a client bound to the correct chain.',
    );
  }
  if (preview.raw.verifyingContract.toLowerCase() !== matchingModule.toLowerCase()) {
    throw new OspexValidationError(
      `Preview verifyingContract (${preview.raw.verifyingContract}) does not match this client's MatchingModule (${matchingModule}). ` +
        'Re-run prepareSubmit; the addresses module may have been refreshed.',
    );
  }

  const signer = ctx.requireSigner();
  const message: OspexCommitmentMessage = {
    maker: preview.raw.maker as Hex,
    contestId: BigInt(preview.raw.contestId),
    scorer: preview.raw.scorer as Hex,
    lineTicks: preview.raw.lineTicks,
    positionType: preview.raw.positionType,
    oddsTick: preview.raw.oddsTick,
    riskAmount: BigInt(preview.raw.riskAmount),
    nonce: BigInt(preview.raw.nonce),
    expiry: BigInt(preview.raw.expiry),
  };

  // Defense-in-depth: refuse to sign a preview whose line is out of the
  // protocol magnitude bound, even if it was hand-built (bypassing
  // prepareSubmit's chokepoint) or had its lineTicks edited to a value that
  // happens to carry a matching speculationKey. An out-of-range line overflows
  // the spread scorer and would permanently lock both sides' escrow. Mirrors
  // the matchFromPreview backstop on the fill side. See validation.ts
  // MAX_LINE_TICKS.
  validateCommitmentLineTicks(message.lineTicks);

  // Defense-in-depth: re-derive the speculationKey from the same tuple
  // we're about to sign and cross-check `preview.raw.speculationKey`.
  // A mismatch means the preview was tampered with after `prepareSubmit`
  // canonicalized it — refuse to sign rather than trust either value.
  // Catches contestId / scorer / lineTicks edits that didn't update
  // the bundled key.
  const expectedKey = deriveSpeculationKey(
    message.contestId,
    message.scorer,
    message.lineTicks,
  );
  if (expectedKey.toLowerCase() !== preview.raw.speculationKey.toLowerCase()) {
    throw new OspexValidationError(
      `preview.raw.speculationKey (${preview.raw.speculationKey}) does not match the canonical derivation ` +
        `from (contestId=${message.contestId}, scorer=${message.scorer}, lineTicks=${message.lineTicks}). ` +
        'The preview may have been tampered with — re-run prepareSubmit.',
    );
  }

  const domain = buildDomain(chainId, matchingModule as Hex);
  const signature = await signer.signTypedData({
    domain,
    types: { ...OSPEX_COMMITMENT_TYPES },
    primaryType: 'OspexCommitment',
    message: { ...message },
  });
  const hash = hashCommitment(domain, message);

  // Update the per-instance nonce counter so subsequent in-process
  // submits at the same speculationKey advance past this nonce even
  // before the chain registers it.
  const speculationKey = preview.raw.speculationKey as Hex;
  ctx.nonceCounter.observe(message.maker.toLowerCase(), speculationKey.toLowerCase(), message.nonce);

  let body: CommitmentBody;
  try {
    body = await ctx.api.request<CommitmentBody>('/v1/commitments', {
      method: 'POST',
      headers: { 'Idempotency-Key': hash },
      body: {
        action: {
          type: 'OspexCommitment',
          maker: message.maker,
          contestId: message.contestId.toString(),
          scorer: message.scorer,
          lineTicks: message.lineTicks,
          positionType: message.positionType,
          oddsTick: message.oddsTick,
          riskAmount: message.riskAmount.toString(),
          nonce: message.nonce.toString(),
          expiry: message.expiry.toString(),
        },
        signature,
      },
    });
  } catch (err) {
    // Attach the locally-computed hash so an ambiguous POST failure (the
    // response lost after a maybe-insert) carries the handle to the maybe-live
    // commitment — the caller can probe (`commitments show <hash>` / own-state)
    // before retrying instead of blindly re-submitting (a fresh submit signs a
    // new nonce → new hash → server dedup misses → doubled exposure). See
    // AGENT_CONTRACT §7 retry carve-out.
    throw withCommitmentHash(err, hash);
  }
  // Submission inserts `book_visible=true` by construction; the server
  // response must decode visible. See submitRaw.ts for the same defensive narrow.
  const commitment = requireVisibleCommitment(toCommitment(body), {
    purpose: 'persist the newly-submitted',
  });
  return {
    hash,
    commitment,
    signedPayload: { commitmentHash: hash, commitment: message, signature },
  };
}
