/**
 * On-chain cancel primitives.
 *
 * Two entry points:
 *
 *   1. `cancelOnchainSigned(payload)` — canonical low-level primitive.
 *      Takes a {@link SignedCommitmentPayload} (the three pieces a third
 *      party needs: commitmentHash, the 9-field struct that hashes back to
 *      it, and the maker's signature). Calls
 *      `MatchingModule.cancelCommitment(commitment)` on chain. This is the
 *      MM-aligned shape: a market maker holding signed payloads in local
 *      state can cancel without ever hitting the API — load-bearing once
 *      book-hide is in play, because the public commitments path redacts
 *      the matchable payload for hidden rows.
 *
 *   2. `cancelOnchain({ hash } | { signedCommitment })` — convenience
 *      overload. The signedCommitment branch is a thin pass-through to
 *      `cancelOnchainSigned`. The hash branch fetches via
 *      `CommitmentsApi.get` → `toCommitment` → `requireVisibleCommitment`
 *      (M5/PR1 narrow: throws structured before any signer / RPC / gas
 *      access if the row is redacted), reconstructs the
 *      SignedCommitmentPayload from the visible row, then delegates to
 *      `cancelOnchainSigned`. Anonymous callers default to this branch;
 *      makers / MMs holding the signed payload should prefer the
 *      signedCommitment branch (one round-trip cheaper, no dependency on
 *      `book_visible`).
 *
 * Authoritative semantics are the same as before: once
 * `s_cancelledCommitments[hash]` is set, `matchCommitment` reverts with
 * `MatchingModule__CommitmentCancelled` (MatchingModule.sol:490). The
 * off-chain DELETE only stops the API relay from rebroadcasting — it
 * does NOT prevent a taker who already holds the signed payload from
 * matching the commitment.
 *
 * **Reconstruct-and-assert is non-negotiable.** The contract recomputes
 * the hash from the struct and sets `s_cancelledCommitments[recomputed]`
 * BLINDLY. If the stored row ever drifts from the signed payload (an
 * `expiry` that doesn't round-trip to the exact unix second, a corrupted
 * scorer address), an unguarded cancel would mark a DIFFERENT hash
 * cancelled while the real commitment stays matchable — and a maker bot
 * would release its headroom on a phantom cancel. Both entry points
 * route through the same `assertReconstructHash` gate.
 *
 * Idempotency note: the contract has NO `AlreadyCancelled` revert path.
 * Calling either primitive on a hash that is already cancelled succeeds
 * — it rewrites `s_cancelledCommitments[hash] = true` and re-emits the
 * `CommitmentCancelled` event. Do not infer "first cancel" from tx
 * success.
 */

import {
  encodeFunctionData,
  type Hash,
  type TransactionReceipt,
} from 'viem';
import { matchingModuleAbi } from '../contracts/abi/index.js';
import { OspexValidationError } from '../errors.js';
import { buildDomain, hashCommitment, type OspexCommitmentMessage } from '../chain/eip712.js';
import type { ChainId } from '../types/protocol.js';
import { buildSignAndSend } from './sendTx.js';
import { sendWithMatchingErrorClassification } from './matchingErrors.js';
import { requireVisibleCommitment } from './requireVisible.js';
import { CommitmentsApi } from '../api/commitments.js';
import { getOwnerCommitment } from '../ownState/getCommitment.js';
import type { CommitmentsContext } from './context.js';
import type {
  Commitment,
  PublicVisibleCommitment,
  SignedCommitmentPayload,
} from '../types/commitment.js';
import type { Hex } from '../types/signer.js';

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
// EIP-712 signature is `r || s || v` = 65 bytes = 130 hex chars after the prefix.
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface CancelOnchainResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  commitmentHash: Hex;
}

/**
 * `cancelOnchain({ hash } | { signedCommitment } | { commitment })` — the
 * convenience overload. Pick the branch by what you hold:
 *
 *   - `{ signedCommitment }` — you already hold the maker-signed payload
 *     (one round-trip cheaper; works against book-hidden rows; no API hit).
 *   - `{ commitment }` — you already fetched the public row (e.g. via
 *     `resolveByPrefix`); the SDK reconstructs the struct from it WITHOUT a
 *     second `/v1/commitments/:hash` round-trip. This is the branch the CLI
 *     dual `cancel --also-onchain` uses for its on-chain leg, so it never
 *     re-fetches a row its own off-chain DELETE just hid (book_visible=false)
 *     and then chokes on the redacted body.
 *   - `{ hash }` — you only have the EIP-712 hash; the SDK fetches via the
 *     public commitments API and narrows redaction.
 *
 * **`recoverHidden` (hash / commitment branches only).** A book-hidden row
 * (`book_visible=false`) redacts the matchable struct from anonymous reads,
 * so the default behavior on a redacted body is to refuse with structured
 * guidance (the historical contract). Pass `recoverHidden: true` to instead
 * recover the maker's signed payload via the owner-auth own-state surface
 * (`getCommitment`) and proceed — the signer MUST own the commitment (the
 * snapshot is scoped to the signer's address). This is the authoritative
 * recovery path for cancelling a commitment the maker took off the public
 * book. It mints one stream-auth token and pages the owner-auth snapshot.
 *
 * The branches are mutually exclusive — passing more than one throws
 * `OspexValidationError`. Passing none throws too (defensive — the type
 * system already requires one).
 */
