/**
 * Internal API response types. Mirror what `ospex-core-api` returns
 * over the wire — kept out of the public surface so we can re-shape
 * them at the SDK boundary without breaking SDK consumers. Refresh
 * when the API contract changes.
 */

import type { CommitmentStatus } from '../types/commitment.js';
import type { ChainId, Network } from '../types/protocol.js';

export interface ApiErrorBody {
  error: string;
  code?: string;
}

export interface PaginationBody {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface HealthBody {
  ok: true;
  service: 'ospex-core-api';
  network: Network;
  chainId: ChainId;
  uptimeSeconds: number;
  timestamp: string;
}

export interface PublicConfigBody {
  supabaseUrl: string;
  supabaseAnonKey: string;
  network: Network;
  chainId: ChainId;
}

export interface ProtocolInfoBody {
  name: 'Ospex';
  network: Network;
  chainId: ChainId;
  contracts: {
    matchingModule: string | null;
    scorers: { moneyline: string; spread: string; total: string } | null;
  };
  supportedSports: string[];
  fees: { platformFeePct: number; description: string };
}

export interface AuthDomainBody {
  domain: {
    name: string;
    version: string;
    chainId: ChainId;
    verifyingContract: string;
  };
  network: Network;
  actions: Record<string, Array<{ name: string; type: string }>>;
  requestFormat: {
    description: string;
    endpoints: Record<string, string>;
    example: { action: Record<string, unknown>; signature: string };
  };
}

export interface CommitmentBody {
  commitmentHash: string;
  maker: string;
  contestId: string | null;
  scorer: string | null;
  lineTicks: number | null;
  positionType: 0 | 1 | null;
  oddsTick: number | null;
  marketType: 'moneyline' | 'spread' | 'total' | null;
  riskAmount: string;
  filledRiskAmount: string;
  remainingRiskAmount: string;
  nonce: string;
  expiry: string | null;
  speculationKey: string | null;
  signature: string | null;
  /** EFFECTIVE status — folds in time-expiry + nonce invalidation. */
  status: CommitmentStatus;
  /**
   * Raw indexer/relay status. Optional on the wire for back-compat with
   * core-api builds that predate effective-status (older deploys omit it);
   * `toCommitment` falls back to `status` in that case.
   */
  storedStatus?: CommitmentStatus;
  source: string;
  network: string;
  nonceInvalidated: boolean;
  createdAt: string;
}

export interface SpeculationBody {
  speculationId: string;
  contestId: string;
  type: 'moneyline' | 'spread' | 'total';
  lineTicks: number | null;
  line: number | null;
  awayLine?: number;
  homeLine?: number;
  speculationStatus: 0 | 1;
  orderbook?: CommitmentBody[];
}

export interface ContestBody {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  sport: string;
  sportId: number;
  matchTime: string;
  status: string;
  speculations: SpeculationBody[];
  // Detail-endpoint-only fields — undefined on /v1/contests list rows.
  // Populated by /v1/contests/:contestId.
  jsonoddsId?: string | null;
  rundownId?: string | null;
  sportspageId?: string | null;
  contestCreator?: string;
  leagueId?: string;
  verifySourceHash?: string | null;
  marketUpdateSourceHash?: string | null;
  scoreContestSourceHash?: string | null;
  awayScore?: number | null;
  homeScore?: number | null;
  contestCreatedAt?: string | null;
  verifiedAt?: string | null;
  scoredAt?: string | null;
  voidedAt?: string | null;
  /**
   * Team UUIDs from `teams`, resolved server-side via the games-row
   * join. Detail-endpoint-only. Null when the contest has no
   * JSONOdds linkage or the games row is missing — the SDK
   * resolver falls back to exact + nickname matching in that case.
   */
  awayTeamId?: string | null;
  homeTeamId?: string | null;
}

/** Wire body for `GET /v1/contests`. */
export interface ContestsListBody {
  contests: ContestBody[];
  pagination: PaginationBody;
}

export interface SpeculationParentContextBody {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  /**
   * Team UUIDs from the games-row join. Null when the contest has no
   * JSONOdds linkage — the SDK resolver scopes alias matching to these
   * when both are non-null and falls back to exact + nickname otherwise.
   */
  awayTeamId: string | null;
  homeTeamId: string | null;
  sport: string;
  matchTime: string;
  status: string;
}

/** Wire body for `GET /v1/speculations/:speculationId`. */
export interface SpeculationDetailBody extends SpeculationBody {
  orderbook: CommitmentBody[];
  contest: SpeculationParentContextBody;
}

/** Wire body for `GET /v1/speculations`. */
export interface SpeculationsListBody {
  speculations: SpeculationBody[];
  pagination: PaginationBody;
}

export interface ScriptApprovalEntryBody {
  scriptHash: string;
  purpose: 0 | 1 | 2;
  leagueId: number;
  version: number;
  validUntil: number;
  signature: string;
  sourceUrl: string;
}

export interface ApprovedScriptsBody {
  network: Network;
  approvedSigner: string;
  verify: ScriptApprovalEntryBody;
  marketUpdate: ScriptApprovalEntryBody;
  score: ScriptApprovalEntryBody;
}

export interface CommitmentsListBody {
  commitments: CommitmentBody[];
  pagination: PaginationBody;
}

export interface PositionBody {
  speculationId: string;
  positionType: 0 | 1 | null;
  riskAmountUSDC: number;
  profitAmountUSDC: number;
  claimed: boolean;
  positionCreatedAt: string | null;
}

export interface PositionsByAddressBody {
  address: string;
  positions: PositionBody[];
  totals: {
    totalCount: number;
    totalRiskUSDC: number;
    totalProfitUSDC: number;
    activeCount: number;
  };
  pagination: PaginationBody;
}

export interface ActivePositionBody {
  positionId: string;
  speculationId: string;
  positionType: 0 | 1;
  team: string;
  opponent: string;
  market: 'moneyline' | 'spread' | 'total';
  oddsDecimal: number | null;
  riskAmountUSDC: number;
  profitAmountUSDC: number;
}

export interface ClaimablePositionBody extends ActivePositionBody {
  result: 'won' | 'push' | 'void';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
}

export interface PendingSettlePositionBody extends ActivePositionBody {
  /** Predicted result once `settleSpeculation` is called. */
  result: 'won' | 'push' | 'void';
  /** Predicted on-chain winSide once settled. */
  predictedWinSide: 'away' | 'home' | 'over' | 'under' | 'push';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
}

export interface PositionStatusBody {
  address: string;
  active: ActivePositionBody[];
  pendingSettle: PendingSettlePositionBody[];
  claimable: ClaimablePositionBody[];
  totals: {
    activeCount: number;
    pendingSettleCount: number;
    claimableCount: number;
    estimatedPayoutUSDC: number;
    estimatedPayoutWei6: string;
    pendingSettlePayoutUSDC: number;
    pendingSettlePayoutWei6: string;
  };
}

export type ClaimParamsTxStep =
  | {
      method: 'settleSpeculation';
      target: 'SpeculationModule';
      args: { speculationId: string };
    }
  | {
      method: 'claimPosition';
      target: 'PositionModule';
      args: { speculationId: string; positionType: 0 | 1 };
    };

export interface ClaimParamEntryBody {
  positionId: string;
  speculationId: string;
  description: string;
  bucket: 'claimable' | 'pendingSettle';
  result: 'won' | 'push' | 'void';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
  /** Ordered: pendingSettle entries lead with `settleSpeculation`,
   * claimable entries are a single `claimPosition` step. */
  txParams: ClaimParamsTxStep[];
}

export interface ClaimParamsResponseBody {
  address: string;
  positions: ClaimParamEntryBody[];
}

export interface PositionByTxFilledEntryBody {
  positionId: string;
  speculationId: string;
  user: string;
  positionType: 0 | 1;
  role: 'maker' | 'taker';
  riskAmount: string;
  riskAmountUSDC: number;
  counterparty: string;
}

export interface PositionByTxResponseBody {
  txHash: string;
  blockNumber: number;
  positions: PositionByTxFilledEntryBody[];
}

export interface ClaimResultResponseBody {
  txHash: string;
  blockNumber: number;
  speculationId: string;
  user: string;
  positionType: 0 | 1;
  payoutUSDC: number;
  payoutWei6: string;
}

export interface LeaderboardEntryBody {
  rank: number;
  address: string;
  declaredBankrollUSDC: number;
}

export interface LeaderboardBody {
  leaderboardId: string;
  startTime: string;
  endTime: string;
  entries: LeaderboardEntryBody[];
  pagination: PaginationBody;
}

export interface GameTeamBody {
  name: string;
  abbreviation: string;
}

export interface GameExternalIdsBody {
  jsonodds: string;
  sportspage: string | null;
  rundown: string | null;
}

export interface GameBody {
  gameId: string;
  slug: string;
  sport: string;
  matchTime: string;
  status: string;
  homeTeam: GameTeamBody;
  awayTeam: GameTeamBody;
  hasOdds: boolean;
  contestCreated: boolean;
  contestId: string | null;
  canCreateContest: boolean;
  externalIds: GameExternalIdsBody;
}

export interface GamesListBody {
  sport: string | null;
  windowHours: number;
  availableOnly: boolean;
  games: GameBody[];
  pagination: PaginationBody;
}

/**
 * Wire bodies for `GET /v1/contests/:contestId/odds`. Per-market
 * shapes are explicit so the wire format can't be misread:
 *
 *   - moneyline: per-side American odds. No line field.
 *   - spread:    awayLine + homeLine + per-side American odds. The
 *                writer stores only home spread in current_odds.line;
 *                the server fills awayLine = -homeLine before serving.
 *   - total:     line (threshold) + overOddsAmerican + underOddsAmerican.
 *                The writer's away/home → over/under storage convention
 *                is hidden at the API boundary.
 *
 * The away/home → over/under remapping for `total` happens server-side at the API boundary.
 */
interface OddsTimestampsBody {
  upstreamLastUpdated: string;
  pollCapturedAt: string;
  changedAt: string;
}

export interface MoneylineOddsBody extends OddsTimestampsBody {
  market: 'moneyline';
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

export interface SpreadOddsBody extends OddsTimestampsBody {
  market: 'spread';
  awayLine: number | null;
  homeLine: number | null;
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

export interface TotalOddsBody extends OddsTimestampsBody {
  market: 'total';
  line: number | null;
  overOddsAmerican: number | null;
  underOddsAmerican: number | null;
}

export interface ContestOddsBody {
  contestId: string;
  /** Null when the contest has no upstream JSONOdds linkage. */
  jsonoddsId: string | null;
  /** Per-market entries are null when the writer hasn't populated them. */
  odds: {
    moneyline: MoneylineOddsBody | null;
    spread: SpreadOddsBody | null;
    total: TotalOddsBody | null;
  };
}

/**
 * Wire body for one row of `GET /v1/teams/aliases`. Joined through
 * `teams` server-side so consumers get canonical sport + display
 * fields without a second round-trip.
 */
export interface TeamAliasBody {
  teamId: string;
  sport: string;
  sportId: number;
  teamName: string;
  abbrev: string;
  alias: string;
  /**
   * Free-form classification. Real values seen in production:
   * 'short' | 'full' | 'abbreviation' (and others added by ops).
   * The SDK resolver matches against `alias` text regardless of
   * `aliasType` — this field is informational only.
   */
  aliasType: string;
  source: string;
}

/** Wire body for `GET /v1/teams/aliases`. */
export interface TeamAliasesListBody {
  aliases: TeamAliasBody[];
  pagination: PaginationBody;
}
