import type { ApiClient } from './client.js';
import type { PublicConfig } from '../types/protocol.js';
import type { PublicConfigBody } from './types.js';

export class ConfigApi {
  constructor(private readonly client: ApiClient) {}

  /**
   * Bootstrap config for public clients. Used internally by
   * `OspexClient` to obtain Supabase Realtime credentials when the
   * caller didn't provide overrides.
   */
  async public(): Promise<PublicConfig> {
    const body = await this.client.request<PublicConfigBody>('/v1/config/public');
    return body satisfies PublicConfig;
  }
}
