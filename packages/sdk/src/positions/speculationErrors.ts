/**
 * Decode the one SpeculationModule custom error the settle pipeline
 * needs to recognize — `SpeculationModule__AlreadySettled()` — out of
 * viem's nested error chain.
 *
 * This mirrors `commitments/matchingErrors.ts`: the SDK's settle send
 * goes through `estimateGas` (no ABI context), so a pre-send revert
 * surfaces only the raw 4-byte selector on a `data` hex string. When a
 * higher-level viem helper decoded the revert, the structured
 * `data.errorName` path matches instead. Both are walked.
 *
 * Why only this one error: `AlreadySettled` is the *recoverable* signal
 * — it means the goal (speculation settled) is already achieved, so the
 * caller can safely skip to claiming. Every other SpeculationModule
 * revert (`ContestNotFinalized`, `InvalidStartTime`, …) is a genuine
 * failure that must propagate. See `ensureSettled.ts`, where this
 * classification is one of two independent "already settled" signals
 * (the other being an authoritative re-read of on-chain state).
 */

import { keccak256, toBytes, type Hex } from 'viem';

const SELECTOR_LENGTH = 10; // '0x' + 4 bytes hex

const ALREADY_SETTLED_SELECTOR = keccak256(
  toBytes('SpeculationModule__AlreadySettled()'),
).slice(0, SELECTOR_LENGTH) as Hex;

/**
 * Walk an arbitrary error's `cause` chain (depth-bounded) looking for
 * the `SpeculationModule__AlreadySettled()` revert. Returns `true` if
 * either viem's structured `data.errorName` or a raw hex `data` field's
 * first 4 bytes match.
 */
export function isAlreadySettledRevert(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 12 && current; depth++) {
    if (typeof current !== 'object' || current === null) break;
    const o = current as Record<string, unknown>;

    // Path 1 — structured error name (viem with ABI context).
    if (typeof o.data === 'object' && o.data !== null) {
      const inner = o.data as { errorName?: unknown };
      if (inner.errorName === 'SpeculationModule__AlreadySettled') return true;
    }

    // Path 2 — raw hex revert data with a known selector.
    if (typeof o.data === 'string' && o.data.startsWith('0x') && o.data.length >= SELECTOR_LENGTH) {
      if (o.data.slice(0, SELECTOR_LENGTH).toLowerCase() === ALREADY_SETTLED_SELECTOR.toLowerCase()) {
        return true;
      }
    }

    current = o.cause;
  }
  return false;
}
