/**
 * Compile-time constants for M4 contest creation. Refresh on contract redeploy.
 */
import type { ChainId } from '../types/protocol.js';

/**
 * Per-chain protocol speculation creation fee in wei6 (USDC × 10^6).
 * Paid only when a commitment match triggers lazy speculation creation
 * — i.e., the FIRST match on a `(contestId, scorer, lineTicks)` key.
 * The total is split 50/50 between the maker and taker of that first
 * match via `TreasuryModule.processSplitFee`. Once the speculation
 * exists, no further matches incur this fee.
 *
 * Sourced from the contracts repo's deploy scripts (= 500000 wei6 =
 * 0.50 USDC on both mainnet and Amoy). The deploy-script comment
 * annotates this as CONFIGURABLE; refresh this table on any redeploy
 * that changes it.
 */
export const SPECULATION_CREATION_FEE_WEI6: Record<ChainId, bigint> = {
  137: 500_000n,
  80002: 500_000n,
};

/**
 * Per-chain per-side share of the speculation creation fee — what
 * one party (maker OR taker) pays when their match triggers lazy
 * creation. The contract computes `firstHalf = total / 2` in
 * `TreasuryModule.processSplitFee`; for the canonical 500000 total,
 * both halves are equal. Mirrored here rather than computed at call
 * sites so the value is visible in code review next to its source.
 */
export const SPECULATION_CREATION_FEE_MAKER_SHARE_WEI6: Record<ChainId, bigint> = {
  137: 250_000n,
  80002: 250_000n,
};

/**
 * Transaction-level gas budget for the CRE oracle request entrypoints
 * (`createContestAndRequestVerify` / `requestScore` on CreOracleReceiver).
 * These are the EVM gas the outer tx may use. `eth_estimateGas` is unreliable
 * in this region across some Polygon RPCs (Infura strips revert data; public
 * RPCs hit state-history issues), so these empirically-safe ceilings bypass
 * estimateGas for these specific txs. EIP-1559 refunds the unused portion, so
 * paying the ceiling is bounded by actual consumption. (Create does more work
 * — contest record + USDC creation fee + request event; score only sets a
 * flag + emits — hence the lower score budget.)
 */
export const OSPEX_CREATE_CONTEST_TX_GAS = 2_000_000n as const;
export const OSPEX_SCORE_CONTEST_TX_GAS = 1_000_000n as const;

/** Default verify-pending timeout for waitForVerified — ~2x typical CRE report latency. */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000 as const;
export const DEFAULT_VERIFICATION_POLL_INTERVAL_MS = 4_000 as const;
