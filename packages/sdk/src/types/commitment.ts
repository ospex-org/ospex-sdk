import type { MarketType } from './odds.js';

export type CommitmentStatus =
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'expired';

/**
 * Public commitment shape. All on-chain numeric values that may exceed
 * Number.MAX_SAFE_INTEGER are strings (`riskAmount`, `nonce`, etc.) and
 * remain stringified when handed to the caller — it's their choice
 * whether to parse them as BigInt.
 */
export interface Commitment {
  commitmentHash: string;
  maker: string;
  contestId: string | null;
  scorer: string | null;
  lineTicks: number | null;
  positionType: 0 | 1 | null;
  oddsTick: number | null;
  marketType: MarketType | null;
  riskAmount: string;
  filledRiskAmount: string;
  remainingRiskAmount: string;
  nonce: string;
  /** ISO-8601 string. Null when not present (legacy rows). */
  expiry: string | null;
  speculationKey: string | null;
  signature: string | null;
  status: CommitmentStatus;
  source: string;
  network: string;
  nonceInvalidated: boolean;
  /** ISO-8601 string. */
  createdAt: string;
}

export interface CommitmentsListOptions {
  maker?: string;
  scorer?: string;
  contestId?: string | number;
  /**
   * Comma-separated status list, or array. Defaults API-side to
   * `'open,partially_filled'`.
   */
  status?: CommitmentStatus | CommitmentStatus[] | string;
  includeInvalidated?: boolean;
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
}
