/**
 * REST surface for the M3 owner-auth handshake (own-state SSE plan §3.1):
 *
 *   POST /v1/auth/stream-challenge  {address}      → {challenge, expiresAt}
 *   POST /v1/auth/stream-token      {challenge, signature} → {token, expiresAt}
 *
 * This module is the thin wire wrapper — challenge/sign/exchange
 * composition lives one layer up in `ownState/auth.ts:mintStreamToken`,
 * which calls these two methods around a `Signer.signTypedData`. Keeping
 * the wire and the composition split mirrors how `commitments`, `contests`,
 * etc. layer (`api/*.ts` = wire; sibling module = orchestrator).
 *
 * Errors surface as `OspexAPIError` with the server's
 * `code` (`AUTH_*`) intact so callers can switch on it without parsing the
 * message. The signature itself is the only secret the caller hands over;
 * the token comes back in the response body and MUST NOT be logged at any
 * layer downstream — own-state subscribers are sole keepers (the bearer
 * format mirrors a stripped JWT and is replayable until `expiresAt`).
 */

import { OspexValidationError } from '../errors.js';
import type { Hex } from '../types/signer.js';
import type { ApiClient } from './client.js';
import type {
  StreamChallenge,
  StreamChallengeResponseBody,
  StreamTokenResponseBody,
} from './types.js';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export class StreamAuthApi {
  constructor(private readonly client: ApiClient) {}

  /**
   * Mint a fresh EIP-712 challenge for the maker address. The server
   * records `challengeId` + `address` + `issuedAt` + `expiresAt` for
   * single-use consume at token-exchange time, so a challenge cannot
   * be re-used after mint nor re-targeted to a different address.
   */
  async requestChallenge(address: Hex | string): Promise<StreamChallengeResponseBody> {
    if (typeof address !== 'string' || !ADDRESS_PATTERN.test(address)) {
      throw new OspexValidationError(
        'address must be a 0x-prefixed 20-byte hex string.',
        { field: 'address' },
      );
    }
    return this.client.request<StreamChallengeResponseBody>(
      '/v1/auth/stream-challenge',
      {
        method: 'POST',
        body: { address: address.toLowerCase() },
      },
    );
  }

  /**
   * Trade a signed challenge for a short-lived bearer token. The
   * server verifies the EIP-712 signature recovers to `challenge.address`,
   * confirms the challenge fields match what it minted (any drift in
   * `issuedAt` / `expiresAt` / `challengeId` returns `AUTH_CHALLENGE_TAMPERED`),
   * and single-use-consumes the challenge before issuing the token.
   *
   * Pass the WHOLE challenge object verbatim — re-emitting it from a
   * locally reshaped copy risks a tampered-rejection if any field
   * (e.g. number formatting through `JSON.parse`/`JSON.stringify`)
   * doesn't round-trip identically. The `StreamChallenge` wire shape
   * uses `number` for the uint256 fields specifically so this
   * round-trip is value-equal.
   */
  async exchangeToken(
    challenge: StreamChallenge,
    signature: Hex,
  ): Promise<StreamTokenResponseBody> {
    if (typeof signature !== 'string' || !signature.startsWith('0x')) {
      throw new OspexValidationError(
        'signature must be a 0x-prefixed hex string.',
        { field: 'signature' },
      );
    }
    return this.client.request<StreamTokenResponseBody>('/v1/auth/stream-token', {
      method: 'POST',
      body: { challenge, signature },
    });
  }
}
