/**
 * requestMarketUpdate() input validation + receipt nonce-parse (R5/CRE).
 * The full happy path requires a viem PublicClient + Signer + on-chain
 * interaction that's prohibitive to mock for unit tests (gas wiring is
 * covered in contests-gas.test.ts); here we cover:
 *   - contestId <= 0 → throws OspexValidationError before any signer/chain work
 *   - parseRequestNonceFromReceipt picks the market-update (requestType=1)
 *     CreOracleRequested event from the CreOracleReceiver address, filtering
 *     out a decoy verify event and a same-shaped event from another address
 *   - an absent market-update event throws OspexValidationError
 * Integration of the full pipeline is exercised manually per
 * docs/MANUAL_INTEGRATION_TESTING.md.
 */
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Log } from 'viem';
import {
  parseRequestNonceFromReceipt,
  requestMarketUpdate,
} from '../src/contests/marketUpdate.js';
import { creOracleReceiverAbi } from '../src/contracts/abi/index.js';
import { OspexValidationError } from '../src/errors.js';
import type { ContestsContext } from '../src/contests/context.js';
import type { Hex } from '../src/types/signer.js';

const RECEIVER = '0x06e3470012039797119Ae30e1236169304F9220C' as Hex;
const OTHER = '0x00000000000000000000000000000000000000aa' as Hex;

function makeRequestedLog(
  address: Hex,
  contestId: bigint,
  requestType: number,
  nonce: bigint,
): Log {
  const topics = encodeEventTopics({
    abi: creOracleReceiverAbi as Abi,
    eventName: 'CreOracleRequested',
    args: { contestId, requestType },
  });
  const data = encodeAbiParameters(
    [{ type: 'uint64' }, { type: 'string' }, { type: 'string' }, { type: 'string' }],
    [nonce, 'rd', 'sp', 'jo'],
  );
  return {
    address,
    topics,
    data,
    blockHash: ('0x' + '11'.repeat(32)) as Hex,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: ('0x' + '22'.repeat(32)) as Hex,
    transactionIndex: 0,
    removed: false,
  } as unknown as Log;
}

describe('contests.requestMarketUpdate — validation', () => {
  it('throws OspexValidationError when contestId is not positive', async () => {
    const ctx = {} as unknown as ContestsContext;
    await expect(requestMarketUpdate(ctx, { contestId: 0n })).rejects.toBeInstanceOf(
      OspexValidationError,
    );
    await expect(requestMarketUpdate(ctx, { contestId: -1 })).rejects.toBeInstanceOf(
      OspexValidationError,
    );
  });
});

describe('parseRequestNonceFromReceipt', () => {
  it('returns the requestNonce from the market-update CreOracleRequested event', () => {
    const logs = [makeRequestedLog(RECEIVER, 7n, 1, 5n)];
    expect(parseRequestNonceFromReceipt(logs, RECEIVER)).toBe(5n);
  });

  it('ignores a verify (requestType=0) event and picks the market-update one', () => {
    const logs = [
      makeRequestedLog(RECEIVER, 7n, 0, 99n), // decoy: verify
      makeRequestedLog(RECEIVER, 7n, 1, 5n), // real: market-update
    ];
    expect(parseRequestNonceFromReceipt(logs, RECEIVER)).toBe(5n);
  });

  it('ignores a same-shaped event emitted by another address', () => {
    const logs = [
      makeRequestedLog(OTHER, 7n, 1, 99n), // wrong emitter
      makeRequestedLog(RECEIVER, 7n, 1, 5n), // the receiver's event
    ];
    expect(parseRequestNonceFromReceipt(logs, RECEIVER)).toBe(5n);
  });

  it('throws OspexValidationError when no market-update event is present', () => {
    expect(() => parseRequestNonceFromReceipt([], RECEIVER)).toThrow(OspexValidationError);
    // A verify-only receipt (no requestType=1) also throws.
    const verifyOnly = [makeRequestedLog(RECEIVER, 7n, 0, 1n)];
    expect(() => parseRequestNonceFromReceipt(verifyOnly, RECEIVER)).toThrow(OspexValidationError);
  });
});
