/**
 * Internal API response types. Mirror what `ospex-core-api` returns
 * over the wire — kept out of the public surface so we can re-shape
 * them at the SDK boundary without breaking SDK consumers. Refresh
 * when the API contract changes.
 */

import type {
  CommitmentStatus,
  StoredCommitmentStatus,
  CommitmentFillability,
} from '../types/commitment.js';
import type { ChainId, Network } from '../types/protocol.js';

export interface ApiErrorBody {
  error: string;
  code?: string;
}

export interface PaginationBody {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface HealthBody {
  ok: true;
  service: 'ospex-core-api';
  network: Network;
  chainId: ChainId;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ProtocolInfoBody {
  name: 'Ospex';
  network: Network;
  chainId: ChainId;
  contracts: {
    matchingModule: string | null;
    scorers: { moneyline: string; spread: string; total: string } | null;
  };
  supportedSports: string[];
  fees: { platformFeePct: number; description: string };
}

/**
 * Wire body for the EIP-712 challenge minted by `POST /v1/auth/stream-challenge`
 * (own-state SSE plan §3.2). Mirrors `StreamChallenge` in
 * `ospex-core-api/src/lib/streamAuth.ts` byte-for-byte. The SDK passes this
 * structure VERBATIM back to the server on `POST /v1/auth/stream-token`; any
 * field mutation (including a one-second `expiresAt` shift) fails the
 * `tampered` consume check on the server. The SDK BigInt-coerces the
 * `network.chainId` / `issuedAt` / `expiresAt` fields before signing in
 * `ownState/auth.ts`; the over-the-wire form keeps them as `number` so
 * round-trip JSON equality holds with what the server emitted.
 */
export interface StreamChallenge {
  address: string;
  resource: 'own-state';
  scope: 'read:own-state';
  network: { chainId: number };
  audience: string;
  challengeId: string;
  issuedAt: number;
  expiresAt: number;
}

/** Wire body for `POST /v1/auth/stream-challenge`. */
export interface StreamChallengeResponseBody {
  challenge: StreamChallenge;
  expiresAt: number;
}

/** Wire body for `POST /v1/auth/stream-token`. */
export interface StreamTokenResponseBody {
  /** Opaque bearer token. Caller MUST send back as `Authorization: Bearer <token>` on subsequent owner-auth requests; never log it. */
  token: string;
  /** Unix-seconds absolute expiry. Refresh ~1-2 min before this value. */
  expiresAt: number;
}

/**
 * Wire body for a single commitment in the owner-authenticated `/v1/own-state/snapshot`
 * response. Mirrors `CommitmentBody` (full payload) but allows `bookVisible: false` —
 * the snapshot helper bypasses public redaction and serves the maker's full payload
 * regardless of `book_visible`. Decoded into {@link OwnerCommitment} by `toOwnerCommitment`.
 */
export interface OwnerCommitmentBody {
  commitmentHash: string;
  maker: string;
  contestId: string | null;
  scorer: string | null;
  lineTicks: number | null;
  positionType: 0 | 1 | null;
  oddsTick: number | null;
  marketType: 'moneyline' | 'spread' | 'total' | null;
  riskAmount: string;
  filledRiskAmount: string;
  remainingRiskAmount: string;
  nonce: string;
  expiry: string | null;
  speculationKey: string | null;
  signature: string | null;
  status: CommitmentStatus;
  storedStatus?: StoredCommitmentStatus;
  source: string;
  network: string;
  nonceInvalidated: boolean;
  /** May be `true` (still on the public book) or `false` (off-chain hidden). */
  bookVisible?: boolean;
  createdAt: string;
  // ── PR0b owner-state enrichment (§3.1) ──────────────────────────────────
  speculationId: string | null;
  sport: string;
  awayTeam: string;
  homeTeam: string;
  updatedAtUnixSec: number;
  signedPayload: SignedCommitmentPayloadBody | null;
}

/**
 * Wire shape of the canonical signed payload carried on owner commitments
 * (PR0b §3.1). bigint EIP-712 struct fields (`contestId` / `riskAmount` /
 * `nonce` / `expiry`) are decimal strings on the wire; `toOwnerCommitment`
 * coerces them to bigint to produce the SDK's `SignedCommitmentPayload`.
 */
export interface SignedCommitmentPayloadBody {
  commitmentHash: string;
  commitment: {
    maker: string;
    contestId: string;
    scorer: string;
    lineTicks: number;
    positionType: 0 | 1;
    oddsTick: number;
    riskAmount: string;
    nonce: string;
    expiry: string;
  };
  signature: string;
}

/** Wire body for an owner-auth position row. Discriminated by `status`. */
interface OwnerPositionBaseBody {
  positionId: string;
  speculationId: string;
  positionType: 0 | 1;
  team: string;
  opponent: string;
  market: 'moneyline' | 'spread' | 'total';
  oddsDecimal: number | null;
  riskAmountUSDC: number;
  profitAmountUSDC: number;
  // ── PR0b owner-state enrichment (§3.2) ──────────────────────────────────
  contestId: string;
  sport: string;
  awayTeam: string;
  homeTeam: string;
  riskAmountWei6: string;
  counterpartyRiskWei6: string;
  updatedAtUnixSec: number;
}

export type OwnerPositionBody =
  | (OwnerPositionBaseBody & { status: 'active' })
  | (OwnerPositionBaseBody & {
      status: 'pendingSettle';
      result: 'won' | 'push' | 'void';
      predictedWinSide: 'away' | 'home' | 'over' | 'under' | 'push';
      estimatedPayoutUSDC: number;
      estimatedPayoutWei6: string;
    })
  | (OwnerPositionBaseBody & {
      status: 'claimable';
      result: 'won' | 'push' | 'void';
      estimatedPayoutUSDC: number;
      estimatedPayoutWei6: string;
    })
  | (OwnerPositionBaseBody & {
      status: 'claimed';
      claimedAt: string | null;
    });

/** Wire body for `GET /v1/own-state/snapshot?cursor=`. */
export interface OwnerStateSnapshotBody {
  cursor: string;
  commitments: OwnerCommitmentBody[];
  positions: OwnerPositionBody[];
  truncated: boolean;
  positionsTruncated: boolean;
}

/** Wire body for `GET /v1/health/own-state` (PR0b §3.3 — indexer-lag probe). */
export interface OwnStateHealthBody {
  indexerLagSeconds: number;
  lastIndexedAt: string;
  lagSource: string;
}

export interface AuthDomainBody {
  domain: {
    name: string;
    version: string;
    chainId: ChainId;
    verifyingContract: string;
  };
  network: Network;
  actions: Record<string, Array<{ name: string; type: string }>>;
  requestFormat: {
    description: string;
    endpoints: Record<string, string>;
    example: { action: Record<string, unknown>; signature: string };
  };
}

/**
 * Wire body for a publicly visible commitment (`book_visible=true`). Carries the
 * full matchable payload (signature, EIP-712 fields). The `redacted` discriminant
 * is optional because NO build sends it on a full body: core-api's `rowToBody`
 * emits no such key and only the redaction projection adds one, as `true`. So an
 * absent flag is the ordinary visible shape rather than a back-compat allowance,
 * and `toCommitment` treats the absence as visible.
 */
export interface CommitmentBody {
  /** Discriminator — ABSENT on every full body core-api serves; interpreted as
   *  visible. Declared so a producer that states it explicitly still decodes. */
  redacted?: false;
  commitmentHash: string;
  maker: string;
  contestId: string | null;
  scorer: string | null;
  lineTicks: number | null;
  positionType: 0 | 1 | null;
  oddsTick: number | null;
  marketType: 'moneyline' | 'spread' | 'total' | null;
  riskAmount: string;
  filledRiskAmount: string;
  remainingRiskAmount: string;
  nonce: string;
  expiry: string | null;
  speculationKey: string | null;
  signature: string | null;
  /** EFFECTIVE status — folds in time-expiry + nonce invalidation. */
  status: CommitmentStatus;
  /**
   * Raw indexer/relay status. Optional on the wire for back-compat with
   * core-api builds that predate effective-status (older deploys omit it);
   * `toCommitment` falls back to `status` in that case.
   */
  storedStatus?: StoredCommitmentStatus;
  source: string;
  network: string;
  nonceInvalidated: boolean;
  /** Optional on the wire — builds predating M2 omit it. Note core-api types the
   *  field `boolean`, not `true`: under its `REDACT_HIDDEN_PUBLIC=false`
   *  deploy-window rollback a hidden row renders as a full body carrying `false`.
   *  The zod boundary in `api/commitments.ts` mirrors the wider server type; this
   *  hand-written declaration is the narrower one the unguarded paths still use. */
  bookVisible?: true;
  createdAt: string;
  /** Advisory maker-funding fillability — present only when the list was
   *  requested with `includeFillability=true`. Flows through `toCommitment`'s
   *  spread to the public `Commitment.fillability`. */
  fillability?: CommitmentFillability;
}

/**
 * Wire body for a redacted public hidden commitment (`book_visible=false`) as
 * emitted by core-api M2 of the own-state SSE migration stack. Mirrors
 * `CommitmentHiddenBody` in `ospex-core-api/src/v1/commitments.ts` and the
 * PUBLIC_HIDDEN_ALLOWLIST locked in own-state-sse-plan.md §2.3 — the matchable
 * payload (signature, nonce, riskAmount, oddsTick, scorer, lineTicks,
 * speculationKey, marketType) is intentionally absent. Maker-authenticated
 * reads via owner-auth `client.ownState.*` deliver the full payload back.
 */
export interface CommitmentHiddenBody {
  redacted: true;
  payloadAvailable: false;
  commitmentHash: string;
  maker: string;
  contestId: string | null;
  positionType: 0 | 1 | null;
  status: CommitmentStatus;
  storedStatus: StoredCommitmentStatus;
  filledRiskAmount: string;
  expiry: string | null;
  bookVisible: false;
  nonceInvalidated: boolean;
}

/**
 * Wire union surfaced by any public anonymous commitment read. Decoded by
 * `toCommitment` into the corresponding public {@link Commitment} variant.
 */
export type CommitmentWireBody = CommitmentBody | CommitmentHiddenBody;

/*
 * The contest / speculation wire bodies used to be declared here as
 * `ContestBody`, `ContestsListBody`, `SpeculationBody`,
 * `SpeculationParentContextBody`, `SpeculationDetailBody` and
 * `SpeculationsListBody`. They are gone: those surfaces decode through zod
 * now, and their shapes are declared once, by the schemas beside their
 * boundaries in `api/contests.ts` and `api/speculations.ts`, with the
 * mappers' input types taken from `z.infer`.
 *
 * A hand-written interface beside a schema is not documentation, it is a
 * second declaration that drifts in silence: while one existed for the
 * games bodies and the parsed row was cast to it, widening the schema's
 * `gameId` to `.nullable()` passed `tsc` AND the whole suite, and a `null`
 * reached a field declared `string`. Two of these carried a live instance
 * of the same defect - `SpeculationBody` declared the settlement trio
 * required and `SpeculationParentContextBody` declared both team ids
 * required, while every wire boundary and every fixture treats them as
 * optional. Do not reintroduce them.
 */



export interface CommitmentsListBody {
  /**
   * Each row is either {@link CommitmentBody} (visible / unredacted) or
   * {@link CommitmentHiddenBody} (redacted via the M2 allow-list). The list
   * endpoint applies `book_visible=true` upstream so visible bodies dominate
   * in practice; the `?since=` recovery path is what surfaces hidden bodies
   * (to converge a reconnecting client across the `book_visible=true→false`
   * transition). `toCommitment` discriminates on `redacted` per row.
   */
  commitments: CommitmentWireBody[];
  pagination: PaginationBody;
}

export interface PositionBody {
  speculationId: string;
  positionType: 0 | 1 | null;
  riskAmountUSDC: number;
  profitAmountUSDC: number;
  claimed: boolean;
  positionCreatedAt: string | null;
}

export interface PositionsByAddressBody {
  address: string;
  positions: PositionBody[];
  totals: {
    totalCount: number;
    totalRiskUSDC: number;
    totalProfitUSDC: number;
    activeCount: number;
  };
  pagination: PaginationBody;
}

export interface ActivePositionBody {
  positionId: string;
  speculationId: string;
  positionType: 0 | 1;
  team: string;
  opponent: string;
  market: 'moneyline' | 'spread' | 'total';
  oddsDecimal: number | null;
  riskAmountUSDC: number;
  profitAmountUSDC: number;
}

export interface ClaimablePositionBody extends ActivePositionBody {
  result: 'won' | 'push' | 'void';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
}

export interface PendingSettlePositionBody extends ActivePositionBody {
  /** Predicted result once `settleSpeculation` is called. */
  result: 'won' | 'push' | 'void';
  /** Predicted on-chain winSide once settled. */
  predictedWinSide: 'away' | 'home' | 'over' | 'under' | 'push';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
}

export interface PositionStatusBody {
  address: string;
  active: ActivePositionBody[];
  pendingSettle: PendingSettlePositionBody[];
  claimable: ClaimablePositionBody[];
  totals: {
    activeCount: number;
    pendingSettleCount: number;
    claimableCount: number;
    estimatedPayoutUSDC: number;
    estimatedPayoutWei6: string;
    pendingSettlePayoutUSDC: number;
    pendingSettlePayoutWei6: string;
  };
}

export type ClaimParamsTxStep =
  | {
      method: 'settleSpeculation';
      target: 'SpeculationModule';
      args: { speculationId: string };
    }
  | {
      method: 'claimPosition';
      target: 'PositionModule';
      args: { speculationId: string; positionType: 0 | 1 };
    };

export interface ClaimParamEntryBody {
  positionId: string;
  speculationId: string;
  description: string;
  bucket: 'claimable' | 'pendingSettle';
  result: 'won' | 'push' | 'void';
  estimatedPayoutUSDC: number;
  estimatedPayoutWei6: string;
  /** Ordered: pendingSettle entries lead with `settleSpeculation`,
   * claimable entries are a single `claimPosition` step. */
  txParams: ClaimParamsTxStep[];
}

export interface ClaimParamsResponseBody {
  address: string;
  positions: ClaimParamEntryBody[];
}

export interface PositionByTxFilledEntryBody {
  positionId: string;
  speculationId: string;
  user: string;
  positionType: 0 | 1;
  role: 'maker' | 'taker';
  riskAmount: string;
  riskAmountUSDC: number;
  counterparty: string;
}

export interface PositionByTxResponseBody {
  txHash: string;
  blockNumber: number;
  positions: PositionByTxFilledEntryBody[];
}

export interface ClaimResultResponseBody {
  txHash: string;
  blockNumber: number;
  speculationId: string;
  user: string;
  positionType: 0 | 1;
  payoutUSDC: number;
  payoutWei6: string;
}

export interface LeaderboardEntryBody {
  rank: number;
  address: string;
  declaredBankrollUSDC: number;
}

export interface LeaderboardBody {
  leaderboardId: string;
  startTime: string;
  endTime: string;
  entries: LeaderboardEntryBody[];
  pagination: PaginationBody;
}

/*
 * The `/v1/games` wire bodies are NOT declared here.
 *
 * `GameBody` / `GamesListBody` / `GameTeamBody` / `GameExternalIdsBody` used
 * to sit at this spot beside the zod schema in `api/games.ts`, and the mapper
 * cast the parsed value to the interface. Two declarations of one shape drift
 * in silence: widening the schema's `gameId` to `z.string().nullable()` passed
 * `tsc` and the whole suite, and a `null` reached `Game.gameId`. The shape now
 * has exactly one declaration — the schema — and the mapper's input is
 * `z.infer` of it. See `api/games.ts`.
 */

/**
 * Wire bodies for `GET /v1/contests/:contestId/odds`. Per-market
 * shapes are explicit so the wire format can't be misread:
 *
 *   - moneyline: per-side American odds. No line field.
 *   - spread:    awayLine + homeLine + per-side American odds. The
 *                writer stores only home spread in current_odds.line;
 *                the server fills awayLine = -homeLine before serving.
 *   - total:     line (threshold) + overOddsAmerican + underOddsAmerican.
 *                The writer's away/home → over/under storage convention
 *                is hidden at the API boundary.
 *
 * The away/home → over/under remapping for `total` happens server-side at the API boundary.
 */
interface OddsTimestampsBody {
  upstreamLastUpdated: string;
  pollCapturedAt: string;
  changedAt: string;
}

export interface MoneylineOddsBody extends OddsTimestampsBody {
  market: 'moneyline';
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

export interface SpreadOddsBody extends OddsTimestampsBody {
  market: 'spread';
  awayLine: number | null;
  homeLine: number | null;
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
}

export interface TotalOddsBody extends OddsTimestampsBody {
  market: 'total';
  line: number | null;
  overOddsAmerican: number | null;
  underOddsAmerican: number | null;
}

export interface ContestOddsBody {
  contestId: string;
  /** Null when the contest has no upstream JSONOdds linkage. */
  jsonoddsId: string | null;
  /** Per-market entries are null when the writer hasn't populated them. */
  odds: {
    moneyline: MoneylineOddsBody | null;
    spread: SpreadOddsBody | null;
    total: TotalOddsBody | null;
  };
}

/**
 * Wire body for one row of `GET /v1/teams/aliases`. Joined through
 * `teams` server-side so consumers get canonical sport + display
 * fields without a second round-trip.
 */
export interface TeamAliasBody {
  teamId: string;
  sport: string;
  sportId: number;
  teamName: string;
  abbrev: string;
  alias: string;
  /**
   * Free-form classification. Real values seen in production:
   * 'short' | 'full' | 'abbreviation' (and others added by ops).
   * The SDK resolver matches against `alias` text regardless of
   * `aliasType` — this field is informational only.
   */
  aliasType: string;
  source: string;
}

/** Wire body for `GET /v1/teams/aliases`. */
export interface TeamAliasesListBody {
  aliases: TeamAliasBody[];
  pagination: PaginationBody;
}
