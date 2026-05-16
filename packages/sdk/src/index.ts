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
} from './errors.js';
export type {
  OspexErrorCode,
  OspexScriptApprovalReason,
  OspexSignerResolutionReason,
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

// Resolver-layer surface — preview model + high-level submit args + the
// resolver primitives. CLI and external agents render text from
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
  MIN_PREFIX_HEX_LEN,
  PAGE_LIMIT,
} from './commitments/resolveByPrefix.js';
export type {
  PrepareMatchArgs,
  ResolveByPrefixOptions,
  StatusFilter,
} from './commitments/index.js';

// Match-flow preview model — parallels SubmitPreview but for the taker
// side. CLI and agents render `MatchPreview`; `--json` emits the
// envelope; `--yes --json` emits the result envelope.
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
