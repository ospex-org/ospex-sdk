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
  ContestOddsSnapshot,
  MarketType,
  MoneylineOdds,
  OddsSnapshot,
  OddsSubscribeArgs,
  OddsSubscribeHandlers,
  OddsTimestamps,
  SpreadOdds,
  Subscription,
  TotalOdds,
  // game
  Game,
  GameSport,
  GameStatus,
  GameTeam,
  GameExternalIds,
  GamesListOptions,
} from './types/index.js';

// Resolver-layer surface (PR A) — preview model + high-level submit args
// + the resolver primitives. CLI and external agents render text from
// SubmitPreview; --json emits SubmitPreviewEnvelope / SubmitJsonResult.
export type {
  SubmitPreview,
  SubmitPreviewEnvelope,
  SubmitJsonResult,
  HighLevelSubmitArgs,
  SubmitParent,
  PreviewContest,
  PreviewMarket,
  PreviewSide,
  PreviewEconomics,
  PreviewRaw,
  PreviewApproval,
  PreviewOutcome,
  ResolutionSource,
  SideRole,
  SpeculationMode,
  OutcomeResult,
} from './types/preview.js';

export {
  americanOddsToTick,
  decimalOddsToTick,
  parseOddsInput,
  tickToAmericanOdds,
  tickToDecimalOdds,
  usdcDecimalToWei6,
  wei6ToDecimalUSDC,
  lineDecimalToTicks,
  ticksToDecimalLine,
} from './commitments/decimals.js';
export { pushPossible } from './commitments/pushPossible.js';
export {
  resolveSide,
  type TeamAlias,
  type ContestContextForResolve,
  type ResolveSideResult,
} from './commitments/resolveSide.js';
export {
  buildSubmitPreview,
  type BuildSubmitPreviewArgs,
} from './commitments/buildSubmitPreview.js';
