/**
 * OspexClient — composes the namespaced sub-objects that make up the
 * public SDK surface. Configuration is optional: by default the client
 * points at the production API. Reads, writes, and streaming all go
 * through `ospex-core-api`; the SDK opens core-api's SSE endpoints
 * directly for live odds and protocol streams, with no external
 * realtime credentials to bootstrap.
 *
 * Multiple instances are fully isolated — there is no module-level state.
 */

import type { PublicClient } from 'viem';

import { ApiClient } from './api/client.js';
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
import { Fills } from './fills/index.js';
import { Games } from './games/index.js';
import { Positions } from './positions/index.js';
import { Teams } from './teams/index.js';
import { getAddresses, type OspexAddresses } from './contracts/addresses.js';
import { OspexConfigError, OspexValidationError } from './errors.js';
import { decodeOddsEvent } from './api/oddsMappers.js';
import { normalizeUint } from './realtime/filters.js';
import { subscribeToOddsStream } from './realtime/oddsStream.js';
import type {
  ContestOddsSnapshot,
  MarketType,
  OddsForMarket,
  OddsSubscribeArgs,
  OddsSubscribeHandlers,
  Subscription,
} from './types/odds.js';
import type { ChainId } from './types/protocol.js';
import type { Signer } from './types/signer.js';

export const DEFAULT_API_URL = 'https://api.ospex.org';

export interface OspexClientOptions {
  /** Base URL of `ospex-core-api`. Defaults to production. */
  apiUrl?: string;
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
   * `polygon-rpc.com` has been returning 401 since 2026-03.
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
  readonly fills: Fills;
  readonly games: Games;
  readonly teams: Teams;
  readonly speculations: SpeculationsApi;
  readonly positions: Positions;
  readonly leaderboard: LeaderboardApi;
  readonly protocol: ProtocolApi;
  readonly health: HealthApi;
  /** Internal — exposed for tests to mock the underlying transport. */
  readonly api: ApiClient;

  private readonly oddsApi: OddsApi;
  private readonly _signer: Signer | undefined;
  private readonly _rpcUrl: string | undefined;
  private readonly _chainId: ChainId;
  private _publicClient: PublicClient | undefined;
  private readonly _addresses: OspexAddresses;
  private readonly _nonceCounter = new NonceCounter();

  constructor(options: OspexClientOptions = {}) {
    const apiOptions: ConstructorParameters<typeof ApiClient>[0] = {
      apiUrl: options.apiUrl ?? DEFAULT_API_URL,
    };
    if (options.fetch !== undefined) apiOptions.fetch = options.fetch;
    if (options.timeoutMs !== undefined) apiOptions.timeoutMs = options.timeoutMs;
    this.api = new ApiClient(apiOptions);
    this.fills = new Fills(this.api);

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
   * Odds surface — one-shot snapshot reads and a live SSE stream, both
   * served by `ospex-core-api`.
   *
   * - `snapshot(contestId)` — current upstream reference odds for the
   *   contest's underlying game. Single round-trip, no stream. Use when
   *   a user or agent needs to see odds *now* (e.g. before pricing a
   *   commitment).
   * - `subscribe({ contestId, market }, handlers)` — opens the core-api
   *   odds SSE stream for one (contest, market) and routes
   *   snapshot/change/refresh events to the handlers. Use when an agent
   *   needs to react to upstream odds moves over time. Contest-id native
   *   — the server resolves the upstream game, so no upstream id is
   *   needed. The handler payload is the market-specific shape
   *   (`MoneylineOdds` / `SpreadOdds` / `TotalOdds`).
   */
  readonly odds = {
    snapshot: (contestId: string): Promise<ContestOddsSnapshot> => {
      return this.oddsApi.snapshot(contestId);
    },
    subscribe: async <M extends MarketType>(
      args: OddsSubscribeArgs<M>,
      handlers: OddsSubscribeHandlers<OddsForMarket<M>>,
    ): Promise<Subscription> => {
      const contestId = normalizeUint(args.contestId, 'contestId');
      if (contestId === undefined) {
        throw new OspexValidationError('contestId is required.', { field: 'contestId' });
      }
      return subscribeToOddsStream<OddsForMarket<M>>({
        api: this.api,
        query: { contestId, market: args.market },
        decode: (body) => decodeOddsEvent(args.market, body),
        handlers,
      });
    },
  };
}
