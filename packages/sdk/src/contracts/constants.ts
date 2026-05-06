/**
 * Compile-time constants for M4 contest creation. Refresh on contract
 * redeploy or signer rotation.
 */
import type { ChainId } from '../types/protocol.js';

/**
 * Default Chainlink Functions callback gas limit for OracleModule requests.
 *
 * Capped at the Polygon mainnet Functions Router maximum (300,000). The
 * router reverts with `GasLimitTooBig(uint32)` (selector 0x1d70f87a) on
 * any request above its `maxCallbackGasLimit`. Polygon Amoy has the same
 * 300k ceiling, and the verify / score / market-update scripts the
 * protocol ships fit comfortably under it (lovable runs the same value).
 *
 * Operators can pass a smaller value via `args.gasLimit` to economize on
 * subscription LINK draw; passing a larger value makes every request
 * revert at the router and burns the LINK transferAndCall payment.
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
 * RPCs (Infura strips revert data, public RPCs hit state-history
 * issues per `ospex-foundry-matched-pairs/docs/DEPLOYMENT.md`). We
 * adopt lovable's tested ceilings and bypass estimateGas for these
 * specific txs. EIP-1559 refunds the unused portion, so paying the
 * ceiling cost is bounded by actual consumption.
 */
export const OSPEX_CREATE_CONTEST_TX_GAS = 2_000_000n as const;
export const OSPEX_SCORE_CONTEST_TX_GAS = 1_000_000n as const;

/**
 * Per-call LINK payment, in wei. Calculated as 1e18 / linkDenominator.
 *   - Polygon mainnet: linkDenominator = 200 → 0.005 LINK
 *   - Polygon Amoy:    linkDenominator = 250 → 0.004 LINK
 *
 * Source: ospex-foundry-matched-pairs/script/{DeployPolygon,DeployAmoy}.s.sol
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
 * Mainnet 191 is owned by the protocol deployer. Whether OracleModule is
 * a registered consumer of 191 is checked via runtime pre-flight (or
 * surfaced as a Chainlink router revert at submit time).
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
 * OracleModule deployment.
 *
 * Source: ospex-foundry-matched-pairs/script/{DeployPolygon,DeployAmoy}.s.sol.
 */
export const APPROVED_SIGNER_BY_CHAIN: Record<ChainId, `0x${string}`> = {
  137: '0xfd6C7Fc1F182de53AA636584f1c6B80d9D885886',
  80002: '0x89fe160bBBe59eAF428f23F095B71E5C0EdCDfa3',
};

/**
 * Default ospex-api-server URL — exposes POST /api/get-encrypted-secrets
 * for Chainlink Functions encrypted secrets retrieval.
 *
 * `secrets.ospex.org` is the protocol-stable alias for the underlying
 * Heroku app `ospex-api` (verified responding with a valid encrypted
 * payload on 2026-05-03). Prefer the alias in code so a Heroku app
 * rename / migration doesn't ripple into the SDK.
 */
export const OSPEX_API_SERVER_URL = 'https://secrets.ospex.org' as const;

/** Default verify-pending timeout for waitForVerified — ~2x typical Chainlink callback latency. */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000 as const;
export const DEFAULT_VERIFICATION_POLL_INTERVAL_MS = 4_000 as const;
