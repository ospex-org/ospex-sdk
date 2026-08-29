import { z } from 'zod';
import type { ApiClient } from './client.js';
import type {
  Commitment,
  CommitmentsListOptions,
  PublicHiddenCommitment,
  PublicVisibleCommitment,
  StoredCommitmentStatus,
} from '../types/commitment.js';
import type { CommitmentsListBody, CommitmentWireBody } from './types.js';
import type { Hex } from '../types/signer.js';
import { OspexValidationError } from '../errors.js';
import { UINT256_STRING, resolveStoredStatus } from '../wireSchema.js';

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/* ── wire schema: the commitment decode boundary ──────────────────────────
 *
 * One schema for the commitment wire body, used wherever a commitment is
 * decoded through a validated boundary. Today that is the orderbook embedded
 * in `contests.get` and `speculations.get`; `commitments.list` / `.get` and
 * the commitment stream frame are still the pre-rule cast+copy and are
 * candidates for their own boundary (see CLAUDE.md's coverage state).
 *
 * core-api projects EVERY public commitment surface through one mapper
 * (`rowToBody` / `commitmentRowToPublicBody`), so one schema is right here —
 * an orderbook entry has the same wire shape as a `/v1/commitments` row.
 *
 * Types, not content — with two deliberate exceptions, and the distinction
 * is the public type rather than taste:
 *
 *   - Where the public SDK type declares a plain `string` (`source`,
 *     `network`), so does the schema, even though core-api bounds both with
 *     a CHECK/enum. An enum here would be a content rule that fails a whole
 *     page on one row.
 *   - Where the public type declares a UNION (`status`, `storedStatus`,
 *     `marketType`, `positionType`), the schema is that union — because a
 *     value outside it landing in `Commitment.status` IS the defect this
 *     boundary exists to catch, not a stylistic tightening. The bound this
 *     buys: on the two endpoints guarded today, core-api's own query filters
 *     admit only `status in ('open','partially_filled')` rows, so the enums
 *     refuse nothing either endpoint can serve. Note core-api types
 *     `deriveEffectiveStatus`'s return as a bare `string` so an unrecognised
 *     STORED value passes through unchanged; reaching that path requires a
 *     row violating `commitments_status_check`, and such a row would make
 *     `Commitment.status` a lie either way. Re-check this bound before
 *     reusing the schema on `/v1/commitments`, which serves rows these
 *     filters exclude (`includeExpired`, `includeInvalidated`).
 *
 * No `.min(1)` and no `.datetime()`: `expiry` / `createdAt` are passed
 * through from PostgREST verbatim, so they carry the `+00:00` microsecond
 * form that zod v3's Z-only `.datetime()` refuses.
 *
 * The four uint256 amounts ARE content-guarded, and that is the repo rule's
 * own stated exception rather than a departure from it: something downstream
 * coerces them. Measured before the guard existed, against the built SDK — a
 * `remainingRiskAmount` of `'not-decimal'` escaped `computeIsLive`'s
 * `BigInt(...)` as a raw `SyntaxError`, not an `OspexValidationError`, and
 * `riskAmount` / `filledRiskAmount` / `nonce` were published verbatim into
 * fields the public type documents as BigInt-parseable. The own-state
 * commitment body already guards the same four for the same reason; the rule
 * is shared from `wireSchema.ts` rather than copied.
 *
 * These refuse nothing core-api can serve: it builds the first three with
 * `BigInt(...).toString()`, so a value PostgREST rendered in a form `BigInt`
 * cannot read would have thrown server-side first — which bounds `nonce` too,
 * since it comes from a column of the same `numeric(78,0)` type.
 */

/** Advisory maker-funding block — `?includeFillability=true` only. */
const CommitmentFillabilitySchema = z.object({
  advisory: z.literal(true),
  makerFundingStatus: z.enum(['fully_backed', 'overcommitted', 'unknown', 'stale']),
  orderIndividuallyBackedNow: z.boolean().nullable(),
  makerBookBackedNow: z.boolean().nullable(),
  makerBackingWei6: z.string().nullable(),
  makerVisibleCommittedWei6: z.string().nullable(),
  makerCoverageRatioBps: z.number().nullable(),
  checkedAtBlock: z.string().nullable(),
  stale: z.boolean(),
});