export type CancelOnchainArgs =
  | { hash: Hex; recoverHidden?: boolean; signedCommitment?: undefined; commitment?: undefined }
  | {
      signedCommitment: SignedCommitmentPayload;
      hash?: undefined;
      commitment?: undefined;
      recoverHidden?: undefined;
    }
  | { commitment: Commitment; recoverHidden?: boolean; hash?: undefined; signedCommitment?: undefined };

export async function cancelOnchain(
  ctx: CommitmentsContext,
  args: CancelOnchainArgs,
): Promise<CancelOnchainResult> {
  const { hash, signedCommitment, commitment } = args;
  const provided = [hash, signedCommitment, commitment].filter((v) => v !== undefined).length;
  if (provided > 1) {
    throw new OspexValidationError(
      'cancelOnchain: pass exactly one of { hash }, { signedCommitment }, or { commitment }.',
      { field: 'hash' },
    );
  }
  if (provided === 0) {
    throw new OspexValidationError(
      'cancelOnchain: one of { hash }, { signedCommitment }, or { commitment } is required.',
      { field: 'hash' },
    );
  }

  if (signedCommitment !== undefined) {
    return cancelOnchainSigned(ctx, signedCommitment);
  }

  // `recoverHidden` opt-in applies to the hash + commitment branches: a
  // redacted (book-hidden) row → owner-auth own-state recovery. Defaults
  // false so the historical "refuse a redacted row" contract is preserved
  // unless a caller explicitly opts into the heavier owner-auth path.
  const recoverHidden = args.recoverHidden === true;

  if (commitment !== undefined) {
    return cancelFromCommitment(ctx, commitment, recoverHidden);
  }

  // hash branch — fetch via decoder so the M2 wire `redacted` discriminant
  // is decoded, then route exactly like the commitment branch.
  if (!HASH_PATTERN.test(hash as Hex)) {
    throw new OspexValidationError(
      'cancelOnchain hash must be a 0x-prefixed 32-byte hex string.',
      { field: 'hash' },
    );
  }
  const lowercaseHash = (hash as Hex).toLowerCase() as Hex;
  const fetched = await new CommitmentsApi(ctx.api).get(lowercaseHash);
  return cancelFromCommitment(ctx, fetched, recoverHidden);
}

/**
 * Route an already-decoded public {@link Commitment} to the on-chain cancel:
 *
 *   - visible row → reconstruct the struct ({@link buildPayloadFromVisible})
 *     and cancel via {@link cancelOnchainSigned};
 *   - redacted (book-hidden) row → recover via owner-auth own-state when
 *     `recoverHidden` is set, otherwise refuse via
 *     {@link requireVisibleCommitment} BEFORE any signer / chain access (the
 *     historical contract — a hidden body has no signature / nonce / oddsTick
 *     / riskAmount / scorer / lineTicks, so letting it through would hit a
 *     `BigInt(undefined)` TypeError and waste a Foundry-passphrase decrypt).
 */
async function cancelFromCommitment(
  ctx: CommitmentsContext,
  commitment: Commitment,
  recoverHidden: boolean,
): Promise<CancelOnchainResult> {
  if (commitment.redacted === false) {
    const payload = buildPayloadFromVisible(
      commitment,
      commitment.commitmentHash.toLowerCase() as Hex,
    );
    return cancelOnchainSigned(ctx, payload);
  }
  // Book-hidden (redacted) row.
  if (!recoverHidden) {
    // Refuse with the structured owner-auth guidance — `requireVisibleCommitment`
    // throws `OspexValidationError({ field: 'commitment' })` on a redacted row
    // BEFORE any signer / RPC / gas access.
    requireVisibleCommitment(commitment, { purpose: 'cancel on chain' });
  }
  return recoverHiddenCommitmentAndCancel(
    ctx,
    commitment.commitmentHash.toLowerCase() as Hex,
  );
}

