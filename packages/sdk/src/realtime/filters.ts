/**
 * Synchronous validators for stream filter args. They run in `subscribe()`
 * before the connection opens, so a malformed address/hash rejects the
 * subscribe promise with a clear `OspexValidationError` instead of dying later
 * as a fatal 400 from the server. Numeric ids (`contestId`, `speculationId`)
 * are coerced to strings by the transport's query builder and validated
 * server-side, so they don't need a client-side check here.
 */

import { OspexValidationError } from '../errors.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

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
