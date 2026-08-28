/**
 * Shared bridge from a zod wire-body schema to the SDK's public
 * {@link OspexValidationError} contract.
 *
 * Every decoder that validates with a zod schema routes any structural
 * failure through this helper, so the public error surface is unchanged:
 * consumers still catch `OspexValidationError`, never a raw `ZodError`.
 * The callers today are exactly: the own-state bodies (snapshot /
 * commitment / position / positionStatus), own-state health, the fill
 * stream frame, the contests-list REST read (since 0.13.0), and the
 * contest + position stream frames and the three `games.*` reads. The
 * commitment and speculation stream frames and the remaining REST reads
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
