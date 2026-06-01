/**
 * zod schemas for the owner-authenticated own-state wire bodies
 * (`/v1/own-state/snapshot` + the composite `/v1/stream/own-state` event
 * frames). Single source of truth for the structural shape of every
 * own-state wire body; the decoders in `snapshot.ts` are thin wrappers that
 * `parseWire(...)` against these schemas, then apply the wire→public
 * transform (derive `visibility` / `isLive`, `storedStatus` fallback, etc.).
 *
 * Why schemas instead of hand-written field checks: a field declared here is
 * validated wherever the schema is used. There is no per-decoder "did I
 * remember to check this field" enumeration to keep in sync — the structural
 * contract lives in ONE reviewable place per wire type. Discriminated unions
 * (positions) use `z.discriminatedUnion` so a missing/unknown `status` is
 * rejected at the discriminator rather than falling through to `undefined`.
 *
 * Strictness mirrors the wire contract in `api/types.ts`:
 *   - required strings use `.min(1)` (empty string is not "present");
 *   - nullable wire fields use `.nullable()` (key always present, value may
 *     be null), distinct from `.optional()` fields the server may omit
 *     (`storedStatus` on pre-effective-status builds, `bookVisible`);
 *   - the snapshot `positions[]` enum is NARROWER than `PositionLifecycle`:
 *     terminal-lost (`settledLost`) / `void` rows are dropped from the
 *     snapshot and only arrive on `positionStatus` events (spec §6.1), so a
 *     snapshot position carrying one of those is a server contract violation
 *     and is rejected by the discriminated union.
 *
 * Unknown extra keys are stripped (zod default), matching the prior
 * explicit-copy decoders that ignored server fields not on the public type.
 */

import { z } from 'zod';

const POSITION_TYPE = z.union([z.literal(0), z.literal(1)]);
const MARKET_TYPE = z.enum(['moneyline', 'spread', 'total']);
const COMMITMENT_STATUS = z.enum([
  'open',
  'partially_filled',
  'filled',
  'cancelled',
  'expired',
]);
const STORED_COMMITMENT_STATUS = z.enum([
  'open',
  'partially_filled',
  'filled',
  'cancelled',
]);
/** Wider than the snapshot's position discriminator — includes terminal
 *  `settledLost` / `void` that appear only on `positionStatus` events. */
const POSITION_LIFECYCLE = z.enum([
  'active',
  'pendingSettle',
  'claimable',
  'claimed',
  'settledLost',
  'void',
]);
const POSITION_RESULT = z.enum(['won', 'push', 'void']);
const PREDICTED_WIN_SIDE = z.enum(['away', 'home', 'over', 'under', 'push']);
/** A uint256 on the wire — a non-empty decimal string. `.regex` guarantees a
 *  later `BigInt(...)` coercion can't throw on a non-numeric value. */
const UINT256_STRING = z.string().regex(/^\d+$/, 'must be a decimal uint256 string');

/**
 * Wire shape of the canonical signed payload carried on owner commitments
 * (PR0b §3.1 / A6). The EIP-712 struct's bigint fields arrive as decimal
 * strings (JSON has no bigint); the decoder coerces them to bigint to produce
 * the SDK's {@link SignedCommitmentPayload}. Structural-only here — the
 * hash↔struct round-trip is asserted by `cancelOnchainSigned` at cancel time,
 * not at decode time.
 */
export const SignedCommitmentPayloadWireSchema = z.object({
  commitmentHash: z.string().min(1),
  commitment: z.object({
    maker: z.string().min(1),
    contestId: UINT256_STRING,
    scorer: z.string().min(1),
    lineTicks: z.number().int(),
    positionType: POSITION_TYPE,
    oddsTick: z.number().int(),
    riskAmount: UINT256_STRING,
    nonce: UINT256_STRING,
    expiry: UINT256_STRING,
  }),
  signature: z.string().min(1),
});

/**
 * One commitment in the owner-auth snapshot / `commitment` SSE frame. The
 * required-for-identity fields are non-empty strings; the rest pass through
 * once structurally valid. Decoded into the public `OwnerCommitment` (which
 * adds `ownerAuthorized` / `visibility` / `redacted` / `isLive` and folds
 * `storedStatus`) by `toOwnerCommitment`.
 */