/** Raw indexer/relay status, before effective-status derivation. */
const STORED_STATUSES = ['open', 'partially_filled', 'filled', 'cancelled'] as const;
/** Effective status — the stored set plus the time-derived `expired`. */
const EFFECTIVE_STATUSES = ['open', 'partially_filled', 'filled', 'cancelled', 'expired'] as const;

/**
 * A publicly visible commitment (`book_visible=true`) — the full matchable
 * payload.
 *
 * `redacted` is `.optional()` because core-api NEVER sends it on a full
 * body: `rowToBody` emits no such key, and only the redaction projection
 * adds it, as `true`. So an absent flag is the ordinary shape rather than a
 * back-compat allowance, and an explicit `false` is accepted for any
 * producer that chooses to be explicit. (`bookVisible` and `storedStatus`
 * are the genuine back-compat pair — builds predating the M2 own-state
 * migration omit the first, builds predating effective-status the second;
 * the current build always sends both.)
 *
 * `bookVisible` is `z.boolean()` rather than `z.literal(true)` because
 * core-api types the field `boolean` on the full body: under the
 * `REDACT_HIDDEN_PUBLIC=false` deploy-window rollback a hidden row renders as
 * a full body carrying `false`.
 */
const VisibleCommitmentSchema = z.object({
  redacted: z.literal(false).optional(),
  commitmentHash: z.string(),
  maker: z.string(),
  contestId: z.string().nullable(),
  scorer: z.string().nullable(),
  lineTicks: z.number().nullable(),
  positionType: z.union([z.literal(0), z.literal(1)]).nullable(),
  oddsTick: z.number().nullable(),
  marketType: z.enum(['moneyline', 'spread', 'total']).nullable(),
  riskAmount: UINT256_STRING,
  filledRiskAmount: UINT256_STRING,
  remainingRiskAmount: UINT256_STRING,
  nonce: UINT256_STRING,
  expiry: z.string().nullable(),
  speculationKey: z.string().nullable(),
  signature: z.string().nullable(),
  status: z.enum(EFFECTIVE_STATUSES),
  storedStatus: z.enum(STORED_STATUSES).optional(),
  source: z.string(),
  network: z.string(),
  nonceInvalidated: z.boolean(),
  bookVisible: z.boolean().optional(),
  createdAt: z.string(),
  // Enumerated even though neither orderbook embed can carry it — core-api
  // attaches `fillability` only on `/v1/commitments?includeFillability=true`.
  // It is here because `toVisibleCommitment` SPREADS the wire body onto the
  // public type, so an unenumerated key is silently dropped rather than
  // refused: leaving it out would make `Commitment.fillability` vanish the
  // day this schema is reused on the list endpoint. Optional, so it refuses
  // nothing.
  fillability: CommitmentFillabilitySchema.optional(),
});

/**
 * A redacted hidden commitment (`book_visible=false`) — exactly the twelve
 * keys of core-api's PUBLIC_HIDDEN_ALLOWLIST. Everything in
 * `matchCommitment`'s struct is absent by construction.
 *
 * Reachable on `speculations.get`, whose orderbook is typed as the union and
 * surfaces such a row redacted. NOT reachable on `contests.get`, which drops
 * a redacted row instead (it has no `speculationKey` to group on).
 */
const HiddenCommitmentSchema = z.object({
  redacted: z.literal(true),
  payloadAvailable: z.literal(false),
  commitmentHash: z.string(),
  maker: z.string(),
  contestId: z.string().nullable(),
  positionType: z.union([z.literal(0), z.literal(1)]).nullable(),
  status: z.enum(EFFECTIVE_STATUSES),
  storedStatus: z.enum(STORED_STATUSES),
  filledRiskAmount: UINT256_STRING,
  expiry: z.string().nullable(),
  bookVisible: z.literal(false),
  nonceInvalidated: z.boolean(),
});

/**
 * The union any public anonymous commitment read can serve.
 *
 * `discriminatedUnion`, not `union`, and the difference is the error message:
 * measured on zod 3.25.76, a failed `z.union` reports `invalid_union` with an
 * EMPTY issue path, so `parseWire` would surface `field: 'orderbook.3'` — the
 * row but not the field. The discriminated form keeps the precise path
 * (`orderbook.3.maker`). It accepts an ABSENT `redacted` key against the
 * optional literal on the visible arm, which is what makes it usable here at
 * all.
 */
