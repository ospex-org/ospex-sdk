import type { ApiClient } from './client.js';
import type { Commitment, CommitmentsListOptions } from '../types/commitment.js';
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

function toCommitment(body: CommitmentBody): Commitment {
  return body satisfies Commitment;
}
