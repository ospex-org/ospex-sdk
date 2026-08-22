/**
 * `client.commitments.getFilledRisk(args)` — batched, block-pinned read of
 * `MatchingModule.s_filledRisk`.
 *
 * The fake public client here deliberately does NOT follow the shape used by
 * `commitments-getNonceFloor.test.ts`, whose `readContract` takes no arguments
 * and answers the same value for any call. That fake cannot tell a read of
 * `s_minNonces` from a read of `s_filledRisk`, nor one hash from another —
 * and this read's entire content is "the right value for THIS hash". So the
 * fake below RECORDS the aggregate it was handed and answers per-hash from a
 * table, and the assertions sit on what the call received rather than on what
 * the test prepared for it.
 */

import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { getFilledRisk } from '../src/commitments/getFilledRisk.js';
import { matchingModuleAbi } from '../src/contracts/abi/index.js';
import { NonceCounter } from '../src/commitments/context.js';
import { OspexChainError, OspexConfigError, OspexValidationError } from '../src/errors.js';
import { OspexClient } from '../src/index.js';
import type { FilledRiskSnapshot, GetFilledRiskArgs } from '../src/index.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { Hex } from '../src/types/signer.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const MATCHING_MODULE = ('0x' + '11'.repeat(20)) as Hex;

// Four hashes, deliberately NOT in lexicographic order in `BOOK` below, and
// paired with values that are not in ascending order either — so a
// sort-then-zip, a reversal, or a `[0]` shortcut has to disagree with the
// expected mapping rather than coincide with it. A single-element array would
// pass under every one of those bugs, so nothing here uses one.
const H_PARTIAL = ('0x' + '3c'.repeat(32)) as Hex;
const H_UNFILLED = ('0x' + '0e'.repeat(32)) as Hex;
const H_FULL = ('0x' + 'b7'.repeat(32)) as Hex;
const H_LARGE = ('0x' + 'f2'.repeat(32)) as Hex;

const BOOK: readonly Hex[] = [H_PARTIAL, H_UNFILLED, H_FULL, H_LARGE];

/**
 * The `riskAmount` of the fully-filled commitment, in 6-decimal USDC units.
 * `filled === riskAmount` is one of the two boundaries that matter to the
 * consumer (remaining obligation exactly zero); `0n` is the other.
 */
const FULL_RISK = 12_345_678n;

/**
 * What the chain holds, keyed by lowercased hash. Values avoid round numbers
 * — a quantiser, a truncation to whole USDC, or a decimal rescale would have
 * to move them. `H_LARGE` sits at 2^53 + 1, which no `Number()` round trip
 * survives. `H_UNFILLED` is absent on purpose: the mapping's storage default
 * is what a hash with no fill reads, and that is the negative control.
 */
const CHAIN: Record<string, bigint> = {
  [H_PARTIAL.toLowerCase()]: 3_141_593n,
  [H_FULL.toLowerCase()]: FULL_RISK,
  [H_LARGE.toLowerCase()]: 9_007_199_254_740_993n,
};

const EXPECTED: ReadonlyArray<readonly [Hex, bigint]> = [
  [H_PARTIAL, 3_141_593n],
  [H_UNFILLED, 0n],
  [H_FULL, FULL_RISK],
  [H_LARGE, 9_007_199_254_740_993n],
];

const HEAD_BLOCK = 71_234_567n;
const PINNED_BLOCK = 71_234_501n; // strictly below HEAD_BLOCK, so a pin
// assertion cannot pass by coinciding with the head the fake would answer.

/* ------------------------------------------------------------------ */
/* Fake context — records the calls, answers per hash                  */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  address: unknown;
  abi: unknown;
  functionName: unknown;
  args: unknown;
}

interface RecordedAggregate {
  contracts: RecordedCall[];
  allowFailure: unknown;
  blockNumber: unknown;
}

interface FakeOptions {
  /** Lowercased hash → value. Defaults to CHAIN. Absent key reads 0n. */
  chain?: Record<string, bigint>;
  /** What `eth_blockNumber` answers. */
  headBlock?: bigint;
  /** Replace the aggregate's return value wholesale (malformed-result cases). */
  respondWith?: (recorded: RecordedAggregate) => unknown;
  /** Make the aggregate reject. */
  aggregateError?: Error;
  /** Make `eth_blockNumber` reject. */
  headError?: Error;
}