export const CommitmentWireSchema = z
  .discriminatedUnion('redacted', [HiddenCommitmentSchema, VisibleCommitmentSchema])
  /**
   * The one cross-field invariant on this body, and it is here rather than in
   * the mapper because the mapper is where it used to be — as a cast.
   *
   * `storedStatus` may be omitted (a core-api predating effective-status), and
   * `toCommitment` then reads the raw lifecycle off `status`. That fallback is
   * only sound while `status` holds a value that CAN be stored: `'expired'` is
   * derived, never written by any writer, and a build old enough to omit
   * `storedStatus` never derived it. The combination is therefore a shape no
   * build produces — and it was silently publishing `storedStatus: 'expired'`
   * into a field the public type declares as four values, measured against the
   * built SDK.
   *
   * Refusing it at the boundary is what makes `resolveStoredStatus` total
   * instead of asserted, and it names the field rather than the row.
   */
  .superRefine((body, ctx) => {
    if (body.redacted === true) return; // the hidden arm requires `storedStatus`
    if (body.storedStatus === undefined && body.status === 'expired') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['storedStatus'],
        message:
          'an effective status of `expired` requires `storedStatus`: `expired` is derived, ' +
          'never stored, so no raw lifecycle can be recovered from it',
      });
    }
  });

type VisibleCommitmentWire = z.infer<typeof VisibleCommitmentSchema>;
type HiddenCommitmentWire = z.infer<typeof HiddenCommitmentSchema>;
/**
 * The commitment shape {@link toCommitment} reads. Derived from the schema, so
 * a schema field that stops matching what the mapper copies into the public
 * {@link Commitment} is a compile error rather than a silent widening. The
 * hand-written `CommitmentBody` / `CommitmentHiddenBody` in `./types.js`
 * remain for the decode paths that have no boundary yet; both are assignable
 * to this type, so those callers are unaffected.
 */
export type CommitmentWire = z.infer<typeof CommitmentWireSchema>;

export class CommitmentsApi {
  constructor(private readonly client: ApiClient) {}

  async list(options: CommitmentsListOptions = {}): Promise<Commitment[]> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (options.maker !== undefined) query.maker = options.maker;
    if (options.scorer !== undefined) query.scorer = options.scorer;
    if (options.contestId !== undefined) query.contestId = String(options.contestId);
    if (options.speculationId !== undefined) query.speculationId = String(options.speculationId);
    if (options.status !== undefined) {
      query.status = Array.isArray(options.status) ? options.status.join(',') : options.status;
    }
    if (options.includeInvalidated !== undefined) {
      query.includeInvalidated = options.includeInvalidated;
    }
    if (options.includeExpired !== undefined) {
      query.includeExpired = options.includeExpired;
    }
    if (options.includeFillability !== undefined) {
      query.includeFillability = options.includeFillability;
    }
    if (options.limit !== undefined) query.limit = options.limit;
    if (options.offset !== undefined) query.offset = options.offset;
    const body = await this.client.request<CommitmentsListBody>('/v1/commitments', { query });
    return body.commitments.map(toCommitment);
  }

  /**
   * Single-row fetch by EIP-712 hash. Lowercases on the wire (the
   * server normalizes anyway, but consistency keeps logs tidy).
   * Returns the public discriminated union {@link Commitment}; a redacted
   * body (`book_visible=false` for an anonymous caller) decodes to
   * {@link PublicHiddenCommitment} — narrow on `redacted` / `visibility`
   * before reading matchable fields. Throws OspexAPIError on 404,
   * OspexValidationError on a malformed hash.
   */
  async get(hash: Hex): Promise<Commitment> {
    if (!HASH_PATTERN.test(hash)) {
      throw new OspexValidationError(
        'commitments.get hash must be a 0x-prefixed 32-byte hex string.',
        { field: 'hash' },
      );
    }
    const body = await this.client.request<CommitmentWireBody>(
      `/v1/commitments/${hash.toLowerCase()}`,
    );
    return toCommitment(body);
  }
}

/**
 * Wire body → public {@link Commitment} discriminated union. Branches on the
 * core-api M2 `redacted` discriminant: a `true` value yields
 * {@link PublicHiddenCommitment} (matchable payload suppressed); a `false` /
 * `undefined` value yields {@link PublicVisibleCommitment} with the `isLive`
 * predicate computed at decode time. The undefined-fallback handles core-api
 * builds predating M2 — those emit the legacy visible-only shape with no flag,
 * and the SDK treats their bodies as visible by default.
 *
 * Exported (vs file-local) so other API mappers — orderbooks embedded in
 * contest detail responses, the body returned by `match`, the canonical row
 * returned by `submit` — go through the same code path. Visible bodies always
 * carry the same decoded shape regardless of source.
 *
 * `storedStatus` falls back to `status` for back-compat: a core-api build
 * predating effective-status omits `storedStatus` on the wire, so an SDK
 * pointed at an older API still yields a defined value (equal to `status`)
 * rather than `undefined`.
 */
