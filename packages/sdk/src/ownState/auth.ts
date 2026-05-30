/**
 * Owner-auth foundation for `client.ownState.*` (M5/PR3a). Composes
 * `api/streamAuth.ts` (challenge/token wire) with a `Signer` to produce
 * a short-lived bearer token bound to a maker `(address, resource:
 * 'own-state', network)`.
 *
 * Token mint flow (own-state SSE plan §3.1):
 *
 *   1. POST /v1/auth/stream-challenge {address}        → {challenge, expiresAt}
 *   2. SDK BigInt-coerces the wire challenge into the EIP-712 message shape.
 *   3. signer.signTypedData(OspexStreamAuth, message)  → signature
 *   4. POST /v1/auth/stream-token {challenge, signature} → {token, expiresAt}
 *
 * The challenge wire body is forwarded verbatim on step 4 — any reshape
 * risks a tampered-rejection at the server's strict `(issuedAt, expiresAt,
 * challengeId)` round-trip check (per `[[feedback_bind_minted_fields_on_resubmit]]`).
 *
 * Defensive binds before signing:
 *
 *   - `challenge.address === args.address`      — server returned a challenge
 *     for the wallet we requested; refuses to sign for someone else.
 *   - `challenge.resource === 'own-state'`      — single-resource SDK; refuses
 *     a future expansion the SDK didn't opt into.
 *   - `challenge.scope === 'read:own-state'`    — read-only scope; signing a
 *     wider scope would broaden the bearer's authority post-mint.
 *   - `challenge.network.chainId === args.chainId` — refuses a cross-network
 *     challenge that would later fail token-exchange anyway, but cheaper.
 *
 * Token refresh: this PR3a primitive is one-shot; the PR3c subscribe
 * surface owns the proactive-refresh state machine. Single-shot callers
 * (PR3b snapshot, PR3b getCommitment) mint once and discard.
 */

import { OspexValidationError } from '../errors.js';
import type { ApiClient } from '../api/client.js';
import { StreamAuthApi } from '../api/streamAuth.js';
import {
  STREAM_AUTH_TYPES,
  buildStreamAuthDomain,
  type StreamChallengeMessage,
} from '../chain/eip712.js';
import type { ChainId } from '../types/protocol.js';
import type { Hex, Signer } from '../types/signer.js';
import type { StreamChallenge } from '../api/types.js';

export interface MintStreamTokenArgs {
  api: ApiClient;
  signer: Signer;
  /**
   * Wallet address the token will be scoped to. Server-side recovery
   * asserts the signature's recovered signer equals this value; the SDK
   * also refuses to sign a challenge bound to a different address.
   */
  address: Hex;
  /** One client = one chain. */
  chainId: ChainId;
  /**
   * EIP-712 `verifyingContract` for the OspexStreamAuth domain. The
   * MatchingModule address per spec §3.2; the SDK pulls this from
   * `OspexClient` addresses and the caller does not pass it explicitly.
   */
  matchingModule: Hex;
}

/** Result of {@link mintStreamToken}. */
export interface StreamAuthToken {
  /** Opaque bearer token. Send as `Authorization: Bearer <token>`. */
  token: string;
  /**
   * Absolute unix-seconds expiry. Treat the token as stale before this —
   * the PR3c subscribe loop refreshes ~120 s ahead of `expiresAt`.
   */
  expiresAt: number;
  /** Address the token is scoped to (lowercase). */
  address: Hex;
  /** Server's challengeId for diagnostic correlation; never sensitive. */
  challengeId: string;
}

/**
 * Single-shot mint. Returns a fresh bearer token + expiry; throws
 * `OspexAPIError` on server rejection (`AUTH_*` codes intact),
 * `OspexValidationError` on a defective challenge from the server, and
 * `OspexSigningError` propagated from the signer. The decrypted-key path
 * never crosses this function — the signer owns it.
 */
export async function mintStreamToken(
  args: MintStreamTokenArgs,
): Promise<StreamAuthToken> {
  const api = new StreamAuthApi(args.api);
  const addressLower = args.address.toLowerCase() as Hex;

  const { challenge } = await api.requestChallenge(addressLower);

  assertChallengeBindsTo(challenge, addressLower, args.chainId);

  const domain = buildStreamAuthDomain(args.chainId, args.matchingModule);
  const message: StreamChallengeMessage = {
    address: challenge.address as Hex,
    resource: 'own-state',
    scope: 'read:own-state',
    network: { chainId: BigInt(challenge.network.chainId) },
    audience: challenge.audience,
    challengeId: challenge.challengeId,
    issuedAt: BigInt(challenge.issuedAt),
    expiresAt: BigInt(challenge.expiresAt),
  };

  const signature = await args.signer.signTypedData({
    domain,
    types: { ...STREAM_AUTH_TYPES },
    primaryType: 'OspexStreamAuth',
    message: { ...message },
  });

  const tokenRes = await api.exchangeToken(challenge, signature);

  return {
    token: tokenRes.token,
    expiresAt: tokenRes.expiresAt,
    address: challenge.address as Hex,
    challengeId: challenge.challengeId,
  };
}

/**
 * Refuse to sign a challenge that doesn't bind to the (address, network)
 * the caller asked for. Catches a misconfigured/malicious server before
 * the signer is touched.
 */
function assertChallengeBindsTo(
  challenge: StreamChallenge,
  expectedAddress: Hex,
  expectedChainId: ChainId,
): void {
  const wantAddress = expectedAddress.toLowerCase();
  if (
    typeof challenge.address !== 'string' ||
    challenge.address.toLowerCase() !== wantAddress
  ) {
    throw new OspexValidationError(
      `Stream-auth challenge address does not match requested wallet ` +
        `(got ${String(challenge.address)}, want ${wantAddress}).`,
      { field: 'challenge.address' },
    );
  }
  if (challenge.resource !== 'own-state') {
    throw new OspexValidationError(
      `Stream-auth challenge resource must be "own-state" ` +
        `(got ${String(challenge.resource)}).`,
      { field: 'challenge.resource' },
    );
  }
  if (challenge.scope !== 'read:own-state') {
    throw new OspexValidationError(
      `Stream-auth challenge scope must be "read:own-state" ` +
        `(got ${String(challenge.scope)}).`,
      { field: 'challenge.scope' },
    );
  }
  if (
    typeof challenge.network !== 'object' ||
    challenge.network === null ||
    typeof challenge.network.chainId !== 'number' ||
    challenge.network.chainId !== expectedChainId
  ) {
    throw new OspexValidationError(
      `Stream-auth challenge chainId does not match client chainId ` +
        `(got ${String(challenge.network?.chainId)}, want ${expectedChainId}).`,
      { field: 'challenge.network.chainId' },
    );
  }
  if (
    typeof challenge.audience !== 'string' ||
    challenge.audience.length === 0 ||
    typeof challenge.challengeId !== 'string' ||
    challenge.challengeId.length === 0 ||
    !Number.isSafeInteger(challenge.issuedAt) ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    challenge.expiresAt <= challenge.issuedAt
  ) {
    throw new OspexValidationError(
      'Stream-auth challenge is malformed (audience/challengeId/issuedAt/expiresAt invalid).',
      { field: 'challenge' },
    );
  }
}