function fakeContext(opts: FakeOptions = {}): {
  ctx: CommitmentsContext;
  aggregates: RecordedAggregate[];
  headCalls: () => number;
} {
  const aggregates: RecordedAggregate[] = [];
  let headCalls = 0;
  const table = opts.chain ?? CHAIN;

  const publicClient = {
    getBlockNumber: async (): Promise<bigint> => {
      headCalls += 1;
      if (opts.headError !== undefined) throw opts.headError;
      return opts.headBlock ?? HEAD_BLOCK;
    },
    multicall: async (params: RecordedAggregate): Promise<unknown> => {
      aggregates.push(params);
      if (opts.aggregateError !== undefined) throw opts.aggregateError;
      if (opts.respondWith !== undefined) return opts.respondWith(params);
      return params.contracts.map((call) => {
        // Defensive: a read pointed at the wrong contract or the wrong getter
        // must not be able to produce a plausible answer here. The explicit
        // pin on those fields lives in its own case below.
        if (call.address !== MATCHING_MODULE) {
          throw new Error(`aggregate targeted ${String(call.address)}, not MatchingModule`);
        }
        if (call.functionName !== 's_filledRisk') {
          throw new Error(`aggregate called ${String(call.functionName)}, not s_filledRisk`);
        }
        const args = call.args as unknown[];
        return table[String(args[0]).toLowerCase()] ?? 0n;
      });
    },
  } as unknown as PublicClient;

  const ctx = {
    api: {} as CommitmentsContext['api'],
    getChainId: () => 137,
    getAddresses: () =>
      ({ matchingModule: MATCHING_MODULE }) as unknown as ReturnType<
        CommitmentsContext['getAddresses']
      >,
    requireChainClient: () => publicClient,
    nonceCounter: new NonceCounter(),
  } as unknown as CommitmentsContext;

  return { ctx, aggregates, headCalls: () => headCalls };
}

function onlyAggregate(aggregates: RecordedAggregate[]): RecordedAggregate {
  expect(aggregates).toHaveLength(1);
  const first = aggregates[0];
  if (first === undefined) throw new Error('no aggregate was recorded');
  return first;
}

/* ------------------------------------------------------------------ */

describe('commitments.getFilledRisk — the mapping', () => {
  it('maps EVERY hash to its own value, not just a sampled one', async () => {
    // The pairing between the hash list and the result list is positional, so
    // a swap of two same-typed entries is invisible to any assertion that
    // samples one entry or only checks the size. Assert the whole mapping.
    const { ctx } = fakeContext();
    const { filledRisk } = await getFilledRisk(ctx, { hashes: BOOK });

    expect([...filledRisk.entries()]).toStrictEqual(EXPECTED.map(([h, v]) => [h, v]));
    expect(filledRisk.size).toBe(BOOK.length);
  });

  it('the fixture can actually SEE a swap (every expected value distinct)', () => {
    // Guard on the fixture, not on the code: if a future edit gives two
    // hashes the same filled risk, the case above silently stops
    // discriminating a positional swap and nothing else would say so.
    const values = EXPECTED.map(([, v]) => v);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(BOOK).size).toBe(BOOK.length);
  });

  it('keys the mapping by the hash strings passed in, verbatim', async () => {
    // Not case-normalised: `get(h)` is defined for every `h` the caller
    // handed over, with no normalisation rule for the caller to get wrong.
    const H_MIXED = ('0x' + 'aB'.repeat(32)) as Hex;
    const { ctx } = fakeContext({
      chain: { [H_MIXED.toLowerCase()]: 777_007n, [H_PARTIAL.toLowerCase()]: 3_141_593n },
    });

    const { filledRisk } = await getFilledRisk(ctx, { hashes: [H_MIXED, H_PARTIAL] });

    expect([...filledRisk.keys()]).toStrictEqual([H_MIXED, H_PARTIAL]);
    expect(filledRisk.get(H_MIXED)).toBe(777_007n);
    expect(filledRisk.size).toBe(2);
  });
});

