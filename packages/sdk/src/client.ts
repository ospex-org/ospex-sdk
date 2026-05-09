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
import type { PublicClient } from 'viem';

import { ApiClient } from './api/client.js';
import { ConfigApi } from './api/config.js';
import { ContestsApi } from './api/contests.js';
import { GamesApi } from './api/games.js';
import { HealthApi } from './api/health.js';
import { LeaderboardApi } from './api/leaderboard.js';
import { OddsApi } from './api/odds.js';
import { PositionsApi } from './api/positions.js';
import { ProtocolApi } from './api/protocol.js';
import { SpeculationsApi } from './api/speculations.js';
import { TeamsApi } from './api/teams.js';
import { createReadClient } from './chain/client.js';
import { Approvals } from './approvals/index.js';
import { Balances } from './balances/index.js';
import { Commitments } from './commitments/index.js';
import { NonceCounter } from './commitments/context.js';
import { Contests } from './contests/index.js';
import { Games } from './games/index.js';
import { Positions } from './positions/index.js';
import { Teams } from './teams/index.js';
import { getAddresses, type OspexAddresses } from './contracts/addresses.js';
import { OspexConfigError } from './errors.js';
import { subscribeToOdds } from './realtime/odds.js';
import type {
  ContestOddsSnapshot,
  OddsSubscribeArgs,
  OddsSubscribeHandlers,
  Subscription,
} from './types/odds.js';
import type { ChainId, PublicConfig } from './types/protocol.js';
import type { Signer } from './types/signer.js';

export const DEFAULT_API_URL = 'https://api.ospex.org';

export interface OspexClientOptions {
  /** Base URL of `ospex-core-api`. Defaults to production. */
  apiUrl?: string;
  /** Override Supabase project URL. Otherwise lazy-fetched from /v1/config/public. */
  supabaseUrl?: string;
  /** Override Supabase publishable / anon key. Otherwise lazy-fetched. */
  supabaseAnonKey?: string;
  /**
   * Wallet for signed actions. Required by every M2 write method
   * (`commitments.submit`, `match`, `approve`, `cancel`); reads work
   * without it. The client throws `OspexConfigError` only when a
   * write is attempted without a signer.
   */
  signer?: Signer;
  /**
   * Polygon RPC URL. Required for any chain operation (`commitments`
   * submit/match/approve, plus reads of nonce floor and allowance).
   * Reads of off-chain state via the API don't need it.
   *
   * Use Alchemy / Infura / QuickNode in production. Public RPCs
   * (`polygon-rpc.com`, `rpc-amoy.polygon.technology`) are flaky and
   * `polygon-rpc.com` returns 401 since 2026-03 — see
   * `ospex-foundry-matched-pairs/docs/DEPLOYMENT.md`.
   */
  rpcUrl?: string;
  /**
   * Chain id for chain operations. One client = one chain. Defaults
   * to `137` (Polygon mainnet); set to `80002` for Amoy testnet.
   */
  chainId?: ChainId;
  /** Default request timeout in ms. Optional. */
  timeoutMs?: number;
  /** Override fetch (mostly for tests). */
  fetch?: typeof globalThis.fetch;
}

export class OspexClient {
  readonly approvals: Approvals;
  readonly balances: Balances;
  readonly commitments: Commitments;
  readonly contests: Contests;
  readonly games: Games;
  readonly teams: Teams;
  readonly speculations: SpeculationsApi;
  readonly positions: Positions;
  readonly leaderboard: LeaderboardApi;
  readonly protocol: ProtocolApi;
  readonly health: HealthApi;
  /** Internal — exposed for tests to mock the underlying transport. */
  readonly api: ApiClient;

  private readonly configApi: ConfigApi;
  private readonly oddsApi: OddsApi;
  private readonly options: OspexClientOptions;
  private supabasePromise: Promise<SupabaseClient> | undefined;
  private readonly _signer: Signer | undefined;
  private readonly _rpcUrl: string | undefined;
  private readonly _chainId: ChainId;
  private _publicClient: PublicClient | undefined;
  private readonly _addresses: OspexAddresses;
  private readonly _nonceCounter = new NonceCounter();

