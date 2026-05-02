import type { MarketType } from './market.js';

export interface Position {
  speculationId: string;
  positionType: 0 | 1 | null;
  riskAmountUSDC: number;
  profitAmountUSDC: number;
  claimed: boolean;
  /** ISO-8601 string. */
  positionCreatedAt: string | null;
}

export interface PositionTotals {
  totalCount: number;
  totalRiskUSDC: number;
  totalProfitUSDC: number;
  /** Count of positions not yet claimed. */
  activeCount: number;
}

export interface ActivePositionView {
  positionId: string;
  speculationId: string;
  positionType: 0 | 1;
  team: string;
  opponent: string;
  market: MarketType;
  oddsDecimal: number | null;
  riskAmountUSDC: number;
  profitAmountUSDC: number;
}

export interface ClaimablePositionView extends ActivePositionView {
  result: 'won' | 'push' | 'void';
  estimatedPayoutUSDC: number;
  /** Wei-6 (USDC unit) as a decimal string. */
  estimatedPayoutWei6: string;
}

export interface PositionStatusTotals {
  activeCount: number;
  claimableCount: number;
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
}

export interface PositionStatus {
  active: ActivePositionView[];
  claimable: ClaimablePositionView[];
  totals: PositionStatusTotals;
}
