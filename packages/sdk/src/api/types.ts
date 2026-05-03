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
  status: CommitmentStatus;
  source: string;
  network: string;
  nonceInvalidated: boolean;
  createdAt: string;
}

export interface MarketSpeculationBody {
  speculationId: string;
  type: 'moneyline' | 'spread' | 'total';
  lineTicks: number | null;
  line: number | null;
  awayLine?: number;
  homeLine?: number;
  speculationStatus: 0 | 1;
  orderbook?: CommitmentBody[];
}

export interface MarketBody {
  contestId: string;
  awayTeam: string;
  homeTeam: string;
  sport: string;
  sportId: number;
  matchTime: string;
  status: string;
  speculations: MarketSpeculationBody[];
  /**
   * Detail-endpoint-only — undefined on /v1/markets list rows.
   * Null when the contest has no JSONOdds linkage.
   */
  jsonoddsId?: string | null;
}

export interface MarketsListBody {
  markets: MarketBody[];
  pagination: PaginationBody;
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
