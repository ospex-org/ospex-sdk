/**
 * Pre-flight validators for commitment inputs. Mirror the contract +
 * core-api bounds so the SDK fails fast with a clear error before
 * paying for an EIP-712 sign or an RPC roundtrip.
 *
 * Bounds are taken from:
 *   - oddsTick:  MatchingModule  (MIN_ODDS=101, MAX_ODDS=10100)
 *   - lot size:  MatchingModule  (riskAmount % 100 == 0)
 *   - expiry upper bound: 1 year (enforced by the API on POST)
 *
 * The 1-year expiry cap is an API-side constraint, not an on-chain one;
 * enforcing it here surfaces a clean error instead of letting the
 * server reject the POST.
 */

import { OspexValidationError } from '../errors.js';

const MIN_ODDS = 101;
const MAX_ODDS = 10100;
const ODDS_SCALE = 100n;
const MAX_EXPIRY_OFFSET_SEC = 366n * 24n * 60n * 60n;

export function validateOdds(oddsTick: number): void {
  if (!Number.isInteger(oddsTick) || oddsTick < MIN_ODDS || oddsTick > MAX_ODDS) {
    throw new OspexValidationError(
      `oddsTick must be an integer between ${MIN_ODDS} and ${MAX_ODDS} (got ${oddsTick}).`,
      { field: 'oddsTick' },
    );
  }
}

export function validatePositionType(positionType: number): asserts positionType is 0 | 1 {
  if (positionType !== 0 && positionType !== 1) {
    throw new OspexValidationError(
      `positionType must be 0 (upper / away / over) or 1 (lower / home / under), got ${positionType}.`,
      { field: 'positionType' },
    );
  }
}

export function validateRiskAmount(riskAmount: bigint): void {
  if (riskAmount <= 0n) {
    throw new OspexValidationError('riskAmount must be positive.', { field: 'riskAmount' });
  }
  if (riskAmount % ODDS_SCALE !== 0n) {
    throw new OspexValidationError(
      `riskAmount must be a multiple of ${ODDS_SCALE} (lot-size aligned). Got ${riskAmount}.`,
      { field: 'riskAmount' },
    );
  }
}

export function validateExpiry(expiry: bigint, nowSec: bigint = nowUnixSec()): void {
  if (expiry <= nowSec) {
    throw new OspexValidationError('expiry must be in the future.', { field: 'expiry' });
  }
  if (expiry > nowSec + MAX_EXPIRY_OFFSET_SEC) {
    throw new OspexValidationError(
      'expiry is more than 1 year in the future; the API will reject it.',
      { field: 'expiry' },
    );
  }
}

export function validateLineTicks(lineTicks: number): void {
  if (
    !Number.isInteger(lineTicks) ||
    lineTicks < -2_147_483_648 ||
    lineTicks > 2_147_483_647
  ) {
    throw new OspexValidationError('lineTicks must be an int32.', { field: 'lineTicks' });
  }
}

export function nowUnixSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}