export const OwnerCommitmentBodySchema = z.object({
  commitmentHash: z.string().min(1),
  maker: z.string().min(1),
  contestId: z.string().nullable(),
  scorer: z.string().nullable(),
  lineTicks: z.number().int().nullable(),
  positionType: POSITION_TYPE.nullable(),
  oddsTick: z.number().int().nullable(),
  marketType: MARKET_TYPE.nullable(),
  riskAmount: z.string().min(1),
  filledRiskAmount: z.string().min(1),
  remainingRiskAmount: z.string().min(1),
  nonce: z.string().min(1),
  expiry: z.string().nullable(),
  speculationKey: z.string().nullable(),
  signature: z.string().nullable(),
  status: COMMITMENT_STATUS,
  storedStatus: STORED_COMMITMENT_STATUS.optional(),
  source: z.string(),
  network: z.string(),
  nonceInvalidated: z.boolean(),
  bookVisible: z.boolean().optional(),
  createdAt: z.string().min(1),
  // ── PR0b enrichment (§3.1) ──────────────────────────────────────────────
  // `sport` / `awayTeam` / `homeTeam` are plain `z.string()` (NOT `.min(1)`):
  // the server emits `''` when the contest context is unavailable (e.g. a
  // contest row not yet populated), so requiring non-empty would reject a body
  // the server legitimately produces. `speculationId` is null until the
  // commitment's speculation exists. `signedPayload` is null on
  // indexer-discovered (signature-less) rows.
  speculationId: z.string().nullable(),
  sport: z.string(),
  awayTeam: z.string(),
  homeTeam: z.string(),
  updatedAtUnixSec: z.number(),
  signedPayload: SignedCommitmentPayloadWireSchema.nullable(),
});

const ownerPositionBase = {
  positionId: z.string().min(1),
  speculationId: z.string().min(1),
  positionType: POSITION_TYPE,
  team: z.string().min(1),
  opponent: z.string().min(1),
  market: MARKET_TYPE,
  oddsDecimal: z.number().finite().nullable(),
  riskAmountUSDC: z.number().finite(),
  profitAmountUSDC: z.number().finite(),
  // ── PR0b enrichment (§3.2) ──────────────────────────────────────────────
  // `contestId` / `sport` / `awayTeam` / `homeTeam` are plain `z.string()`:
  // `claimed` rows (terminal, recovery-only) emit `''` for these by design.
  // The wei6 fields are always non-empty decimal strings (`BigInt(...).toString()`).
  contestId: z.string(),
  sport: z.string(),
  awayTeam: z.string(),
  homeTeam: z.string(),
  riskAmountWei6: z.string().min(1),
  counterpartyRiskWei6: z.string().min(1),
  updatedAtUnixSec: z.number(),
};

/**
 * Owner-auth snapshot position row, discriminated by `status`. Mirrors the
 * public `OwnerPosition` union; the discriminator is restricted to the four
 * snapshot statuses (terminal-lost / void are not snapshot rows).
 */
export const OwnerPositionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('active'), ...ownerPositionBase }),
  z.object({
    status: z.literal('pendingSettle'),
    ...ownerPositionBase,
    result: POSITION_RESULT,
    predictedWinSide: PREDICTED_WIN_SIDE,
    estimatedPayoutUSDC: z.number().finite(),
    estimatedPayoutWei6: z.string().min(1),
  }),
  z.object({
    status: z.literal('claimable'),
    ...ownerPositionBase,
    result: POSITION_RESULT,
    estimatedPayoutUSDC: z.number().finite(),
    estimatedPayoutWei6: z.string().min(1),
  }),
  z.object({
    status: z.literal('claimed'),
    ...ownerPositionBase,
    claimedAt: z.string().min(1).nullable(),
  }),
]);

/**
 * `positionStatus` SSE frame. `from` / `result` / `claimableAmount` are
 * optional (omitted by the server when not applicable); `result` here is the
 * WIDER set including `'lost'` (vs the snapshot position's won/push/void).
 */
export const PositionStatusEventSchema = z.object({
  address: z.string().min(1),
  speculationId: z.string().min(1),
  positionType: POSITION_TYPE,
  status: POSITION_LIFECYCLE,
  from: POSITION_LIFECYCLE.optional(),
  result: z.enum(['won', 'lost', 'push', 'void']).optional(),
  claimableAmount: z.string().min(1).optional(),
  sourceUpdatedAt: z.string().min(1),
});

/**
 * Top-level snapshot body for `GET /v1/own-state/snapshot` and the inline
 * cold-connect `snapshot` SSE frame. Validates the composite shape AND every
 * leaf in one parse — a malformed `cursor` / `truncated` / inner commitment /
 * inner position all surface as a single `OspexValidationError` at the
 * decode boundary, before any cursor-promotion or REST-paging branch.
 */
export const OwnerStateSnapshotBodySchema = z.object({
  cursor: z.string().min(1),
  commitments: z.array(OwnerCommitmentBodySchema),
  positions: z.array(OwnerPositionSchema),
  truncated: z.boolean(),
  positionsTruncated: z.boolean(),
});

/**
 * `GET /v1/health/own-state` body (PR0b §3.3 / A4) — the indexer-lag probe the
 * stream-health gate polls. `lagSource` is left a free string (not a literal
 * union) so the SDK tolerates the server adding lag sources without a bump.
 */
export const OwnStateHealthSchema = z.object({
  indexerLagSeconds: z.number(),
  lastIndexedAt: z.string().min(1),
  lagSource: z.string().min(1),
});

export type OwnerCommitmentBodyParsed = z.infer<typeof OwnerCommitmentBodySchema>;
export type OwnerStateSnapshotBodyParsed = z.infer<typeof OwnerStateSnapshotBodySchema>;
export type SignedCommitmentPayloadWireParsed = z.infer<typeof SignedCommitmentPayloadWireSchema>;
