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

/**
 * Absolute magnitude bound on a NEW commitment's lineTicks, mirroring the
 * protocol guard (MatchingModule / SpeculationModule / SpreadScorerModule
 * `MAX_LINE_TICKS`). lineTicks is the 10×-scaled line, so this is ±100,000.0
 * points/total — far above any real betting line, far below the magnitude that
 * overflows the spread scorer.
 *
 * Why this matters: a spread commitment whose `|lineTicks|` is large enough to
 * overflow `SpreadScorerModule`'s checked addition permanently bricks
 * settlement — once the contest is scored, `settleSpeculation` reverts forever,
 * so `claimPosition` reverts and BOTH sides' escrowed USDC are locked with no
 * admin recovery. The protocol rejects an out-of-range line at the entry point,
 * but that on-chain bound is not yet live everywhere, so the client is the
 * effective line of defense: refuse to SIGN (submit) or FILL (match) a
 * commitment that carries one.
 */
export const MAX_LINE_TICKS = 1_000_000;

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

/**
 * Validate that `lineTicks` fits the on-chain `int32` field — the bound for
 * IDENTIFYING a speculation key, NOT for creating a commitment.
 *
 * Deliberately does NOT enforce {@link MAX_LINE_TICKS}: this is the validator
 * the cancel / nonce-floor RECOVERY paths use (`cancelAllOnSpeculation`,
 * `raiseMinNonce`, `getNonceFloor`). A maker who already signed a poisoned
 * (out-of-magnitude) commitment must stay able to raise the nonce floor on, or
 * cancel against, that exact `(contestId, scorer, lineTicks)` key to neutralize
 * it on chain before it can be matched — so these paths must accept any valid
 * int32. The magnitude bound is enforced separately, on the money-moving
 * create/fill paths, by {@link validateCommitmentLineTicks}.
 */
export function validateLineTicks(lineTicks: number): void {
  if (
    !Number.isInteger(lineTicks) ||
    lineTicks < -2_147_483_648 ||
    lineTicks > 2_147_483_647
  ) {
    throw new OspexValidationError('lineTicks must be an int32.', { field: 'lineTicks' });
  }
}

/** True iff `lineTicks` exceeds the magnitude a NEW commitment may carry
 * ({@link MAX_LINE_TICKS}). Non-throwing — for callers (e.g. advisory fillability)
 * that surface the condition as a verdict rather than an exception. */
export function commitmentLineTicksOutOfRange(lineTicks: number): boolean {
  return Math.abs(lineTicks) > MAX_LINE_TICKS;
}

/**
 * Magnitude guard for a commitment about to be SIGNED (submit) or FILLED
 * (match). Throws when `lineTicks` is non-integer or `|lineTicks|` exceeds
 * {@link MAX_LINE_TICKS}. See {@link MAX_LINE_TICKS} for the fund-lock rationale.
 *
 * Strictly stronger than {@link validateLineTicks} (the bound is far inside
 * int32), so it fully covers the integer check too — use it wherever a
 * commitment's own line is being committed to, and reserve `validateLineTicks`
 * for the recovery paths that key off an arbitrary existing speculation.
 */
export function validateCommitmentLineTicks(lineTicks: number): void {
  if (!Number.isInteger(lineTicks)) {
    throw new OspexValidationError('lineTicks must be an integer.', { field: 'lineTicks' });
  }
  if (commitmentLineTicksOutOfRange(lineTicks)) {
    throw new OspexValidationError(
      `lineTicks magnitude ${lineTicks} exceeds the protocol bound |lineTicks| <= ${MAX_LINE_TICKS} ` +
        `(±${MAX_LINE_TICKS / 10} points). A line this large overflows the spread scorer and would ` +
        `permanently lock both sides' escrow at settlement; refusing to sign/fill it.`,
      { field: 'lineTicks' },
    );
  }
}

export function nowUnixSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}
