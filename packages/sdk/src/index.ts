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
  // contest
  Contest,
  ContestStatus,
  ContestsListOptions,
  Speculation,
  SpeculationDetail,
  SpeculationParentContext,
  SpeculationsListOptions,
  ScriptApproval,
  ApprovedScripts,
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
  MarketType,
  OddsSnapshot,
  OddsSubscribeArgs,
  OddsSubscribeHandlers,
  Subscription,
  // game
  Game,
  GameSport,
  GameStatus,
  GameTeam,
  GameExternalIds,
  GamesListOptions,
} from './types/index.js';
