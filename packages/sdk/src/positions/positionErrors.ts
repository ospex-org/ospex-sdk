/**
 * Decode the three PositionModule custom errors the claim pipeline
 * needs to recognize out of viem's nested error chain:
 *   - `PositionModule__AlreadyClaimed()` — the one *recoverable* signal
 *     (the goal, payout collected, is already achieved).
 *   - `PositionModule__NotSettled()` — a genuine failure (claim before
 *     the parent speculation settled); the CLI uses it to point the user
 *     at `ospex settle` / `ospex claim-all`.
 *   - `PositionModule__NoPayout()` — a genuine failure (nothing to
 *     claim on this position); kept distinct so callers don't conflate
 *     it with "already claimed."
 *
 * This mirrors `speculationErrors.ts`: the SDK's claim send goes through
 * `estimateGas` (no ABI context), so a pre-send revert surfaces only the
 * raw 4-byte selector on a `data` hex string. When a higher-level viem
 * helper decoded the revert, the structured `data.errorName` path matches
 * instead. Both are walked.
 *
 * Why only `AlreadyClaimed` is treated as benign: `claimPosition` only
 * ever touches `msg.sender`'s own position, so an `AlreadyClaimed` revert
 * means this wallet's payout was already collected — there's no failure
 * interpretation. `NotSettled` / `NoPayout` and every other revert are
 * genuine failures that must propagate. See `ensureClaimed.ts`, where
 * `isAlreadyClaimedRevert` is one of two independent "already claimed"
 * signals (the other being an authoritative re-read of `getPosition`).
 */

import { keccak256, toBytes, type Hex } from 'viem';

const SELECTOR_LENGTH = 10; // '0x' + 4 bytes hex

// Selectors recomputed at module load (not hardcoded) so an upstream
// custom-error renaming surfaces as a "no longer recovers" behavior
// change caught by tests, rather than a silent wrong-selector match.
// Cross-checked against the published ABI selectors:
//   AlreadyClaimed 0x9ec7917e · NotSettled 0x0c95096e · NoPayout 0xd3467fd7
const ALREADY_CLAIMED_SELECTOR = selectorOf('PositionModule__AlreadyClaimed()');
const NOT_SETTLED_SELECTOR = selectorOf('PositionModule__NotSettled()');
const NO_PAYOUT_SELECTOR = selectorOf('PositionModule__NoPayout()');

function selectorOf(signature: string): Hex {
  return keccak256(toBytes(signature)).slice(0, SELECTOR_LENGTH) as Hex;
}

/**
 * Walk an arbitrary error's `cause` chain (depth-bounded) looking for a
 * specific custom error. Returns `true` if either viem's structured
 * `data.errorName` matches `errorName` or a raw hex `data` field's first
 * 4 bytes match `selector`.
 */
function matchesRevert(err: unknown, errorName: string, selector: Hex): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 12 && current; depth++) {
    if (typeof current !== 'object' || current === null) break;
    const o = current as Record<string, unknown>;

    // Path 1 — structured error name (viem with ABI context).
    if (typeof o.data === 'object' && o.data !== null) {
      const inner = o.data as { errorName?: unknown };
      if (inner.errorName === errorName) return true;
    }

    // Path 2 — raw hex revert data with a known selector.
    if (typeof o.data === 'string' && o.data.startsWith('0x') && o.data.length >= SELECTOR_LENGTH) {
      if (o.data.slice(0, SELECTOR_LENGTH).toLowerCase() === selector.toLowerCase()) {
        return true;
      }
    }

    current = o.cause;
  }
  return false;
}

/** `PositionModule__AlreadyClaimed()` — the recoverable signal. */
export function isAlreadyClaimedRevert(err: unknown): boolean {
  return matchesRevert(err, 'PositionModule__AlreadyClaimed', ALREADY_CLAIMED_SELECTOR);
}

/** `PositionModule__NotSettled()` — genuine failure (settle first). */
export function isNotSettledRevert(err: unknown): boolean {
  return matchesRevert(err, 'PositionModule__NotSettled', NOT_SETTLED_SELECTOR);
}

/** `PositionModule__NoPayout()` — genuine failure (nothing to claim). */
export function isNoPayoutRevert(err: unknown): boolean {
  return matchesRevert(err, 'PositionModule__NoPayout', NO_PAYOUT_SELECTOR);
}
