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
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  multicall3Abi,
  type PublicClient,
} from 'viem';
import { polygon } from 'viem/chains';
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

  it('hands viem ONE multicall operation carrying every hash, not one call per hash', async () => {
    // Scope note: this fake replaces `publicClient.multicall` wholesale, so it
    // sits ABOVE the layer that decides how many `eth_call`s go out — it can
    // only ever show what the SDK handed viem, which is one operation whatever
    // the hash count. How many Multicall3 aggregates that becomes on the wire
    // is a viem decision, pinned by the chunk-coherence case at the bottom of
    // this file. Do not read this assertion as "one eth_call".
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

/* ------------------------------------------------------------------ */
/* Against a REAL viem client, over a counting transport               */
/* ------------------------------------------------------------------ */

/**
 * Everything above drives a hand-rolled fake `publicClient`, which can only
 * ever show what the SDK HANDED viem. Two properties live below viem and a
 * fake cannot see either of them:
 *
 *  1. `atBlock` is a FRESH head. `OspexClient` memoises its viem client and
 *     viem's `getBlockNumber` caches per client for `cacheTime` (default
 *     `pollingInterval`, 4_000 ms), so at the library default a polling
 *     caller — which is what a funding guard is — would be handed a head up
 *     to 4s old on every call after the first. The aggregate stays coherent,
 *     but a fill landing in those seconds is invisible, leaving filled risk
 *     stale-low and the maker's remaining obligation overstated. That is the
 *     direction of the bug this read exists to remove.
 *  2. The pin reaches the WIRE. Asserting the `blockNumber` the SDK passed
 *     to `multicall` cannot distinguish "viem forwarded it" from "viem
 *     dropped it"; the block parameter on the outgoing `eth_call` can.
 *
 * The transport answers a real ABI-encoded `aggregate3` result, so this case
 * also exercises the encode/decode path the fakes stub out.
 */

const AGGREGATE3_RESULT = [
  {
    type: 'tuple[]',
    components: [
      { name: 'success', type: 'bool' },
      { name: 'returnData', type: 'bytes' },
    ],
  },
] as const;

interface WireProbe {
  ctx: CommitmentsContext;
  publicClient: PublicClient;
  methodCounts: Map<string, number>;
  callBlockParams: unknown[];
}

/**
 * A viem client whose transport answers a fresh, STRICTLY INCREASING head on
 * every `eth_blockNumber`. Increasing rather than constant so a cached answer
 * is visible in the value as well as in the request count — two independent
 * tells for the same defect.
 */
function wireProbe(values: readonly bigint[], firstHead = 71_234_567n): WireProbe {
  const methodCounts = new Map<string, number>();
  const callBlockParams: unknown[] = [];
  let head = firstHead;

  const publicClient = createPublicClient({
    chain: polygon,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
        if (method === 'eth_blockNumber') {
          const answer = head;
          head += 1n;
          return `0x${answer.toString(16)}`;
        }
        if (method === 'eth_call') {
          callBlockParams.push((params as unknown[])[1]);
          return encodeAbiParameters(AGGREGATE3_RESULT, [
            values.map((v) => ({
              success: true,
              returnData: encodeAbiParameters([{ type: 'uint256' }], [v]),
            })),
          ]);
        }
        throw new Error(`unexpected RPC method ${method} — the probe cannot answer it`);
      },
    }),
  });

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

  return { ctx, publicClient, methodCounts, callBlockParams };
}