/**
 * Owner-auth recovery for a book-hidden commitment: page the maker's
 * owner-auth own-state snapshot for the signed payload, then cancel on chain
 * via {@link cancelOnchainSigned}. Used when the public body is redacted (the
 * maker took the row off the public book) and the caller opted into recovery
 * (`recoverHidden: true`).
 *
 * The snapshot is scoped to the configured signer's address, so a signer that
 * does NOT own the commitment simply won't find the hash — surfaced as a clear
 * error pointing at the nonce-floor lever (the only payload-free authoritative
 * cancel). `getOwnerCommitment` mints exactly one stream-auth token and throws
 * `OspexOwnStateError({ reason: 'scan_limit_exceeded' })` on an indeterminate
 * (still-truncated) scan — propagated unchanged so an UNKNOWN is never silently
 * treated as "not found".
 */
async function recoverHiddenCommitmentAndCancel(
  ctx: CommitmentsContext,
  lowercaseHash: Hex,
): Promise<CancelOnchainResult> {
  const signer = ctx.requireSigner();
  const address = ((await signer.getAddress()) as string).toLowerCase() as Hex;
  const { matchingModule } = ctx.getAddresses();
  const chainId = ctx.getChainId();
  const owner = await getOwnerCommitment({
    api: ctx.api,
    signer,
    address,
    chainId,
    matchingModule: matchingModule as Hex,
    hash: lowercaseHash,
  });
  if (owner === null) {
    throw new OspexValidationError(
      `cancelOnchain: book-hidden commitment ${lowercaseHash} was not found in your owner-auth ` +
        'own-state snapshot scope. Only the maker can recover a hidden commitment’s signed ' +
        'payload; if you are the maker and the row is outside snapshot scope, invalidate it with ' +
        'the nonce-floor lever instead (cancelAllOnSpeculation).',
      { field: 'hash' },
    );
  }
  if (owner.signedPayload === null) {
    throw new OspexValidationError(
      `cancelOnchain: book-hidden commitment ${lowercaseHash} has no signed payload (a ` +
        'signature-less indexer-discovered row); its cancel struct cannot be reconstructed. ' +
        'Invalidate it with the nonce-floor lever instead (cancelAllOnSpeculation).',
      { field: 'signedPayload' },
    );
  }
  return cancelOnchainSigned(ctx, owner.signedPayload);
}

/**
 * `cancelOnchainSigned(payload)` — canonical low-level primitive. Validates
 * the payload shape, asserts hash↔struct round-trip, and broadcasts
 * `MatchingModule.cancelCommitment(commitment)`.
 *
 * Skips ALL public-commitments-API access — the maker / MM caller already
 * holds the signed payload. That's the load-bearing path for book-hidden
 * commitments: the anonymous public read returns a redacted body that
 * cannot reconstruct the cancel struct, but the maker's local state
 * (M6 `MakerCommitmentRecord.signedPayload`) can.
 */
