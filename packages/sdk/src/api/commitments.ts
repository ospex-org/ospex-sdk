import type { ApiClient } from './client.js';
import type {
  Commitment,
  CommitmentsListOptions,
  StoredCommitmentStatus,
} from '../types/commitment.js';
import type { CommitmentBody, CommitmentsListBody } from './types.js';
import type { Hex } from '../types/signer.js';
import { OspexValidationError } from '../errors.js';

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export class CommitmentsApi {
  constructor(private readonly client: ApiClient) {}

  async list(options: CommitmentsListOptions = {}): Promise<Commitment[]> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (options.maker !== undefined) query.maker = options.maker;
    if (options.scorer !== undefined) query.scorer = options.scorer;
    if (options.contestId !== undefined) query.contestId = String(options.contestId);
    if (options.speculationId !== undefined) query.speculationId = String(options.speculationId);
    if (options.status !== undefined) {
      query.status = Array.isArray(options.status) ? options.status.join(',') : options.status;
    }
    if (options.includeInvalidated !== undefined) {
      query.includeInvalidated = options.includeInvalidated;
    }
    if (options.includeExpired !== undefined) {
      query.includeExpired = options.includeExpired;
    }
    if (options.includeFillability !== undefined) {
      query.includeFillability = options.includeFillability;
    }
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.offset !== undefined) query.offset = options.offset;
    const body = await this.client.request<CommitmentsListBody>('/v1/commitments', { query });
    return body.commitments.map(toCommitment);
  }

  /**
   * Single-row fetch by EIP-712 hash. Lowercases on the wire (the
   * server normalizes anyway, but consistency keeps logs tidy).
   * Returns the canonical Commitment shape; throws OspexAPIError on
   * 404, OspexValidationError on a malformed hash.
   */
  async get(hash: Hex): Promise<Commitment> {
    if (!HASH_PATTERN.test(hash)) {
      throw new OspexValidationError(
        'commitments.get hash must be a 0x-prefixed 32-byte hex string.',
        { field: 'hash' },
      );
    }
    const body = await this.client.request<CommitmentBody>(
      `/v1/commitments/${hash.toLowerCase()}`,
    );
    return toCommitment(body);
  }
}

/**
 * Wire body → public Commitment shape. The `isLive` predicate is
 * computed here (the API doesn't return it) so every consumer sees a
 * consistent value without each having to recompute it.
 *
 * Exported (vs file-local) so other API mappers — orderbooks embedded
 * in contest detail responses, the body returned by `match`, the
 * canonical row returned by `submit` — go through the same code path
 * instead of each redoing the predicate.
 *
 * `storedStatus` falls back to `status` for back-compat: a core-api build
 * predating effective-status omits `storedStatus` on the wire, so an SDK
 * pointed at an older API still yields a defined value (equal to `status`)
 * rather than `undefined`.
 */
export function toCommitment(body: CommitmentBody): Commitment {
  return {
    ...body,
    // Old core-api builds omit storedStatus; their `status` is the raw stored
    // value (those builds never derived an effective `expired`), so the cast is
    // sound on that path and short-circuited when storedStatus is present.
    storedStatus: body.storedStatus ?? (body.status as StoredCommitmentStatus),
    isLive: computeIsLive(body),
  };
}

/**
 * Mirrors the contract's matchCommitment preconditions:
 *   1. The RAW on-chain lifecycle (`storedStatus`) is 'open' or 'partially_filled'
 *      (both have remaining maker risk and weren't cancelled on chain) — NOT the
 *      effective `status`. The core API folds book-visibility into effective status:
 *      a *book-hidden* commitment (pulled from the orderbook off-chain, but whose
 *      signed payload is still matchable on chain) reads effective `status:
 *      'cancelled'`. `matchCommitment` does NOT check book-visibility, so that row is
 *      still live — keying off `storedStatus` keeps `isLive` true for it. Falls back to
 *      `status` when `storedStatus` is absent: a core-api predating effective status
 *      returns the raw value as `status` and had no book-visibility split.
 *   2. nonce ≥ s_minNonces[maker][specKey] (i.e. not flagged
 *      `nonceInvalidated` by the indexer's MIN_NONCE_UPDATED projection).
 *   3. remainingRiskAmount > 0. A 'partially_filled' row with zero
 *      remaining shouldn't exist (the indexer should flip to 'filled'),
 *      but the contract reverts on zero remaining anyway — be defensive.
 *   4. expiry is in the future. The contract reverts with
 *      MatchingModule__CommitmentExpired otherwise. Null expiry only
 *      appears on legacy / indexer-only rows that aren't matchable.
 */
function computeIsLive(body: CommitmentBody): boolean {
  // Raw on-chain lifecycle, NOT the effective `status` (which folds in book-visibility —
  // a book-hidden but on-chain-matchable row reads effective 'cancelled'). See precondition 1.
  const lifecycle = body.storedStatus ?? body.status;
  if (lifecycle !== 'open' && lifecycle !== 'partially_filled') return false;
  if (body.nonceInvalidated) return false;
  if (BigInt(body.remainingRiskAmount) <= 0n) return false;
  if (body.expiry === null) return false;
  const expiryMs = Date.parse(body.expiry);
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return false;
  return true;
}