describe('commitments.getFilledRisk — over a real viem client', () => {
  it('decodes a real aggregate3 response into the mapping', async () => {
    // Proves the ABI encode/decode round trip the fake clients stub out: the
    // artifact's `s_filledRisk(bytes32)` entry encodes, and viem's multicall
    // decoder returns bigints in request order.
    const { ctx } = wireProbe([3_141_593n, 0n]);

    const { filledRisk } = await getFilledRisk(ctx, { hashes: [H_PARTIAL, H_UNFILLED] });

    expect([...filledRisk.entries()]).toStrictEqual([
      [H_PARTIAL, 3_141_593n],
      [H_UNFILLED, 0n],
    ]);
  });

  it('resolves a FRESH head on every unpinned call, never a cached one', async () => {
    const { ctx, methodCounts } = wireProbe([3_141_593n, 0n]);

    const first = await getFilledRisk(ctx, { hashes: [H_PARTIAL, H_UNFILLED] });
    const second = await getFilledRisk(ctx, { hashes: [H_PARTIAL, H_UNFILLED] });

    expect(methodCounts.get('eth_blockNumber')).toBe(2);
    expect(second.atBlock).toBe(first.atBlock + 1n);
  });

  it('control: viem DOES cache the head at its default, so the case above is not vacuous', async () => {
    // NEGATIVE CONTROL for the case above (rule 3b-rescue: name the rival).
    // Without this, "two calls, two requests" could also be explained by the
    // probe having no cache to defeat — and the assertion would prove nothing.
    // Same client, same transport, `getBlockNumber` at viem's default: one
    // request answers both, and the second answer is the FIRST head.
    const { publicClient, methodCounts } = wireProbe([0n]);

    const a = await publicClient.getBlockNumber();
    const b = await publicClient.getBlockNumber();

    expect(methodCounts.get('eth_blockNumber')).toBe(1);
    expect(b).toBe(a);
  });

  it('puts the pinned block on the WIRE, not just in the multicall argument', async () => {
    const { ctx, callBlockParams, methodCounts } = wireProbe([3_141_593n, 0n]);

    await getFilledRisk(ctx, { hashes: [H_PARTIAL, H_UNFILLED], blockNumber: PINNED_BLOCK });

    // viem sends `eth_call` as [{ to, data }, <block>]. A dropped pin sends
    // 'latest'; only a transmitted one sends this hex.
    expect(callBlockParams).toStrictEqual([`0x${PINNED_BLOCK.toString(16)}`]);
    expect(methodCounts.get('eth_blockNumber')).toBeUndefined();
  });

  it('puts the RESOLVED head on the wire when no block was given', async () => {
    const { ctx, callBlockParams } = wireProbe([3_141_593n, 0n]);

    const snapshot = await getFilledRisk(ctx, { hashes: [H_PARTIAL, H_UNFILLED] });

    expect(callBlockParams).toStrictEqual([`0x${snapshot.atBlock.toString(16)}`]);
  });
});

/* ------------------------------------------------------------------ */
/* Chunking — several aggregates, one block                            */
/* ------------------------------------------------------------------ */

/**
 * One viem `multicall` operation is not one `eth_call`. viem splits the
 * aggregate when its calldata outgrows `batchSize` (default 1024 bytes; a
 * `s_filledRisk(bytes32)` Call3 is 36 bytes of payload plus tuple overhead),
 * so a large book leaves as several Multicall3 aggregates. Measured on viem
 * 2.55.10: 60 hashes → three `eth_call`s of 28 + 28 + 4.
 *
 * That split is fine, and the docs used to say the opposite. What makes it
 * fine is that `readFilledRiskAtBlock` passes `blockNumber` INTO the
 * multicall, so viem stamps every chunk with the same block — the values
 * still describe one instant. This case pins that: several calls, one block,
 * and every hash paired with its own value across the chunk seams.
 *
 * The transport below answers each chunk from the chunk's OWN calldata rather
 * than from a fixed array, so a mis-stitched result cannot be masked by every
 * chunk being handed the same answers.
 */

/** Enough hashes to clear the boundary by a wide margin at viem 2.55.10 (3 chunks). */
const CHUNKED_HASH_COUNT = 60;

/**
 * Distinct hashes with distinct, non-round values derived from the hash byte
 * itself. Deriving the EXPECTATION from the hash rather than from a position
 * is what makes a cross-chunk mis-pairing visible: a swap between chunk 2 and
 * chunk 3 changes which value a hash carries, and no positional coincidence
 * covers it.
 */
function chunkedHash(i: number): Hex {
  return ('0x' + i.toString(16).padStart(2, '0').repeat(32)) as Hex;
}
function chunkedValueFor(hash: Hex): bigint {
  // Non-round, > 2^32, and unique per hash — a truncation, a Number() round
  // trip or a reused chunk answer all have to disagree with it.
  return BigInt(`0x${hash.slice(2, 4)}`) * 1_000_000_007n + 3_141_593n;
}

