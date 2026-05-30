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
  OspexSignerResolutionError,
  OspexSubscriptionError,
  OspexStreamError,
  OspexOwnStateError,
} from './errors.js';
export type {
  OspexErrorCode,
  OspexScriptApprovalReason,
  OspexSignerResolutionReason,
  OspexSubscriptionReason,
  OspexStreamReason,
  OspexOwnStateReason,
} from './errors.js';

// Typed PositionModule revert classifiers — decode a caught claim error
// against the contract's custom-error selectors without parsing message
// strings. `isAlreadyClaimedRevert` is the benign/idempotent signal
// `ensurePositionClaimed` recovers on; `isNotSettledRevert` /
// `isNoPayoutRevert` are genuine failures (the CLI uses the former to
// point users at `ospex settle`).
export {
  isAlreadyClaimedRevert,
  isNotSettledRevert,
  isNoPayoutRevert,
} from './positions/positionErrors.js';

export type {
  // signer
  Hex,
  TypedDataField,
  SignTypedDataArgs,
  SignTransactionArgs,
  Signer,
  // contest
  Contest,
  ContestUpdate,
  ContestStatus,
  ContestsListOptions,
  Speculation,
  SpeculationDetail,
  SpeculationParentContext,
  SpeculationsListOptions,
  ScriptApproval,
  ApprovedScripts,
  // fills
  Fill,
  // streams
  StreamStatus,
  StreamSubscribeHandlers,
  CommitmentsSubscribeFilters,
  PositionsSubscribeFilters,
  FillsSubscribeFilters,
  SpeculationsSubscribeFilters,
  ContestsSubscribeFilters,
  // commitment
  Commitment,
  PublicVisibleCommitment,
  PublicHiddenCommitment,
  SignedCommitmentPayload,
  CommitmentStatus,
  StoredCommitmentStatus,
  CommitmentsListOptions,
  CommitmentFillability,
  MakerFundingStatus,
  // own-state (owner-auth maker view)
  OwnerCommitment,
  OwnerPosition,
  OwnerStateSnapshot,
  PositionLifecycle,
  PositionStatusEvent,
  OwnerStateSubscribeHandlers,
  OwnerStateSubscribeStatus,
  OwnerStateResyncReason,
  OwnerStateDegradedReason,
  OwnStateSubscribeOptions,
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
  Network,
  ChainId,
  // odds
  ContestOddsSnapshot,
  MarketType,
  MoneylineOdds,
  OddsForMarket,
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
  // agent envelope (schemaVersion: 2)
  AgentEnvelope,
  AgentFailureEnvelope,
  AgentStage,
  WalletRole,
  ApprovalRequirement,
  AgentApprovalPurpose,
  AgentApprovalSpenderLabel,
  EstimatedCosts,
  AgentUsdcFee,
  AgentLinkFee,
  AgentPayout,
  AgentWarning,
  AgentWarningCode,
  AgentWarningSeverity,
  AgentBlockingCapability,
  AgentError,
  AgentErrorCauseEntry,
  AgentEffect,
  AgentEffectType,
  AgentEffectStatus,
  AgentNextCommand,
  AgentNextCommandIntent,
} from './types/index.js';

export { isVisibleCommitment, isHiddenCommitment } from './types/index.js';

// Own-state method option types — siblings of the public `OwnerCommitment` /
// `OwnerStateSnapshot` types. Re-exported from the root so a consumer
// writing helper wrappers around `client.ownState.{snapshot, getCommitment}`
// can name the argument shapes without reaching into subpath modules.
export type {
  OwnStateSnapshotOptions,
  OwnStateGetCommitmentOptions,
} from './ownState/index.js';

// Resolver-layer surface — preview model + high-level submit args + the
// resolver primitives. CLI and external agents render text from
// SubmitPreview; the CLI's --json emits a v2 AgentEnvelope wrapping it (see
// docs/AGENT_CONTRACT.md). SubmitPreviewEnvelope / SubmitJsonResult are
// @deprecated legacy pre-v2 wire types (exported for back-compat only).
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
  PreviewExpiry,
  PreviewRaw,
  ApprovalPurpose,
  PreviewApproval,
  PreviewOutcome,
  PerspectiveAmount,
  PerspectiveOdds,
  PreviewYou,
  PreviewCounterparty,
  ExpirySource,
  ResolutionSource,
  SideRole,
  SpeculationMode,
  SpeculationCreationFeeSummary,
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
export {
  buildMatchPreview,
} from './commitments/buildMatchPreview.js';
export {
  computeTakerView,
  type TakerView,
  type TakerViewContext,
} from './commitments/takerView.js';
export {
  buildBackingLabel,
  buildPerspectiveAmount,
  buildPerspectiveOdds,
  buildPreviewCounterparty,
  buildPreviewYou,
  invertSideRole,
  inverseOddsTick,
  sideRoleFor,
  type BuildBackingLabelArgs,
  type BuildCounterpartyArgs,
  type BuildPerspectiveArgs,
} from './commitments/perspectiveView.js';
export {
  buildPreviewOutcomes,
  type BuildOutcomesArgs,
} from './commitments/outcomeView.js';
export {
  computeMatchYouView,
  computeSubmitYouView,
  type MatchYouView,
  type SubmitYouView,
} from './commitments/youView.js';
export {
  MIN_PREFIX_HEX_LEN,
  PAGE_LIMIT,
} from './commitments/resolveByPrefix.js';
export type {
  PrepareMatchArgs,
  ResolveByPrefixOptions,
  StatusFilter,
  CheckCommitmentFillabilityArgs,
  CheckCommitmentFillabilityResult,
  FillabilityOutcome,
  FillabilityReason,
  FillabilityReasonCode,
  FillabilityFill,
  CheckSubmitFundabilityArgs,
  CheckSubmitFundabilityResult,
  SubmitFundabilityOutcome,
  SubmitFundabilityReason,
  SubmitFundabilityReasonCode,
  SubmitFundabilityRequirement,
} from './commitments/index.js';

// Match-flow preview model — parallels SubmitPreview but for the taker
// side. CLI and agents render `MatchPreview`; the CLI's --json emits a v2
// AgentEnvelope wrapping it (see docs/AGENT_CONTRACT.md). MatchPreviewEnvelope /
// MatchJsonResult are @deprecated legacy pre-v2 wire types (back-compat only).
export type {
  MatchPreview,
  MatchPreviewEnvelope,
  MatchJsonResult,
  MatchPreviewWarning,
  MatchPreviewContest,
  MatchPreviewMarket,
  MatchPreviewSide,
  MatchPreviewOdds,
  MatchPreviewEconomics,
  MatchPreviewExpiry,
  MatchPreviewSpeculation,
  LazyCreationFee,
  BuildMatchPreviewArgs,
} from './types/matchPreview.js';

// Approvals snapshot — used by `ospex approvals show`, `ospex doctor`,
// and any consumer that needs a readiness view of the configured
// wallet's USDC + LINK allowances against Ospex modules.
export type {
  AllowanceEntry,
  ApprovalSpender,
  ApprovalsSnapshot,
  LinkAllowances,
  ReadApprovalsArgs,
  UsdcAllowances,
} from './approvals/index.js';

// Balances snapshot — wallet-centric POL / USDC / LINK reads. Pairs
// with the approvals snapshot for `ospex doctor`'s readiness view.
export type { BalancesSnapshot, ReadBalancesArgs } from './balances/index.js';