  constructor(options: OspexClientOptions = {}) {
    this.options = options;
    const apiOptions: ConstructorParameters<typeof ApiClient>[0] = {
      apiUrl: options.apiUrl ?? DEFAULT_API_URL,
    };
    if (options.fetch !== undefined) apiOptions.fetch = options.fetch;
    if (options.timeoutMs !== undefined) apiOptions.timeoutMs = options.timeoutMs;
    this.api = new ApiClient(apiOptions);

    this._signer = options.signer;
    this._rpcUrl = options.rpcUrl;
    this._chainId = options.chainId ?? 137;
    this._addresses = getAddresses(this._chainId);

    const contestsApi = new ContestsApi(this.api);
    const gamesApi = new GamesApi(this.api);
    const positionsApi = new PositionsApi(this.api);
    const teamsApi = new TeamsApi(this.api);
    this.oddsApi = new OddsApi(this.api);
    this.speculations = new SpeculationsApi(this.api);
    this.leaderboard = new LeaderboardApi(this.api);
    this.protocol = new ProtocolApi(this.api);
    this.health = new HealthApi(this.api);
    this.configApi = new ConfigApi(this.api);
    this.games = new Games({ gamesApi });
    this.teams = new Teams(teamsApi);

    this.commitments = new Commitments({
      api: this.api,
      requireSigner: () => this.signer(),
      getChainId: () => this._chainId,
      getAddresses: () => this._addresses,
      requireChainClient: () => this.requirePublicClient(),
      nonceCounter: this._nonceCounter,
      // The high-level submit orchestrator needs contest detail,
      // speculation detail, and the cached alias set. Lazy getters
      // so reads-only consumers don't construct the dependencies
      // they'll never use.
      getContestsApi: () => contestsApi,
      getSpeculationsApi: () => this.speculations,
      getTeams: () => this.teams,
    });

    this.contests = new Contests({
      api: this.api,
      contestsApi,
      gamesApi,
      requireSigner: () => this.signer(),
      getChainId: () => this._chainId,
      getAddresses: () => this._addresses,
      requireChainClient: () => this.requirePublicClient(),
    });

    this.positions = new Positions({
      api: this.api,
      positionsApi,
      requireSigner: () => this.signer(),
      getChainId: () => this._chainId,
      getAddresses: () => this._addresses,
      requireChainClient: () => this.requirePublicClient(),
    });

    this.approvals = new Approvals({
      requireSigner: () => this.signer(),
      getChainId: () => this._chainId,
      getAddresses: () => this._addresses,
      requireChainClient: () => this.requirePublicClient(),
    });

    this.balances = new Balances({
      requireSigner: () => this.signer(),
      getChainId: () => this._chainId,
      getAddresses: () => this._addresses,
      requireChainClient: () => this.requirePublicClient(),
    });
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

  /** True once an `rpcUrl` has been configured. */
  hasChain(): boolean {
    return this._rpcUrl !== undefined;
  }

  /** Configured chain id (137 mainnet, 80002 amoy). */
  chainId(): ChainId {
    return this._chainId;
  }

  /**
   * Resolve a viem PublicClient bound to the configured `rpcUrl`.
   * Throws OspexConfigError if no rpcUrl was provided. Cached after
   * first construction so multiple writes reuse one transport.
   */
  private requirePublicClient(): PublicClient {
    if (this._publicClient) return this._publicClient;
    if (!this._rpcUrl) {
      throw new OspexConfigError(
        'rpcUrl required for write operations. Pass `rpcUrl` to the OspexClient constructor or run `ospex init`.',
      );
    }
    this._publicClient = createReadClient(this._rpcUrl, this._chainId);
    return this._publicClient;
  }

  /**
   * Odds surface — both one-shot snapshot reads and Realtime streaming.
   *
   * - `snapshot(contestId)` — current upstream reference odds for the
   *   contest's underlying game. Single round-trip, no channel. Use
   *   when a user or agent needs to see odds *now* (e.g. before
   *   pricing a commitment).
   * - `subscribe({ jsonoddsId, market }, handlers)` — opens a Supabase
   *   Realtime channel and routes change/refresh events to the
   *   handlers. Use when an agent needs to react to upstream odds
   *   moves over time. The args take a raw `jsonoddsId` because the
   *   channel filter is by upstream id; resolve from a contestId via
   *   `client.contests.get(contestId).jsonoddsId` first if needed.
   */
  readonly odds = {
    snapshot: (contestId: string): Promise<ContestOddsSnapshot> => {
      return this.oddsApi.snapshot(contestId);
    },
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
