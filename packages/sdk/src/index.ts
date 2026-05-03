/**
 * @ospex/sdk — public surface.
 *
 * The KeystoreSigner is intentionally NOT re-exported here. Import it
 * via `@ospex/sdk/signers/keystore` so consumers who don't use it
 * don't pay the ethers + scrypt bundle cost.
 */

export { OspexClient, DEFAULT_API_URL } from './client.js';
export type { OspexClientOptions } from './client.js';

export { getAddresses } from './contracts/addresses.js';
export type { OspexAddresses } from './contracts/addresses.js';

export {
  OspexError,
  OspexAPIError,
  OspexConfigError,
  OspexValidationError,
  OspexSigningError,
  OspexAllowanceError,
  OspexChainError,
  OspexScriptApprovalError,
  OspexSubscriptionError,
} from './errors.js';
export type {
  OspexErrorCode,
  OspexScriptApprovalReason,
  OspexSubscriptionReason,
} from './errors.js';

export type {
  // signer
  Hex,
  TypedDataField,
  SignTypedDataArgs,
  SignTransactionArgs,
  Signer,
  // market
  Market,
  MarketSpeculation,
  MarketsListOptions,
  MarketType,
  // commitment
  Commitment,
  CommitmentStatus,
  CommitmentsListOptions,
  // position
  Position,
  PositionTotals,
  PositionStatus,
  PositionStatusTotals,
  ActivePositionView,
  ClaimablePositionView,
  PendingSettlePositionView,
  ClaimParams,
  ClaimParamEntry,
  ClaimParamsTxStep,
  // contest (M4)
  ContestStatus,
  ScriptApproval,
  ApprovedScripts,
  // leaderboard
  LeaderboardEntry,
  // protocol
  ProtocolInfo,
  ProtocolContracts,
  ProtocolFees,
  EIP712Domain,
  PublicConfig,
  Network,
  ChainId,
  // odds
  OddsSnapshot,
  OddsSubscribeArgs,
  OddsSubscribeHandlers,
  Subscription,
} from './types/index.js';
