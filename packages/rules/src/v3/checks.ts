import { getAddress, type Address, type Hex } from 'viem';
import { LOT, MAX_LINE_TICKS, MAX_ODDS_TICK, MAX_STOP_HASHES, MIN_ODDS_TICK, UINT256_LIMIT } from './bounds.js';
import type { OspexOrder } from './types.js';

/**
 * The checks every input passes before it is hashed or signed.
 *
 * They are checks of shape and range only. Whether an order can fill is live
 * state, which this package does not read and does not check: that the nonce's
 * version is the account's current one, that a grant is live, the line's floor,
 * the account's registration with the courier, its balance and allowance, and
 * that the expiry is still ahead. A caller that needs those reads them from the
 * chain or the courier.
 */

/**
 * The one refusal of the v3 order and the stop. It names the function, the
 * field and the refused value. The value is text: a bigint or a number in
 * decimal, a string as given, any other type by its type's name. For a
 * signature the field is `signature.length`, `signature.v`, `signature.s` or
 * `signature.recovered`, and the value is only that part (the signature's
 * length in characters, its v, its s, or the address it recovers to), never
 * the whole signature.
 */
export class OrderRefused extends Error {
  readonly functionName: string;
  readonly field: string;
  readonly value: string;

  constructor(functionName: string, field: string, value: unknown) {
    const text = asText(value);
    super(`${functionName}: ${field} refused: ${text}`);
    this.name = 'OrderRefused';
    this.functionName = functionName;
    this.field = field;
    this.value = text;
  }
}

function asText(value: unknown): string {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value).toString(10) : String(value);
  if (typeof value === 'string') return value;
  return value === null ? 'null' : typeof value;
}

/** The public functions, by the name a refusal gives. */
export type FunctionName =
  | 'orderHash' | 'signOrder' | 'stopDigest' | 'signStop' | 'packNonce' | 'splitNonce' | 'orderDomain' | 'stopDomain';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * An address: `0x` and 40 hex characters, in one case throughout, or in mixed
 * case with a valid checksum. Returned in its checksummed form, which encodes
 * the same twenty bytes.
 */
export function checkAddress(fn: FunctionName, field: string, value: unknown): Address {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new OrderRefused(fn, field, value);
  const digits = value.slice(2);
  const checksummed = getAddress(value);
  const oneCase = digits === digits.toLowerCase() || digits === digits.toUpperCase();
  if (!oneCase && checksummed !== value) throw new OrderRefused(fn, field, value);
  return checksummed;
}

/** A bigint from 0 to below `limit`. Never a number: no uint256 passes through a JavaScript number. */
export function checkUnsigned(fn: FunctionName, field: string, value: unknown, limit: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= limit) throw new OrderRefused(fn, field, value);
  return value;
}

/** A uint256: a bigint from 0 to 2^256 - 1. */
export function checkUint256(fn: FunctionName, field: string, value: unknown): bigint {
  return checkUnsigned(fn, field, value, UINT256_LIMIT);
}

/** A safe integer from `min` to `max`. Never a bigint, and never coerced. */
export function checkInteger(fn: FunctionName, field: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new OrderRefused(fn, field, value);
  }
  return value;
}

/** A chain id: a safe integer above 0. */
export function checkChainId(fn: FunctionName, value: unknown): number {
  return checkInteger(fn, 'chainId', value, 1, Number.MAX_SAFE_INTEGER);
}

/**
 * The ten fields of an order, each checked as the matching contract bounds it.
 * Returns a new order of exactly those ten fields, its addresses checksummed.
 */
export function checkOrder(fn: FunctionName, order: unknown): OspexOrder {
  const o: Record<string, unknown> = typeof order === 'object' && order !== null ? (order as Record<string, unknown>) : {};
  const account = checkAddress(fn, 'account', o['account']);
  const gameId = checkUint256(fn, 'gameId', o['gameId']);
  const scorer = checkAddress(fn, 'scorer', o['scorer']);
  const lineTicks = checkInteger(fn, 'lineTicks', o['lineTicks'], -MAX_LINE_TICKS, MAX_LINE_TICKS);
  const positionType = checkInteger(fn, 'positionType', o['positionType'], 0, 1) as 0 | 1;
  const oddsTick = checkInteger(fn, 'oddsTick', o['oddsTick'], MIN_ODDS_TICK, MAX_ODDS_TICK);
  const riskAmount = checkUint256(fn, 'riskAmount', o['riskAmount']);
  if (riskAmount === 0n || riskAmount % LOT !== 0n) throw new OrderRefused(fn, 'riskAmount', riskAmount);
  const nonce = checkUint256(fn, 'nonce', o['nonce']);
  const expiry = checkUint256(fn, 'expiry', o['expiry']);
  const minFill = checkUint256(fn, 'minFill', o['minFill']);
  if (minFill > riskAmount) throw new OrderRefused(fn, 'minFill', minFill);
  return { account, gameId, scorer, lineTicks, positionType, oddsTick, riskAmount, nonce, expiry, minFill };
}

/**
 * A stop's order hashes: 1 to 100 of them, each `0x` and 64 hex characters,
 * none named twice (compared lowercased). Returned as a new list in the order
 * given, since the order changes the digest.
 */
export function checkStopHashes(fn: FunctionName, value: unknown): Hex[] {
  if (!Array.isArray(value)) throw new OrderRefused(fn, 'orderHashes', value);
  if (value.length < 1 || value.length > MAX_STOP_HASHES) throw new OrderRefused(fn, 'orderHashes', value.length);
  const named = new Set<string>();
  const hashes: Hex[] = [];
  for (const hash of value as unknown[]) {
    if (typeof hash !== 'string' || !HASH.test(hash)) throw new OrderRefused(fn, 'orderHashes', hash);
    const key = hash.toLowerCase();
    if (named.has(key)) throw new OrderRefused(fn, 'orderHashes', hash);
    named.add(key);
    hashes.push(hash as Hex);
  }
  return hashes;
}