describe('commitments.getFilledRisk — zero is a value, a failure is not', () => {
  it('reads 0n for a hash with no fill, and keeps it in the mapping', async () => {
    // NEGATIVE CONTROL, accept half. `s_filledRisk` is a mapping: an unfilled
    // commitment and an unknown hash share the storage default, and 0n is the
    // honest answer for both. It must be present, not absent, and not an error.
    const { ctx } = fakeContext();
    const { filledRisk } = await getFilledRisk(ctx, { hashes: BOOK });

    expect(filledRisk.has(H_UNFILLED)).toBe(true);
    expect(filledRisk.get(H_UNFILLED)).toBe(0n);
  });

  it('throws OspexChainError when the aggregate fails — never a mapping of zeros', async () => {
    // NEGATIVE CONTROL, refuse half. A silent 0n here understates every
    // maker's filled risk, which OVERSTATES their remaining obligation on the
    // consumer's funding guard — the fail-open direction on a money path.
    const { ctx } = fakeContext({ aggregateError: new Error('execution reverted') });

    await expect(getFilledRisk(ctx, { hashes: BOOK })).rejects.toBeInstanceOf(OspexChainError);
  });

  it('throws when the head-block read fails, before any aggregate goes out', async () => {
    const { ctx, aggregates } = fakeContext({ headError: new Error('header not found') });

    await expect(getFilledRisk(ctx, { hashes: BOOK })).rejects.toBeInstanceOf(OspexChainError);
    expect(aggregates).toHaveLength(0);
  });

  it('throws on a short result array rather than pairing hashes with the wrong values', async () => {
    // A three-element answer to a four-hash request would zip H_LARGE against
    // nothing. Refuse the read rather than return a short or shifted mapping.
    const { ctx } = fakeContext({
      respondWith: () => [3_141_593n, 0n, FULL_RISK],
    });

    await expect(getFilledRisk(ctx, { hashes: BOOK })).rejects.toBeInstanceOf(OspexChainError);
  });

  it('throws on a non-bigint element rather than letting it reach the caller', async () => {
    const { ctx } = fakeContext({
      respondWith: () => [3_141_593n, 0n, FULL_RISK, '9007199254740993'],
    });

    await expect(getFilledRisk(ctx, { hashes: BOOK })).rejects.toBeInstanceOf(OspexChainError);
  });
});

describe('commitments.getFilledRisk — block pinning', () => {
  it('pins the aggregate to a caller-supplied block and does not ask for the head', async () => {
    const { ctx, aggregates, headCalls } = fakeContext();

    const snapshot = await getFilledRisk(ctx, { hashes: BOOK, blockNumber: PINNED_BLOCK });

    // The load-bearing assertion is the one on the RECORDED call: `atBlock`
    // alone would still read PINNED_BLOCK if the pin were dropped from the
    // aggregate, because it is echoed from the argument.
    expect(onlyAggregate(aggregates).blockNumber).toBe(PINNED_BLOCK);
    expect(snapshot.atBlock).toBe(PINNED_BLOCK);
    expect(headCalls()).toBe(0);
  });

  it('resolves the head block and pins the aggregate to THAT block when none is given', async () => {
    const { ctx, aggregates, headCalls } = fakeContext();

    const snapshot = await getFilledRisk(ctx, { hashes: BOOK });

    // Same reasoning: dropping the pin leaves `atBlock` correct and the
    // aggregate reading `latest`, so only the recorded value discriminates.
    expect(onlyAggregate(aggregates).blockNumber).toBe(HEAD_BLOCK);
    expect(snapshot.atBlock).toBe(HEAD_BLOCK);
    expect(headCalls()).toBe(1);
  });

  it('sends one aggregate for the whole book, not one call per hash', async () => {
    const { ctx, aggregates } = fakeContext();
    await getFilledRisk(ctx, { hashes: BOOK });
    expect(aggregates).toHaveLength(1);
    expect(onlyAggregate(aggregates).contracts).toHaveLength(BOOK.length);
  });
});

describe('commitments.getFilledRisk — what the aggregate actually asks for', () => {
  it('calls s_filledRisk on MatchingModule once per hash, failures not allowed', async () => {
    const { ctx, aggregates } = fakeContext();
    await getFilledRisk(ctx, { hashes: BOOK, blockNumber: PINNED_BLOCK });

    const aggregate = onlyAggregate(aggregates);
    expect(aggregate.contracts).toStrictEqual(
      BOOK.map((hash) => ({
        address: MATCHING_MODULE,
        abi: matchingModuleAbi,
        functionName: 's_filledRisk',
        args: [hash],
      })),
    );
    // `allowFailure: true` would turn a reverting call into
    // `{ status: 'failure', result: undefined }`, one coercion from 0n.
    expect(aggregate.allowFailure).toBe(false);
  });
});

