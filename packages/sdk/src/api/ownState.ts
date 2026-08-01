/**
 * REST surface for the owner-authenticated own-state endpoints (M4 +
 * own-state SSE plan §6). Currently:
 *
 *   GET /v1/own-state/snapshot?cursor=<opaque>     (Bearer-gated)
 *
 * PR3c will add the composite SSE consumer for `/v1/stream/own-state` —
 * it composes on top of `api/client.openStream` and reuses the bearer
 * token machinery from `ownState/auth.ts`, so the wire-token shape is
 * symmetric across REST and SSE.
 *
 * The bearer token is the only secret the caller hands over. Per spec
 * §3.4 the SDK + CLI use header auth (NOT query-string) so the token
 * doesn't leak into access logs / proxy state. Token minting lives in
 * `ownState/auth.ts:mintStreamToken`; this module just consumes a
 * pre-minted token.
 */

import { OspexValidationError } from '../errors.js';
import type { ApiClient } from './client.js';
import type { OwnerStateSnapshotBody, OwnStateHealthBody } from './types.js';

export interface OwnerStateSnapshotQuery {
  /**
   * Opaque cursor minted by an earlier snapshot response. Pass back to
   * page through a truncated snapshot. Pre-validated as a non-empty
   * string here — the server's own cursor validator covers the structural
   * shape (`INVALID_CURSOR` on a malformed value).
   */
  cursor?: string;
}

export class OwnStateApi {
  constructor(private readonly client: ApiClient) {}

  /**
   * Fetch a (possibly truncated) page of the maker's own-state snapshot.
   * The `token` is a bearer minted via the M3 challenge/token flow
   * (`ownState/auth.ts:mintStreamToken`); the server gates on
   * `verifyStreamToken` and attaches the resolved `address` from the
   * token's claims — so this endpoint takes NO `?address=` query (it
   * couldn't be honored without re-auth anyway).
   *
   * Errors:
   *   - 401 AUTH_TOKEN_EXPIRED / AUTH_TOKEN_INVALID — re-mint before retrying.
   *   - 400 INVALID_CURSOR / INVALID_PARAM           — caller bug; surface to user.
   *   - 503 NOT_READY                                — server stream-auth env not wired.
   *   - 500 INTERNAL_ERROR                           — server-side DB failure.
   */
  async snapshot(
    token: string,
    query: OwnerStateSnapshotQuery = {},
  ): Promise<OwnerStateSnapshotBody> {
    if (typeof token !== 'string' || token.length === 0) {
      throw new OspexValidationError(
        'snapshot token must be a non-empty string (mint via mintStreamToken).',
        { field: 'token' },
      );
    }
    if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length === 0)) {
      throw new OspexValidationError(
        'snapshot cursor must be a non-empty string when supplied.',
        { field: 'cursor' },
      );
    }
    const requestQuery: Record<string, string | number | boolean | undefined> = {};
    if (query.cursor !== undefined) requestQuery.cursor = query.cursor;
    return this.client.request<OwnerStateSnapshotBody>('/v1/own-state/snapshot', {
      method: 'GET',
      query: requestQuery,
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  /**
   * Fetch the PUBLIC indexer-lag probe (`GET /v1/health/own-state`, PR0b §3.3).
   * No bearer — indexer lag is a global, wallet-independent signal, so this
   * takes no token (and no `?address`). A market-maker polls it once per runner
   * tick (default 60s) and folds `indexerLagSeconds` into its stream-health
   * gate.
   */
  async health(): Promise<OwnStateHealthBody> {
    return this.client.request<OwnStateHealthBody>('/v1/health/own-state', {
      method: 'GET',
      query: {},
    });
  }
}