export async function cancelOnchainSigned(
  ctx: CommitmentsContext,
  payload: SignedCommitmentPayload,
): Promise<CancelOnchainResult> {
  validateSignedPayload(payload);
  const lowercaseHash = payload.commitmentHash.toLowerCase() as Hex;

  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const { matchingModule } = ctx.getAddresses();
  const chainId = ctx.getChainId();

  // Assert the struct round-trips to the requested hash BEFORE signing or
  // broadcasting. The contract recomputes the hash from the struct
  // blindly (MatchingModule.sol). An unguarded cancel on a drifted struct
  // would mark a DIFFERENT hash cancelled while the real commitment
  // stays matchable. Both hashes are public; the message carries no
  // secrets.
  assertReconstructHash(payload.commitment, lowercaseHash, chainId, matchingModule as Hex);

  const data = encodeFunctionData({
    abi: matchingModuleAbi,
    functionName: 'cancelCommitment',
    args: [payload.commitment],
  });

  const { txHash, receipt } = await sendWithMatchingErrorClassification(
    'cancelCommitment',
    () =>
      buildSignAndSend({
        publicClient,
        signer,
        chainId,
        to: matchingModule,
        data,
      }),
  );

  return { txHash, receipt, commitmentHash: lowercaseHash };
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Reconstruct the 9-field EIP-712 struct from a {@link PublicVisibleCommitment}.
 * Indexer-only rows can have nulls in fields the contract requires — those
 * fail fast with a clear error rather than hitting a silent revert / BigInt
 * NaN further down the pipeline.
 */
function buildPayloadFromVisible(
  visible: PublicVisibleCommitment,
  lowercaseHash: Hex,
): SignedCommitmentPayload {
  const required = (
    [
      'contestId',
      'scorer',
      'lineTicks',
      'positionType',
      'oddsTick',
      'expiry',
    ] as const
  ).filter((k) => visible[k] === null);
  if (required.length > 0) {
    const first = required[0];
    throw new OspexValidationError(
      `Commitment ${lowercaseHash} is missing fields needed to reconstruct the struct: ${required.join(
        ', ',
      )}.`,
      first !== undefined ? { field: first } : undefined,
    );
  }
  if (visible.signature === null) {
    throw new OspexValidationError(
      `Commitment ${lowercaseHash} has no signature field; the row is not reconstructable into the EIP-712 struct.`,
      { field: 'signature' },
    );
  }

  const commitment: OspexCommitmentMessage = {
    maker: visible.maker as Hex,
    contestId: BigInt(visible.contestId as string),
    scorer: visible.scorer as Hex,
    lineTicks: visible.lineTicks as number,
    positionType: visible.positionType as 0 | 1,
    oddsTick: visible.oddsTick as number,
    riskAmount: BigInt(visible.riskAmount),
    nonce: BigInt(visible.nonce),
    expiry: BigInt(Math.floor(new Date(visible.expiry as string).getTime() / 1000)),
  };
  return {
    commitmentHash: lowercaseHash,
    commitment,
    signature: visible.signature as Hex,
  };
}

/**
 * Shape-only validation of a caller-supplied {@link SignedCommitmentPayload}.
 * `cancelOnchainSigned` is a public surface; a malformed payload from a
 * dynamic caller must surface as `OspexValidationError({ field })` rather
 * than a downstream TypeError or contract revert. Hash↔struct round-trip is
 * validated separately by `assertReconstructHash` (it needs the chain
 * domain, which validation alone doesn't have).
 */
function validateSignedPayload(payload: SignedCommitmentPayload): void {
  if (payload === null || typeof payload !== 'object') {
    throw new OspexValidationError(
      'cancelOnchainSigned payload must be a SignedCommitmentPayload object.',
      { field: 'signedCommitment' },
    );
  }
  if (typeof payload.commitmentHash !== 'string' || !HASH_PATTERN.test(payload.commitmentHash)) {
    throw new OspexValidationError(
      'cancelOnchainSigned commitmentHash must be a 0x-prefixed 32-byte hex string.',
      { field: 'commitmentHash' },
    );
  }
  if (typeof payload.signature !== 'string' || !SIGNATURE_PATTERN.test(payload.signature)) {
    throw new OspexValidationError(
      'cancelOnchainSigned signature must be a 0x-prefixed 65-byte hex string (r || s || v).',
      { field: 'signature' },
    );
  }
  const c = payload.commitment;
  if (c === null || typeof c !== 'object') {
    throw new OspexValidationError(
      'cancelOnchainSigned commitment must be a 9-field OspexCommitmentMessage struct.',
      { field: 'commitment' },
    );
  }
  if (typeof c.maker !== 'string' || !ADDRESS_PATTERN.test(c.maker)) {
    throw new OspexValidationError(
      'cancelOnchainSigned commitment.maker must be a 0x-prefixed 20-byte address.',
      { field: 'maker' },
    );
  }
  if (typeof c.scorer !== 'string' || !ADDRESS_PATTERN.test(c.scorer)) {
    throw new OspexValidationError(
      'cancelOnchainSigned commitment.scorer must be a 0x-prefixed 20-byte address.',
      { field: 'scorer' },
    );
  }
  // BigInt + number fields — narrow the shape but trust the values; the
  // hash assertion catches struct-level drift downstream.
  for (const k of ['contestId', 'riskAmount', 'nonce', 'expiry'] as const) {
    if (typeof c[k] !== 'bigint') {
      throw new OspexValidationError(
        `cancelOnchainSigned commitment.${k} must be a bigint.`,
        { field: k },
      );
    }
  }
  for (const k of ['lineTicks', 'positionType', 'oddsTick'] as const) {
    if (typeof c[k] !== 'number' || !Number.isFinite(c[k])) {
      throw new OspexValidationError(
        `cancelOnchainSigned commitment.${k} must be a finite number.`,
        { field: k },
      );
    }
  }
}

/**
 * Reconstruct the EIP-712 hash from the struct under the configured chain's
 * MatchingModule domain and assert it matches the requested `commitmentHash`.
 * Routed through {@link hashCommitment} so the algorithm matches what the
 * contract's `getCommitmentHash` returns. Mismatch is a hard-fail BEFORE
 * any tx is built — see file-level header for the rationale.
 */
function assertReconstructHash(
  commitment: OspexCommitmentMessage,
  lowercaseHash: Hex,
  chainId: ChainId,
  matchingModule: Hex,
): void {
  const reconstructed = hashCommitment(buildDomain(chainId, matchingModule), commitment);
  if (reconstructed.toLowerCase() !== lowercaseHash) {
    throw new OspexValidationError(
      `cancelOnchain: the provided commitment struct hashes to ${reconstructed}, ` +
        `which does not match commitmentHash ${lowercaseHash}. Refusing to cancel a different commitment.`,
      { field: 'commitmentHash' },
    );
  }
}
