/**
 * `commitments.resolveByPrefix(input, opts)` — accept either a full
 * EIP-712 hash OR a unique 0x-prefixed hex prefix (≥ 8 hex chars after
 * `0x`) and return the single matching `Commitment`. The CLI uses this
 * to make the truncated hash in `commitments list` actionable
 * downstream (`show`, `match`, `cancel`, `cancel-onchain`).
 *
 * Behavior:
 *   - Full 0x+64hex → `api.get(hash)`. Skips the list path entirely.
 *     If the caller passed a status filter, the row is rejected with
 *     a clear message when its status falls outside the scope.
 *   - 0x + 8..63 hex → `api.list({ ...opts, limit: PAGE_LIMIT })`,
 *     filter `commitmentHash.toLowerCase().startsWith(input)`. Throws
 *     on 0 / >1 / full-page-overflow.
 *   - Anything else → too-short / malformed prefix error.
 *
 * `status: 'any'` expands to ALL statuses + `includeInvalidated: true`
 * + `includeExpired: true`. We never omit `status` — the API defaults
 * to `open,partially_filled` and would silently narrow the search.
 *
 * TODO (follow-up): add a `commitmentHashPrefix` query parameter to
 * `GET /v1/commitments` server-side so the resolver can rely on
 * server-side filtering with deterministic ambiguity detection. Until
 * then, the limit-and-fail-fast strategy below defends against
 * pagination silently missing matches.
 */

import { CommitmentsApi } from '../api/commitments.js';
import { OspexValidationError } from '../errors.js';
import type {
  Commitment,
  CommitmentStatus,
  CommitmentsListOptions,
} from '../types/commitment.js';
import type { CommitmentsContext } from './context.js';
import type { Hex } from '../types/signer.js';

export const MIN_PREFIX_HEX_LEN = 8;
export const PAGE_LIMIT = 1000;

export type StatusFilter = CommitmentStatus[] | 'any';

export interface ResolveByPrefixOptions {
  /**
   * Status scope for the lookup. Defaults to `['open',
   * 'partially_filled']`. Pass `'any'` to resolve cancelled / expired
   * / nonce-invalidated rows too (CLI `commitments show` uses this).
   */
  status?: StatusFilter;
  contestId?: string | number;
  maker?: string;
  scorer?: string;
  speculationId?: string | number;
  includeInvalidated?: boolean;
  includeExpired?: boolean;
}

const FULL_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
// Min prefix is 0x + MIN_PREFIX_HEX_LEN hex chars; max is 0x + 63 (one
// short of a full hash). Stays case-insensitive at parse time but the
// string-compare-during-filter operates on lowercase only.
const PREFIX_RE = new RegExp(`^0x[0-9a-fA-F]{${MIN_PREFIX_HEX_LEN},63}$`);

export async function resolveByPrefix(
  ctx: CommitmentsContext,
  input: string,
  opts: ResolveByPrefixOptions = {},
): Promise<Commitment> {
  if (typeof input !== 'string' || input.length === 0) {
    throw new OspexValidationError(
      'resolveByPrefix: input must be a non-empty 0x-prefixed hex string.',
      { field: 'input' },
    );
  }
  const lowered = input.toLowerCase();
  const api = new CommitmentsApi(ctx.api);

  // Full hash fast path. Apply the status filter post-fetch so the
  // caller's scope still gates the result (a `cancel` command shouldn't
  // claim a cancelled row was "found").
  if (FULL_HASH_RE.test(input)) {
    const commitment = await api.get(lowered as Hex);
    enforceStatusScope(commitment, opts.status, lowered);
    return commitment;
  }

  if (!PREFIX_RE.test(input)) {
    if (input.startsWith('0x') && /^0x[0-9a-fA-F]*$/.test(input)) {
      throw new OspexValidationError(
        `resolveByPrefix: prefix must be 0x followed by at least ${MIN_PREFIX_HEX_LEN} hex chars; got "${input}".`,
        { field: 'input' },
      );
    }
    throw new OspexValidationError(
      `resolveByPrefix: input "${input}" is not a 0x-prefixed hex string. Pass a full 32-byte hash or a unique prefix.`,
      { field: 'input' },
    );
  }

  // ── List path with explicit status expansion. ─────────────────────
  const listOpts: CommitmentsListOptions = { limit: PAGE_LIMIT };
  if (opts.contestId !== undefined) listOpts.contestId = opts.contestId;
  if (opts.maker !== undefined) listOpts.maker = opts.maker;
  if (opts.scorer !== undefined) listOpts.scorer = opts.scorer;
  if (opts.speculationId !== undefined) listOpts.speculationId = opts.speculationId;
  const { status, includeInvalidated, includeExpired } = expandStatusOpts(opts);
  listOpts.status = status;
  if (includeInvalidated !== undefined) listOpts.includeInvalidated = includeInvalidated;
  if (includeExpired !== undefined) listOpts.includeExpired = includeExpired;

  const rows = await api.list(listOpts);
  if (rows.length >= PAGE_LIMIT) {
    throw new OspexValidationError(
      `resolveByPrefix: too many commitments to resolve prefix "${input}" safely; pass the full hash or add filters (--contest-id / --maker / --scorer / --speculation).`,
      { field: 'input' },
    );
  }
  const matches = rows.filter((c) =>
    c.commitmentHash.toLowerCase().startsWith(lowered),
  );
  if (matches.length === 0) {
    throw new OspexValidationError(
      `resolveByPrefix: no commitment matches prefix "${input}" within the requested status scope.`,
      { field: 'input' },
    );
  }
  if (matches.length > 1) {
    const sample = matches
      .slice(0, 5)
      .map((c) => c.commitmentHash)
      .join(', ');
    const more = matches.length > 5 ? `, ... (+${matches.length - 5} more)` : '';
    throw new OspexValidationError(
      `resolveByPrefix: ambiguous prefix "${input}"; matches ${sample}${more}.`,
      { field: 'input' },
    );
  }
  return matches[0]!;
}

// ── Helpers ──────────────────────────────────────────────────────────

const ALL_STATUSES: CommitmentStatus[] = [
  'open',
  'partially_filled',
  'filled',
  'cancelled',
  'expired',
];
const DEFAULT_STATUSES: CommitmentStatus[] = ['open', 'partially_filled'];

interface ExpandedStatusOpts {
  status: CommitmentStatus[];
  includeInvalidated?: boolean;
  includeExpired?: boolean;
}

function expandStatusOpts(opts: ResolveByPrefixOptions): ExpandedStatusOpts {
  if (opts.status === 'any') {
    return {
      status: ALL_STATUSES,
      includeInvalidated: true,
      includeExpired: true,
    };
  }
  const statuses = opts.status ?? DEFAULT_STATUSES;
  const out: ExpandedStatusOpts = { status: statuses };
  if (opts.includeInvalidated !== undefined) out.includeInvalidated = opts.includeInvalidated;
  if (opts.includeExpired !== undefined) out.includeExpired = opts.includeExpired;
  return out;
}

function enforceStatusScope(
  commitment: Commitment,
  filter: StatusFilter | undefined,
  loweredInput: string,
): void {
  if (filter === undefined || filter === 'any') return;
  if (filter.includes(commitment.status)) return;
  throw new OspexValidationError(
    `resolveByPrefix: commitment "${loweredInput}" found, but its status '${commitment.status}' is excluded by the status filter (${filter.join(', ')}).`,
    { field: 'status' },
  );
}
