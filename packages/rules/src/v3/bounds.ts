/**
 * The bounds the checks hold every input to: the matching contract's own
 * constants and widths, as the contracts at baa1fc566cf13552d968fb738ccb8ca3d859666f
 * declare them, and the courier's limit on a stop's hashes. They are not
 * exported from the package.
 */

/** The lowest and highest price an order may sign, in ticks (101 = 1.01). */
export const MIN_ODDS_TICK = 101;
export const MAX_ODDS_TICK = 10_100;

/** The lot: a signed stake is a whole number of 100 units. */
export const LOT = 100n;

/** The largest line, either way, in tenths. */
export const MAX_LINE_TICKS = 1_000_000;

/** The nonce's three numbers, high to low: the version, the grant number, the order number. */
export const VERSION_BITS = 128n;
export const GRANT_BITS = 32n;
export const ORDER_NUMBER_BITS = 96n;
/** Where they sit: the version above bit 128, the grant number above bit 96. */
export const VERSION_SHIFT = 128n;
export const GRANT_SHIFT = 96n;

/** One above the largest uint256. */
export const UINT256_LIMIT = 1n << 256n;

/** The most order hashes one stop may name. */
export const MAX_STOP_HASHES = 100;
