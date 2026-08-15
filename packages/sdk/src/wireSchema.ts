/**
 * Shared bridge from a zod wire-body schema to the SDK's public
 * {@link OspexValidationError} contract.
 *
 * Every wire-body decoder with a zod schema — the own-state bodies
 * (snapshot / commitment / position / positionStatus), fill and stream
 * bodies, and the contests-list REST read (since 0.13.0) — routes any
 * structural failure through this helper, so the public error surface is
 * unchanged: consumers still catch `OspexValidationError`, never a raw
 * `ZodError`. (Which decode paths have a schema vs. the legacy cast+copy
 * is tracked in CLAUDE.md's wire-validation hard rule — the coverage
 * state, not this header, is the authority.) The `field` carries the
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
