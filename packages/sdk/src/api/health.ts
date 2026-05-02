import type { ApiClient } from './client.js';
import type { HealthBody } from './types.js';

export class HealthApi {
  constructor(private readonly client: ApiClient) {}

  /** Liveness probe — succeeds whenever the API process is up. */
  async check(): Promise<HealthBody> {
    return this.client.request<HealthBody>('/healthz');
  }
}