describe('commitments.getFilledRisk — refusals happen before any RPC', () => {
  it('refuses an empty hash list', async () => {
    const { ctx, aggregates, headCalls } = fakeContext();
    await expect(getFilledRisk(ctx, { hashes: [] })).rejects.toBeInstanceOf(OspexValidationError);
    expect(aggregates).toHaveLength(0);
    expect(headCalls()).toBe(0);
  });

  it('refuses an entry that is not a 32-byte hash', async () => {
    const { ctx, aggregates, headCalls } = fakeContext();
    // Short-by-one, so the refusal is the length rule rather than a prefix or
    // an alphabet rule that a wholly different string would also trip.
    const short = ('0x' + '3c'.repeat(31) + '3') as Hex;
    await expect(getFilledRisk(ctx, { hashes: [H_PARTIAL, short] })).rejects.toBeInstanceOf(
      OspexValidationError,
    );
    expect(aggregates).toHaveLength(0);
    expect(headCalls()).toBe(0);
  });

  it('refuses the same hash twice, including in a different case', async () => {
    // Spelled out rather than `.toUpperCase()`, which would also upper-case
    // the `0x` prefix and be refused by the format rule instead — the wrong
    // reason for this case to go red.
    const sameHashUpper = ('0x' + '3C'.repeat(32)) as Hex;
    const { ctx, aggregates } = fakeContext();

    await expect(
      getFilledRisk(ctx, { hashes: [H_PARTIAL, H_FULL, sameHashUpper] }),
    ).rejects.toBeInstanceOf(OspexValidationError);
    expect(aggregates).toHaveLength(0);
  });

  it('accepts a book that only LOOKS like it has duplicates (control for the rule above)', async () => {
    // Two hashes differing in one nibble. If the duplicate rule were written
    // as a prefix or truncated comparison this would be refused; it must not be.
    const nearMiss = ('0x' + '3c'.repeat(31) + '3d') as Hex;
    const { ctx } = fakeContext({ chain: { [nearMiss.toLowerCase()]: 55_555n } });

    const { filledRisk } = await getFilledRisk(ctx, { hashes: [H_PARTIAL, nearMiss] });
    expect(filledRisk.get(nearMiss)).toBe(55_555n);
    expect(filledRisk.size).toBe(2);
  });

  it('refuses a negative block number', async () => {
    const { ctx, aggregates, headCalls } = fakeContext();
    await expect(
      getFilledRisk(ctx, { hashes: BOOK, blockNumber: -1n }),
    ).rejects.toBeInstanceOf(OspexValidationError);
    expect(aggregates).toHaveLength(0);
    expect(headCalls()).toBe(0);
  });

  it('accepts block 0 (control: the bound is negativity, not falsiness)', async () => {
    const { ctx, aggregates, headCalls } = fakeContext();
    const snapshot = await getFilledRisk(ctx, { hashes: BOOK, blockNumber: 0n });
    expect(snapshot.atBlock).toBe(0n);
    expect(onlyAggregate(aggregates).blockNumber).toBe(0n);
    expect(headCalls()).toBe(0);
  });
});

describe('commitments.getFilledRisk — public surface', () => {
  it('is reachable as client.commitments.getFilledRisk and routes into the validator', async () => {
    // Consumer-facing: reaches the method through the package barrel's
    // OspexClient rather than the free function, so deleting the delegate on
    // `class Commitments` reddens here. The client has no rpcUrl configured,
    // and the two errors below separate the two halves of the wiring — a bad
    // argument is refused BEFORE `requireChainClient()` (validation error), a
    // good one gets that far (config error). A stub method returning a fixed
    // value would produce neither.
    const client = new OspexClient({});
    await expect(client.commitments.getFilledRisk({ hashes: [] })).rejects.toBeInstanceOf(
      OspexValidationError,
    );
    await expect(client.commitments.getFilledRisk({ hashes: [H_PARTIAL] })).rejects.toBeInstanceOf(
      OspexConfigError,
    );
  });

  it('exports the arg and snapshot types from the package barrel', () => {
    // COMPILE-TIME assertion: vitest strips types without checking them, so
    // this case can only go red under `yarn typecheck:tests`. Deleting either
    // `export type` from `src/index.ts` breaks that run, not this one.
    const args: GetFilledRiskArgs = { hashes: BOOK, blockNumber: PINNED_BLOCK };
    const snapshot: FilledRiskSnapshot = { atBlock: PINNED_BLOCK, filledRisk: new Map() };
    expect(args.hashes).toHaveLength(BOOK.length);
    expect(snapshot.filledRisk.size).toBe(0);
  });
});
