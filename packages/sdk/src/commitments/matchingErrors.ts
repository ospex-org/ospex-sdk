/**
 * Decode known MatchingModule custom errors out of viem's nested error
 * chain so the SDK can surface a typed `reason` instead of leaking
 * "execution reverted with reason 0xabcd1234" up to the consumer.
 *
 * Two recognition paths are handled:
 *   1. Structured: viem's ContractFunctionRevertedError exposes the
 *      decoded `errorName` when the call was made with ABI context.
 *      Reached when the revert came back through `simulateContract`
 *      or a similar high-level helper.
 *   2. Raw: low-level `eth_call` / `eth_estimateGas` reverts surface
 *      the raw revert bytes as a hex string (e.g. on
 *      `RpcRequestError.data`). The first 4 bytes are the selector.
 *
 * Both paths are walked because the SDK's send pipeline goes through
 * `estimateGas` (no ABI context) — when that's the failure point, only
 * the raw selector is available. When viem decides to surface a richer
 * error (newer versions, or different code paths), the structured
 * decode also works.
 */

import { keccak256, toBytes, type Hex } from 'viem';
import { OspexChainError, type OspexChainErrorReason } from '../errors.js';

const SELECTOR_LENGTH = 10; // '0x' + 4 bytes hex

const NOT_COMMITMENT_MAKER_SELECTOR = keccak256(
  toBytes('MatchingModule__NotCommitmentMaker()'),
).slice(0, SELECTOR_LENGTH) as Hex;

const NONCE_MUST_INCREASE_SELECTOR = keccak256(
  toBytes('MatchingModule__NonceMustIncrease()'),
).slice(0, SELECTOR_LENGTH) as Hex;

const ERROR_NAME_TO_REASON: Record<string, OspexChainErrorReason> = {
  MatchingModule__NotCommitmentMaker: 'NotCommitmentMaker',
  MatchingModule__NonceMustIncrease: 'NonceMustIncrease',
};

const SELECTOR_TO_REASON: Record<string, OspexChainErrorReason> = {
  [NOT_COMMITMENT_MAKER_SELECTOR.toLowerCase()]: 'NotCommitmentMaker',
  [NONCE_MUST_INCREASE_SELECTOR.toLowerCase()]: 'NonceMustIncrease',
};

const REASON_HUMAN_MESSAGE: Record<OspexChainErrorReason, string> = {
  NotCommitmentMaker:
    'Caller is not the commitment maker. Only the maker may cancel their own commitment on chain.',
  NonceMustIncrease:
    'newMinNonce must strictly exceed the current on-chain floor for this (maker, speculation).',
};

/**
 * Walk an arbitrary error's `cause` chain (depth-bounded) looking for
 * a recognizable Ospex revert signal. Returns the matching `reason` if
 * one of two paths matches: viem's structured `data.errorName`, or a
 * raw hex `data` field whose first 4 bytes match a known selector.
 */
export function classifyMatchingModuleRevert(
  err: unknown,
): OspexChainErrorReason | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 12 && current; depth++) {
    if (typeof current !== 'object' || current === null) break;
    const o = current as Record<string, unknown>;

    // Path 1 — structured error name (viem with ABI context).
    if (typeof o.data === 'object' && o.data !== null) {
      const inner = o.data as { errorName?: unknown };
      if (typeof inner.errorName === 'string' && inner.errorName in ERROR_NAME_TO_REASON) {
        return ERROR_NAME_TO_REASON[inner.errorName];
      }
    }

    // Path 2 — raw hex revert data with a known selector.
    if (typeof o.data === 'string' && o.data.startsWith('0x') && o.data.length >= SELECTOR_LENGTH) {
      const sel = o.data.slice(0, SELECTOR_LENGTH).toLowerCase();
      if (sel in SELECTOR_TO_REASON) return SELECTOR_TO_REASON[sel];
    }

    current = o.cause;
  }
  return undefined;
}

/**
 * Wrap a chain-send promise; classify any thrown error and re-throw
 * as an `OspexChainError` with a typed `reason` when matched. Errors
 * that aren't recognizable are wrapped only if they aren't already
 * OspexChainError (otherwise the original is re-thrown untouched so
 * structured fields like `txHash` aren't lost).
 *
 * `actionLabel` is a short noun for the operation (e.g.
 * `'cancelCommitment'`) — it's prefixed onto the human-friendly
 * message so the consumer knows which call reverted.
 */
export async function sendWithMatchingErrorClassification<T>(
  actionLabel: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const reason = classifyMatchingModuleRevert(err);
    if (reason) {
      throw new OspexChainError(
        `${actionLabel} reverted: ${REASON_HUMAN_MESSAGE[reason]}`,
        { reason, cause: err },
      );
    }
    if (err instanceof OspexChainError) throw err;
    throw new OspexChainError(`${actionLabel} failed.`, { cause: err });
  }
}
