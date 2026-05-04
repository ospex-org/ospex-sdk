import type { MarketType } from './odds.js';

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

/**
 * A position whose parent contest is scored on-chain but whose
 * speculation hasn't been settled yet. The on-chain finalization path
 * is `SpeculationModule.settleSpeculation(speculationId)` (permissionless,
 * any EOA) followed by `PositionModule.claimPosition(...)`. The
 * `result` and `predictedWinSide` are computed off-chain from the
 * contest scores by replaying the scorer logic — once
 * `settleSpeculation` runs, the on-chain `winSide` will match.
 */
export interface PendingSettlePositionView extends ActivePositionView {
  result: 'won' | 'push' | 'void';
  predictedWinSide: 'away' | 'home' | 'over' | 'under' | 'push';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
}

export interface PositionStatusTotals {
  activeCount: number;
  pendingSettleCount: number;
  claimableCount: number;
  /** Sum of `claimable` payouts (ready to sweep right now). */
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
  /** Sum of `pendingSettle` predicted payouts (require an extra
   * `settleSpeculation` call before they materialize). */
  pendingSettlePayoutUSDC: number;
  pendingSettlePayoutWei6: string;
}

export interface PositionStatus {
  active: ActivePositionView[];
  pendingSettle: PendingSettlePositionView[];
  claimable: ClaimablePositionView[];
  totals: PositionStatusTotals;
}

/**
 * One step in the on-chain action plan. The SDK consumes these from
 * `client.positions.claimParams(...)` and dispatches them in order.
 *
 * `target` is a stable label — the SDK maps it to the deployed contract
 * address for the configured chain (so address rotations don't break
 * SDK consumers). For M3 only two pairs are emitted:
 *   - SpeculationModule.settleSpeculation(speculationId)
 *   - PositionModule.claimPosition(speculationId, positionType)
 */
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

export interface ClaimParamEntry {
  positionId: string;
  speculationId: string;
  description: string;
  bucket: 'claimable' | 'pendingSettle';
  result: 'won' | 'push' | 'void';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
  /** Ordered. Execute steps left-to-right. */
  txParams: ClaimParamsTxStep[];
}

export interface ClaimParams {
  address: string;
  positions: ClaimParamEntry[];
}
