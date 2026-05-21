/**
 * Synchronous validators / normalizers for stream filter args. They run in
 * `subscribe()` before the connection opens, so a malformed value rejects the
 * subscribe promise with a clear `OspexValidationError` instead of dying later
 * as a fatal 400 from the server.
 */

import { OspexValidationError } from '../errors.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Canonicalize a uint id filter (`contestId` / `speculationId`) to the same
 * non-negative-integer form core-api uses (`BigInt(String(v)).toString()`),
 * rejecting negatives / non-integers. Returning a single canonical string
 * keeps the stream query filter and any client-side snapshot filter in
 * agreement — a position snapshot filtered on `speculationId` must compare
 * equal to the stream-scoped value and to the DB's canonical id string.
 */
export function normalizeUint(value: string | number | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  let n: bigint;
  try {
    n = BigInt(String(value));
  } catch {
    throw new OspexValidationError(`${field} must be a non-negative integer.`, { field });
  }
  if (n < 0n) {
    throw new OspexValidationError(`${field} must be a non-negative integer.`, { field });
  }
  return n.toString();
}

export function assertAddress(value: string | undefined, field: string): void {
  if (value !== undefined && !ADDRESS.test(value)) {
    throw new OspexValidationError(`${field} must be a 0x-prefixed 20-byte hex address.`, {
      field,
    });
  }
}

export function assertHash(value: string | undefined, field: string): void {
  if (value !== undefined && !HASH.test(value)) {
    throw new OspexValidationError(`${field} must be a 0x-prefixed 32-byte hex string.`, {
      field,
    });
  }
}
