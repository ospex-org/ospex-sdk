import type { ApiClient } from './client.js';
import type { Commitment, CommitmentsListOptions } from '../types/commitment.js';
import type { CommitmentBody, CommitmentsListBody } from './types.js';

export class CommitmentsApi {
  constructor(private readonly client: ApiClient) {}

  async list(options: CommitmentsListOptions = {}): Promise<Commitment[]> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (options.maker !== undefined) query.maker = options.maker;
    if (options.scorer !== undefined) query.scorer = options.scorer;
    if (options.contestId !== undefined) query.contestId = String(options.contestId);
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
}

function toCommitment(body: CommitmentBody): Commitment {
  return body satisfies Commitment;
}
