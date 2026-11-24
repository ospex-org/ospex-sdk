import { GRANT_BITS, GRANT_SHIFT, ORDER_NUMBER_BITS, VERSION_BITS, VERSION_SHIFT } from './bounds.js';
import { checkInteger, checkUint256, checkUnsigned } from './checks.js';

/**
 * An order's nonce is one uint256 holding three numbers, high to low, as the
 * matching contract splits it: the account's version (128 bits), the number of
 * the grant the order is signed under (32 bits, 0 when the account signs it
 * itself), and an order number (96 bits), which a line's floor is compared
 * with. Whether the version is the account's current one, whether the grant is
 * live, and where the floor stands are live state, which this package does not
 * check.
 */

const GRANT_MAX = Number((1n << GRANT_BITS) - 1n);
const GRANT_MASK = (1n << GRANT_BITS) - 1n;
const ORDER_NUMBER_MASK = (1n << ORDER_NUMBER_BITS) - 1n;

/** Packs the three numbers into a nonce. Each is range-checked first, so none can spill into the next. */
export function packNonce(version: bigint, grant: number, orderNumber: bigint): bigint {
  const v = checkUnsigned('packNonce', 'version', version, 1n << VERSION_BITS);
  const g = checkInteger('packNonce', 'grant', grant, 0, GRANT_MAX);
  const n = checkUnsigned('packNonce', 'orderNumber', orderNumber, 1n << ORDER_NUMBER_BITS);
  return (v << VERSION_SHIFT) | (BigInt(g) << GRANT_SHIFT) | n;
}

/** Splits a nonce into its three numbers: the inverse of packNonce, for any nonce from 0 to 2^256 - 1. */
export function splitNonce(nonce: bigint): { version: bigint; grant: number; orderNumber: bigint } {
  const x = checkUint256('splitNonce', 'nonce', nonce);
  return {
    version: x >> VERSION_SHIFT,
    grant: Number((x >> GRANT_SHIFT) & GRANT_MASK),
    orderNumber: x & ORDER_NUMBER_MASK,
  };
}