export function toCommitment(body: CommitmentWire): Commitment {
  if (body.redacted === true) return toHiddenCommitment(body);
  return toVisibleCommitment(body);
}

function toVisibleCommitment(body: VisibleCommitmentWire): PublicVisibleCommitment {
  // Strip the wire-only discriminants that don't belong on the public type, then
  // re-tag with the canonical narrow-ready fields. `fillability` comes out of
  // the spread as well: the schema infers it as `?: T | undefined`, and under
  // `exactOptionalPropertyTypes` that is not assignable to the public type's
  // `?: T`. Copying it conditionally is the same guarded-copy idiom the other
  // mappers use, and it keeps an absent key absent.
  const { redacted: _redacted, bookVisible: _bookVisible, fillability, ...rest } = body;
  // Resolved ONCE and shared with the liveness predicate, which needs the same
  // raw lifecycle: two independent `?? status` fallbacks are two chances to
  // disagree. `resolveStoredStatus` refuses the combination the fallback cannot
  // express rather than casting through it — see its docblock.
  const storedStatus = resolveStoredStatus(body);
  const out: PublicVisibleCommitment = {
    ...rest,
    visibility: 'visible',
    redacted: false,
    storedStatus,
    isLive: computeIsLive(body, storedStatus),
  };
  if (fillability !== undefined) out.fillability = fillability;
  return out;
}

function toHiddenCommitment(body: HiddenCommitmentWire): PublicHiddenCommitment {
  return {
    visibility: 'hidden',
    redacted: true,
    payloadAvailable: false,
    commitmentHash: body.commitmentHash,
    maker: body.maker,
    contestId: body.contestId,
    positionType: body.positionType,
    status: body.status,
    storedStatus: body.storedStatus,
    filledRiskAmount: body.filledRiskAmount,
    expiry: body.expiry,
    bookVisible: false,
    nonceInvalidated: body.nonceInvalidated,
  };
}

/**
 * Mirrors the contract's matchCommitment preconditions:
 *   1. The RAW on-chain lifecycle (`storedStatus`) is 'open' or 'partially_filled'
 *      (both have remaining maker risk and weren't cancelled on chain) — NOT the
 *      effective `status`. The core API folds book-visibility into effective status:
 *      a *book-hidden* commitment (pulled from the orderbook off-chain, but whose
 *      signed payload is still matchable on chain) reads effective `status:
 *      'cancelled'`. `matchCommitment` does NOT check book-visibility, so that row is
 *      still live — keying off `storedStatus` keeps `isLive` true for it. Falls back to
 *      `status` when `storedStatus` is absent: a core-api predating effective status
 *      returns the raw value as `status` and had no book-visibility split.
 *   2. nonce ≥ s_minNonces[maker][specKey] (i.e. not flagged
 *      `nonceInvalidated` by the indexer's MIN_NONCE_UPDATED projection).
 *   3. remainingRiskAmount > 0. A 'partially_filled' row with zero
 *      remaining shouldn't exist (the indexer should flip to 'filled'),
 *      but the contract reverts on zero remaining anyway — be defensive.
 *   4. expiry is in the future. The contract reverts with
 *      MatchingModule__CommitmentExpired otherwise. Null expiry only
 *      appears on legacy / indexer-only rows that aren't matchable.
 */
function computeIsLive(body: VisibleCommitmentWire, lifecycle: StoredCommitmentStatus): boolean {
  // Raw on-chain lifecycle, NOT the effective `status` (which folds in book-visibility —
  // a book-hidden but on-chain-matchable row reads effective 'cancelled'). See precondition 1.
  // Passed in rather than re-derived: the caller already resolved it, and a
  // second `?? status` fallback here could disagree with the one published.
  if (lifecycle !== 'open' && lifecycle !== 'partially_filled') return false;
  if (body.nonceInvalidated) return false;
  if (BigInt(body.remainingRiskAmount) <= 0n) return false;
  if (body.expiry === null) return false;
  const expiryMs = Date.parse(body.expiry);
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return false;
  return true;
}
