/**
 * OspexClient — composes the namespaced sub-objects that make up the
 * public SDK surface. Configuration is optional: by default the client
 * points at the production API, and Supabase Realtime credentials are
 * fetched lazily from `/v1/config/public` on the first realtime call.
 *
 * Multiple instances are fully isolated — there is no module-level
 * state. The Supabase client is constructed lazily on first realtime
 * use, so no Supabase work happens when only the read endpoints are
 * called.
 */

import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import { ApiClient } from './api/client.js';
import { CommitmentsApi } from './api/commitments.js';
import { ConfigApi } from './api/config.js';
import { HealthApi } from './api/health.js';
import { LeaderboardApi } from './api/leaderboard.js';
import { MarketsApi } from './api/markets.js';
import { PositionsApi } from './api/positions.js';
import { ProtocolApi } from './api/protocol.js';
import { OspexConfigError } from './errors.js';
import { subscribeToOdds } from './realtime/odds.js';
import type { OddsSubscribeArgs, OddsSubscribeHandlers, Subscription } from './types/odds.js';
import type { PublicConfig } from './types/protocol.js';
import type { Signer } from './types/signer.js';

export const DEFAULT_API_URL = 'https://ospex-core-api-195f635df864.herokuapp.com';

export interface OspexClientOptions {
  /** Base URL of `ospex-core-api`. Defaults to production. */
  apiUrl?: string;
  /** Override Supabase project URL. Otherwise lazy-fetched from /v1/config/public. */
  supabaseUrl?: string;
  /** Override Supabase publishable / anon key. Otherwise lazy-fetched. */
  supabaseAnonKey?: string;
  /**
   * Wallet for signed actions. Optional in M1 (read-side only).
   * Reserved here so consumers can construct the client once and add
   * a signer when M2 ships commitment submission.
   */
  signer?: Signer;
  /** Default request timeout in ms. Optional. */
  timeoutMs?: number;
  /** Override fetch (mostly for tests). */
  fetch?: typeof globalThis.fetch;
}

export class OspexClient {
  readonly markets: MarketsApi;
  readonly commitments: CommitmentsApi;
  readonly positions: PositionsApi;
  readonly leaderboard: LeaderboardApi;
  readonly protocol: ProtocolApi;
  readonly health: HealthApi;
  /** Internal — exposed for tests to mock the underlying transport. */
  readonly api: ApiClient;

  private readonly configApi: ConfigApi;
  private readonly options: OspexClientOptions;
  private supabasePromise: Promise<SupabaseClient> | undefined;
  private readonly _signer: Signer | undefined;

  constructor(options: OspexClientOptions = {}) {
    this.options = options;
    const apiOptions: ConstructorParameters<typeof ApiClient>[0] = {
      apiUrl: options.apiUrl ?? DEFAULT_API_URL,
    };
    if (options.fetch !== undefined) apiOptions.fetch = options.fetch;
    if (options.timeoutMs !== undefined) apiOptions.timeoutMs = options.timeoutMs;
    this.api = new ApiClient(apiOptions);

    this.markets = new MarketsApi(this.api);
    this.commitments = new CommitmentsApi(this.api);
    this.positions = new PositionsApi(this.api);
    this.leaderboard = new LeaderboardApi(this.api);
    this.protocol = new ProtocolApi(this.api);
    this.health = new HealthApi(this.api);
    this.configApi = new ConfigApi(this.api);
    this._signer = options.signer;
  }

  /** True once a wallet has been attached. */
  hasSigner(): boolean {
    return this._signer !== undefined;
  }

  /**
   * The attached signer, if any. Throws OspexConfigError when not set —
   * read this only inside a code path that has already verified
   * `hasSigner()`, or that is guaranteed to be invoked in a write flow.
   */
  signer(): Signer {
    if (!this._signer) {
      throw new OspexConfigError('No signer attached. Pass `signer` to the OspexClient constructor.');
    }
    return this._signer;
  }

  /**
   * Subscribe to a single (jsonoddsId, market) odds row via Supabase
   * Realtime. Resolves once the channel is opened; events are routed
   * to the handlers from then on. Call `subscription.unsubscribe()` to
   * tear down the channel.
   */
  readonly odds = {
    subscribe: async (
      args: OddsSubscribeArgs,
      handlers: OddsSubscribeHandlers,
    ): Promise<Subscription> => {
      const supabase = await this.getSupabase();
      return subscribeToOdds(supabase, args, handlers);
    },
  };

  private async getSupabase(): Promise<SupabaseClient> {
    if (this.supabasePromise) return this.supabasePromise;
    this.supabasePromise = this.resolveSupabase();
    try {
      return await this.supabasePromise;
    } catch (err) {
      // Reset on failure so a transient /v1/config/public outage
      // doesn't permanently brick subsequent retries.
      this.supabasePromise = undefined;
      throw err;
    }
  }

  private async resolveSupabase(): Promise<SupabaseClient> {
    const config = await this.resolveConfig();
    return createSupabaseClient(config.supabaseUrl, config.supabaseAnonKey, {
      realtime: {
        params: { eventsPerSecond: 10 },
      },
      auth: {
        // We only ever use the publishable key for Realtime — there is
        // no user session to persist or refresh.
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  private async resolveConfig(): Promise<{ supabaseUrl: string; supabaseAnonKey: string }> {
    const { supabaseUrl, supabaseAnonKey } = this.options;
    if (supabaseUrl !== undefined && supabaseAnonKey !== undefined) {
      return { supabaseUrl, supabaseAnonKey };
    }
    let publicConfig: PublicConfig;
    try {
      publicConfig = await this.configApi.public();
    } catch (err) {
      throw new OspexConfigError(
        'Failed to fetch /v1/config/public for Realtime credentials. ' +
          'Provide `supabaseUrl` and `supabaseAnonKey` directly to bypass.',
        { cause: err },
      );
    }
    return {
      supabaseUrl: supabaseUrl ?? publicConfig.supabaseUrl,
      supabaseAnonKey: supabaseAnonKey ?? publicConfig.supabaseAnonKey,
    };
  }
}
