/**
 * A `position_fills` row — the append-only record of a matched commitment.
 * Each `PositionFilled` event creates two positions (maker + taker), so a
 * fill carries both sides. Delivered by `client.fills.subscribe`.
 *
 * Fills are an append-only, event-like stream (not state-delta convergence
 * like the other resources): apply every event and dedupe by the natural
 * key `(txHash, logIndex)`.
 */
export interface Fill {
  speculationId: string;
  contestId: string;
  /** EIP-712 hash of the maker commitment this fill matched against. */
  commitmentHash: string;
  /** Maker wallet (lower-case hex). */
  maker: string;
  /** Taker wallet (lower-case hex). */
  taker: string;
  /** 0 = upper (away/over), 1 = lower (home/under). */
  makerPositionType: 0 | 1;
  takerPositionType: 0 | 1;
  /** Maker risk in USDC wei-6, as a decimal string. */
  makerRiskAmount: string;
  /** Taker risk in USDC wei-6, as a decimal string. */
  takerRiskAmount: string;
  makerRiskUSDC: number;
  takerRiskUSDC: number;
  /** Agreed odds in tick form (101–10100). */
  oddsTick: number;
  /** ISO-8601 string. When the fill was recorded on-chain. */
  filledAt: string;
  /** Whether the parent contest had already started at fill time. */
  contestStarted: boolean;
  txHash: string;
  logIndex: number;
}
