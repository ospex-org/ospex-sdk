/**
 * Compile-time constants for M4 contest creation. Refresh on contract
 * redeploy or signer rotation.
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
 * Per-chain maximum Chainlink Functions callback gas. The router reverts
 * with `GasLimitTooBig(uint32)` (selector 0x1d70f87a) carrying its
 * `maxCallbackGasLimit` as the argument when a request exceeds this
 * value. Both Polygon mainnet and Amoy currently sit at 300_000; this
 * lookup exists so a future supported chain (e.g. Optimism, Base) can
 * carry a different ceiling without touching the call sites.
 *
 * The SDK validates user-supplied `gasLimit` against this ceiling before
 * building calldata (rather than letting the router revert with a LINK
 * burn). The CLI's zod schema enforces the same upper bound so the user
 * sees a typed rejection at parse time.
 */
export const OSPEX_FUNCTIONS_CALLBACK_GAS_MAX: Record<ChainId, number> = {
  137: 300_000,
  80002: 300_000,
};

/**
 * Default Chainlink Functions callback gas limit for OracleModule requests.
 * Picked to match the router cap on every supported chain so every request
 * is accepted; the verify / score / market-update scripts the protocol
 * ships fit comfortably under it.
 *
 * Operators can pass a smaller value via `args.gasLimit` to economize on
 * subscription LINK draw. Larger values are rejected client-side against
 * `OSPEX_FUNCTIONS_CALLBACK_GAS_MAX` rather than letting the router revert
 * after the LINK transferAndCall payment.
 */
export const OSPEX_DEFAULT_GAS_LIMIT = 300_000 as const;

/**
 * Transaction-level gas budget overrides for OracleModule entrypoints.
 *
 * Distinct from `OSPEX_DEFAULT_GAS_LIMIT` (the Chainlink callback gas, in
 * calldata): these are the EVM gas the *outer* tx is allowed to use. The
 * outer tx body is non-trivial — LINK transferFrom + transferAndCall to
 * the router, USDC transferFrom via ContestModule → OspexCore →
 * TreasuryModule, three EIP-712 signature verifications, contest
 * record creation, and a Chainlink Functions request submit — and
 * `eth_estimateGas` is unreliable in this region across some Polygon
 * RPCs (Infura strips revert data; public RPCs hit state-history
 * issues). These ceilings are empirically tested and bypass
 * estimateGas for these specific txs. EIP-1559 refunds the unused
 * portion, so paying the ceiling cost is bounded by actual consumption.
 */
export const OSPEX_CREATE_CONTEST_TX_GAS = 2_000_000n as const;
export const OSPEX_SCORE_CONTEST_TX_GAS = 1_000_000n as const;

/**
 * Per-call LINK payment, in wei. Calculated as 1e18 / linkDenominator.
 *   - Polygon mainnet: linkDenominator = 200 → 0.005 LINK
 *   - Polygon Amoy:    linkDenominator = 250 → 0.004 LINK
 *
 * Sourced from the contracts repo's deploy scripts.
 */
export const LINK_PAYMENT_PER_CALL_WEI: Record<ChainId, bigint> = {
  137: 5_000_000_000_000_000n,
  80002: 4_000_000_000_000_000n,
};

/**
 * Operator-level Chainlink Functions subscription published as the
 * "shared" default. Operators may pass their own subscription id at call
 * time; this is the fallback when none is supplied.
 *
 * Mainnet 191 is the protocol-maintained shared subscription. Whether
 * OracleModule is a registered consumer of 191 is checked via runtime
 * pre-flight (or surfaced as a Chainlink router revert at submit time).
 *
 * Amoy has no protocol-shared subscription — operators must always pass
 * their own. SDK throws OspexSubscriptionError when subscriptionId is
 * omitted on amoy.
 */
export const OSPEX_SHARED_SUBSCRIPTION_ID: Record<ChainId, bigint | null> = {
  137: 191n,
  80002: null,
};

/**
 * The EIP-712 signer authorized to sign ScriptApproval structs that
 * OracleModule.createContestFromOracle accepts. Immutable per
 * OracleModule deployment. Sourced from the contracts repo's deploy
 * scripts; rotation requires a redeploy.
 */
export const APPROVED_SIGNER_BY_CHAIN: Record<ChainId, `0x${string}`> = {
  137: '0xfd6C7Fc1F182de53AA636584f1c6B80d9D885886',
  80002: '0x89fe160bBBe59eAF428f23F095B71E5C0EdCDfa3',
};

/**
 * Default URL for the protocol's secrets API — exposes
 * `POST /api/get-encrypted-secrets` for Chainlink Functions encrypted
 * secrets retrieval. `secrets.ospex.org` is a protocol-stable alias so
 * an underlying-deployment migration doesn't ripple into the SDK.
 */
export const OSPEX_API_SERVER_URL = 'https://secrets.ospex.org' as const;

/** Default verify-pending timeout for waitForVerified — ~2x typical Chainlink callback latency. */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000 as const;
export const DEFAULT_VERIFICATION_POLL_INTERVAL_MS = 4_000 as const;
