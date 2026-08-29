/**
 * Shared bridge from a zod wire-body schema to the SDK's public
 * {@link OspexValidationError} contract.
 *
 * Every decoder that validates with a zod schema routes any structural
 * failure through this helper, so the public error surface is unchanged:
 * consumers still catch `OspexValidationError`, never a raw `ZodError`.
 * The callers today are exactly: the own-state bodies (snapshot /
 * commitment / position / positionStatus), own-state health, the fill /
 * contest / position / speculation stream frames, and the REST reads
 * `contests.{list,get}`, `speculations.{list,get}` and all three
 * `games.*`. The commitment stream frame and the remaining REST reads
 * (commitments, positions, odds, teams, leaderboard, protocol, health)
 * are still the pre-rule cast+copy; CLAUDE.md's wire-validation hard rule
 * tracks that coverage state and is the authority. The `field` carries the
 * dotted path of the first failing element (e.g. `commitments.0.maker`),
 * falling back to `fallbackField` for a top-level/whole-body failure where
 * the issue path is empty (a `null` or non-object body).
 *
 * Declarative schemas replace the prior hand-written `requireString` /
 * `requireBoolean` per-field checks: a field validated by the schema is
 * validated everywhere the schema is used, with no per-site enumeration to
 * keep in sync.
 */

import { z } from 'zod';
import { OspexValidationError } from './errors.js';
import type { CommitmentStatus, StoredCommitmentStatus } from './types/commitment.js';

/**
 * A uint256 on the wire — a non-empty decimal string. The `.regex` is one of
 * the few CONTENT rules this repo allows at a decode boundary, and it earns
 * that exception the way the rule states: something downstream coerces the
 * value, so without it a malformed body escapes as a raw `SyntaxError` from
 * `BigInt(...)` instead of the documented `OspexValidationError`.
 *
 * Shared rather than copied. It lived in `ownState/schemas.ts` first, for the
 * own-state commitment body; the public commitment body needs the identical
 * rule for the identical reason (`computeIsLive` coerces
 * `remainingRiskAmount`), and two regexes for one wire type is how they drift.
 */
export const UINT256_STRING = z.string().regex(/^\d+$/, 'must be a decimal uint256 string');

/**
 * The RAW on-chain lifecycle a commitment body reports, resolved from the
 * `storedStatus` / `status` pair.
 *
 * A core-api build predating effective-status omits `storedStatus`; on those
 * builds `status` IS the raw stored value, which is why the fallback exists.
 * What the fallback cannot do is produce `'expired'`: that is an EFFECTIVE
 * status only — no writer stores it, and a build that omits `storedStatus`
 * never derived it — and {@link StoredCommitmentStatus} does not include it.
 *
 * This used to be written `body.storedStatus ?? (body.status as
 * StoredCommitmentStatus)`, and the cast was doing real work: measured against
 * the built SDK, a body with `status: 'expired'` and no `storedStatus`
 * published `storedStatus: 'expired'` into a field the public type declares as
 * four values. The cast is gone; the impossible combination is refused with a
 * typed error, and the remaining branch narrows on its own.
 *
 * On the decode paths that run a schema this is unreachable — the schema
 * refuses the same combination one layer earlier, with the dotted field path.
 * It is reachable from the paths that still have no boundary, which is exactly
 * where the public type was being lied to.
 */
export function resolveStoredStatus(body: {
  status: CommitmentStatus;
  storedStatus?: StoredCommitmentStatus | undefined;
}): StoredCommitmentStatus {
  if (body.storedStatus !== undefined) return body.storedStatus;
  if (body.status === 'expired') {
    throw new OspexValidationError(
      'A commitment reported the effective status `expired` without a `storedStatus`. ' +
        '`expired` is derived, never stored, so no raw lifecycle can be recovered from it.',
      { field: 'storedStatus' },
    );
  }
  // `status` is narrowed to the four stored values by the check above, so this
  // assignment is total rather than asserted.
  return body.status;
}

/**
 * `schema.safeParse(body)` → the validated value, or throw
 * {@link OspexValidationError} carrying the first issue's dotted field path
 * and the originating `ZodError` as `cause`.
 */
export function parseWire<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
  fallbackField = 'body',
): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new OspexValidationError(issue.message, {
      field: issue.path.length > 0 ? issue.path.join('.') : fallbackField,
      cause: result.error,
    });
  }
  return result.data;
}