interface ChunkProbe {
  ctx: CommitmentsContext;
  /** Number of Call3 entries in each outgoing `eth_call`, in request order. */
  chunkSizes: number[];
  /** The block parameter of each outgoing `eth_call`. */
  callBlockParams: unknown[];
}

function chunkProbe(headBlock: bigint): ChunkProbe {
  const chunkSizes: number[] = [];
  const callBlockParams: unknown[] = [];

  const publicClient = createPublicClient({
    chain: polygon,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'eth_blockNumber') return `0x${headBlock.toString(16)}`;
        if (method === 'eth_call') {
          const [tx, block] = params as [{ data: Hex }, unknown];
          callBlockParams.push(block);
          const decoded = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
          const calls = decoded.args[0] as readonly { callData: Hex }[];
          chunkSizes.push(calls.length);
          return encodeAbiParameters(AGGREGATE3_RESULT, [
            calls.map((call) => ({
              success: true,
              // The last 32 bytes of `s_filledRisk(bytes32)` calldata are the
              // hash this element asked about — answer THAT hash's value.
              returnData: encodeAbiParameters(
                [{ type: 'uint256' }],
                [chunkedValueFor(`0x${call.callData.slice(-64)}` as Hex)],
              ),
            })),
          ]);
        }
        throw new Error(`unexpected RPC method ${method} — the probe cannot answer it`);
      },
    }),
  });

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

  return { ctx, chunkSizes, callBlockParams };
}

describe('commitments.getFilledRisk — a chunked read stays on one block', () => {
  it('splits into MORE THAN ONE eth_call and pins every one of them to the same block', async () => {
    const hashes = Array.from({ length: CHUNKED_HASH_COUNT }, (_, i) => chunkedHash(i));
    const { ctx, chunkSizes, callBlockParams } = chunkProbe(HEAD_BLOCK);

    const { atBlock, filledRisk } = await getFilledRisk(ctx, { hashes });

    // (i) The fixture must actually clear a chunk boundary, asserted BEFORE
    // the coherence claim. If a viem bump raises `batchSize`, 60 hashes could
    // fit in one call and every assertion below would still pass while
    // proving nothing about chunking — this line reddens instead, and the fix
    // is to raise CHUNKED_HASH_COUNT, not to delete the case.
    expect(chunkSizes.length).toBeGreaterThan(1);
    // ...and it must still be BATCHING, not degenerating to one call per hash.
    expect(chunkSizes.length).toBeLessThan(CHUNKED_HASH_COUNT);
    expect(chunkSizes.reduce((a, b) => a + b, 0)).toBe(CHUNKED_HASH_COUNT);

    // (ii) Every chunk carried the pinned block. `new Set` collapses to one
    // entry only when they agree; asserting the set (not just the first
    // element) is what makes a per-chunk drift visible.
    expect(new Set(callBlockParams.map(String)).size).toBe(1);
    expect(callBlockParams).toStrictEqual(
      callBlockParams.map(() => `0x${HEAD_BLOCK.toString(16)}`),
    );
    expect(atBlock).toBe(HEAD_BLOCK);

    // (iii) The chunks were stitched back in input order — every hash carries
    // its OWN value across the seams, not its neighbour's.
    expect([...filledRisk.entries()]).toStrictEqual(
      hashes.map((hash) => [hash, chunkedValueFor(hash)]),
    );
  });

  it('pins every chunk to a caller-supplied block too', async () => {
    const hashes = Array.from({ length: CHUNKED_HASH_COUNT }, (_, i) => chunkedHash(i));
    // headBlock is deliberately NOT the pinned block, so a chunk that fell
    // back to the head (or to `latest`) cannot coincide with the expectation.
    const { ctx, chunkSizes, callBlockParams } = chunkProbe(HEAD_BLOCK);

    const { atBlock } = await getFilledRisk(ctx, { hashes, blockNumber: PINNED_BLOCK });

    expect(chunkSizes.length).toBeGreaterThan(1);
    expect(callBlockParams).toStrictEqual(
      callBlockParams.map(() => `0x${PINNED_BLOCK.toString(16)}`),
    );
    expect(atBlock).toBe(PINNED_BLOCK);
  });
});
