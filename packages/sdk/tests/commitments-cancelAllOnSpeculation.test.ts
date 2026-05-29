/**
 * `client.commitments.cancelAllOnSpeculation(args)` — explicit-newMinNonce
 * gating + invalidatedCount preview (M5/PR1).
 *
 * The function requires an explicit `newMinNonce` (own-state SSE plan §M2:
 * the public commitments list filters `book_visible=true` upstream, so any
 * SDK-side default sourced from that list could silently leave a maker's
 * cross-process book-hidden commitments matchable). These tests pin the
 * required-arg gate, the explicit-override execute path, the visible-rows
 * `invalidatedCount` preview, the pagination loop, and the defensive
 * hidden-row narrow that keeps the function from crashing if a hidden body
 * ever leaks into the public list response.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { cancelAllOnSpeculation } from '../src/commitments/cancelAllOnSpeculation.js';
import { NonceCounter } from '../src/commitments/context.js';
import { deriveSpeculationKey } from '../src/chain/eip712.js';
import { matchingModuleAbi } from '../src/contracts/abi/index.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { CommitmentBody, CommitmentsListBody } from '../src/api/types.js';
import type { Signer } from '../src/types/signer.js';

const SIGNER_ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';
const SCORER = ('0x' + 'dd'.repeat(20)) as `0x${string}`;
const CONTEST_ID = 42n;
const LINE_TICKS = -35;
const SPEC_KEY = deriveSpeculationKey(CONTEST_ID, SCORER.toLowerCase() as Hex, LINE_TICKS);

interface RowOverrides {
  nonce: string;
  status: CommitmentBody['status'];
  nonceInvalidated?: boolean;
  speculationKey?: string;
}

function makeRow(overrides: RowOverrides): CommitmentBody {
  return {
    commitmentHash: '0x' + 'cc'.repeat(32),
    maker: SIGNER_ADDR,
    contestId: CONTEST_ID.toString(),
    scorer: SCORER,
    lineTicks: LINE_TICKS,
    positionType: 0,
    oddsTick: 191,
    marketType: 'spread',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: overrides.nonce,
    expiry: '2099-01-01T00:00:00.000Z',
    speculationKey: overrides.speculationKey ?? SPEC_KEY,
    signature: '0x' + 'cc'.repeat(65),
    status: overrides.status,
    source: 'agent',
    network: 'polygon',
    nonceInvalidated: overrides.nonceInvalidated ?? false,
    createdAt: '2026-05-04T00:00:00.000Z',
  };
}

interface FakeOpts {
  /**
   * If `pageSize` is provided, `rows` is sliced into pages of that
   * size and the API mock honors `query.offset` to return the matching
   * slice. `hasMore` is set when more rows exist past `offset+pageSize`.
   * Otherwise (the legacy path) all rows come back in a single page
   * with `hasMore: false`.
   */
  rows: CommitmentBody[];
  pageSize?: number;
  onChainFloor: bigint;
  preObserve?: { speculationKey: string; nonce: bigint };
}

function fakeContext(opts: FakeOpts): {
  ctx: CommitmentsContext;
  sentTxs: { to: Hex; data: Hex }[];
  apiCallCount: () => number;
} {
  const txHash = ('0x' + 'bb'.repeat(32)) as Hash;
  const receipt = {
    status: 'success',
    transactionHash: txHash,
    blockNumber: 1234n,
    logs: [],
  } as unknown as TransactionReceipt;
  const sentTxs: { to: Hex; data: Hex }[] = [];
  let apiCalls = 0;

  // We need to capture the calldata that gets signed so we can decode
  // it and assert the on-chain newMinNonce. We do that via the signer
  // (which receives `to` + `data`).
  const publicClient = {
    sendRawTransaction: async () => txHash,
    waitForTransactionReceipt: async () => receipt,
    getTransactionCount: async () => 1,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 50n, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => 60_000n,
    readContract: async () => opts.onChainFloor,
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => SIGNER_ADDR as `0x${string}`,
    signTypedData: async () => '0xdead' as `0x${string}`,
    signTransaction: async (args) => {
      sentTxs.push({ to: args.to as Hex, data: args.data as Hex });
      return '0xfeed' as `0x${string}`;
    },
  };

  const nonceCounter = new NonceCounter();
  if (opts.preObserve) {
    nonceCounter.observe(SIGNER_ADDR, opts.preObserve.speculationKey, opts.preObserve.nonce);
  }

  const ctx: CommitmentsContext = {
    api: {
      request: async (
        _path: string,
        init?: { query?: Record<string, string | number | boolean | undefined> },
      ): Promise<unknown> => {
        apiCalls += 1;
        const offset = Number(init?.query?.offset ?? 0);
        if (opts.pageSize !== undefined) {
          const page = opts.rows.slice(offset, offset + opts.pageSize);
          const body: CommitmentsListBody = {
            commitments: page,
            pagination: {
              limit: opts.pageSize,
              offset,
              total: opts.rows.length,
              hasMore: offset + page.length < opts.rows.length,
            },
          };
          return body;
        }
        const body: CommitmentsListBody = {
          commitments: opts.rows,
          pagination: { limit: 1000, offset: 0, total: opts.rows.length, hasMore: false },
        };
        return body;
      },
    } as unknown as CommitmentsContext['api'],
    requireSigner: () => signer,
    getChainId: () => 137,
    getAddresses: () =>
      ({
        matchingModule: ('0x' + '11'.repeat(20)) as `0x${string}`,
      }) as unknown as ReturnType<CommitmentsContext['getAddresses']>,
    requireChainClient: () => publicClient,
    nonceCounter,
  };
  return { ctx, sentTxs, apiCallCount: () => apiCalls };
}

function decodeRaiseMinNonceCall(data: Hex): { newMinNonce: bigint } {
  const decoded = decodeFunctionData({
    abi: matchingModuleAbi,
    data,
  });
  if (decoded.functionName !== 'raiseMinNonce') {
    throw new Error(`unexpected function: ${String(decoded.functionName)}`);
  }
  const args = decoded.args as readonly [bigint, `0x${string}`, number, bigint];
  return { newMinNonce: args[3]! };
}

describe('commitments.cancelAllOnSpeculation', () => {
  const baseArgs = {
    contestId: CONTEST_ID,
    scorer: SCORER,
    lineTicks: LINE_TICKS,
  };

  // ── newMinNonce is REQUIRED (M5/PR1 — Hermes round 3) ──────────────────
  // Auto-computing a default from the public list cannot be hidden-safe
  // (the list filters `book_visible=true` upstream; a maker's hidden book
  // is invisible to anonymous reads), so we removed the auto-default and
  // require the caller to supply the floor. Until M5/PR3 wires owner-auth
  // own-state recovery, callers using book-hide must source the floor
  // themselves; everyone else passes a floor they're confident covers
  // their open commitments.

  it('requires an explicit newMinNonce — throws OspexValidationError({ field: "newMinNonce" }) when undefined', async () => {
    const { ctx } = fakeContext({ onChainFloor: 0n, rows: [] });
    await expect(
      cancelAllOnSpeculation(
        ctx,
        // Force the dynamic call path: the type says newMinNonce is
        // required, but the runtime guard must also catch a stale caller.
        baseArgs as unknown as Parameters<typeof cancelAllOnSpeculation>[1],
      ),
    ).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'newMinNonce',
      message: expect.stringContaining('explicit newMinNonce'),
    });
  });

  it('rejects newMinNonce <= 0', async () => {
    const { ctx } = fakeContext({ onChainFloor: 0n, rows: [] });
    await expect(
      cancelAllOnSpeculation(ctx, { ...baseArgs, newMinNonce: 0n }),
    ).rejects.toMatchObject({ name: 'OspexValidationError', field: 'newMinNonce' });
  });

  it('explicit newMinNonce → sends raiseMinNonce with that exact value', async () => {
    const { ctx, sentTxs } = fakeContext({
      onChainFloor: 1_000n,
      rows: [makeRow({ nonce: '500', status: 'open' })],
    });
    const result = await cancelAllOnSpeculation(ctx, { ...baseArgs, newMinNonce: 12_345n });
    expect(result.newMinNonce).toBe(12_345n);
    expect(decodeRaiseMinNonceCall(sentTxs[0]!.data).newMinNonce).toBe(12_345n);
  });

  it('invalidatedCount counts only currently-matchable VISIBLE rows below newMinNonce', async () => {
    const { ctx } = fakeContext({
      onChainFloor: 0n,
      rows: [
        makeRow({ nonce: '100', status: 'open' }), // counted
        makeRow({ nonce: '101', status: 'partially_filled' }), // counted
        makeRow({ nonce: '102', status: 'cancelled' }), // skipped — terminal
        makeRow({ nonce: '103', status: 'filled' }), // skipped — terminal
        makeRow({ nonce: '104', status: 'open', nonceInvalidated: true }), // skipped — already invalid
        // Wrong-speculation row — should be filtered out by speculationKey:
        makeRow({
          nonce: '999',
          status: 'open',
          speculationKey: ('0x' + 'ff'.repeat(32)) as Hex,
        }),
      ],
    });
    const result = await cancelAllOnSpeculation(ctx, { ...baseArgs, newMinNonce: 1_000n });
    expect(result.invalidatedCount).toBe(2);
  });

  it('rows above newMinNonce are not counted', async () => {
    const { ctx } = fakeContext({
      onChainFloor: 0n,
      rows: [makeRow({ nonce: '100', status: 'open' })],
    });
    const result = await cancelAllOnSpeculation(ctx, { ...baseArgs, newMinNonce: 50n });
    expect(result.invalidatedCount).toBe(0);
  });

  it('paginates past page 1 when computing the visible-rows invalidatedCount preview', async () => {
    // Maker has 7 commitments on this speculation. With pageSize=3, the
    // SDK has to fetch 3 pages to see them all. The invalidatedCount
    // counts every visible matching row below newMinNonce — a
    // single-page implementation would miss pages 2-3.
    const rows: CommitmentBody[] = [];
    for (const n of [1000, 2000, 1500]) rows.push(makeRow({ nonce: String(n), status: 'open' }));
    for (const n of [50_000, 3000, 4000]) rows.push(makeRow({ nonce: String(n), status: 'open' }));
    rows.push(makeRow({ nonce: '5000', status: 'open' }));

    const { ctx, apiCallCount } = fakeContext({
      onChainFloor: 0n,
      rows,
      pageSize: 3,
    });
    const result = await cancelAllOnSpeculation(ctx, {
      ...baseArgs,
      newMinNonce: 100_000n,
    });
    expect(result.newMinNonce).toBe(100_000n);
    expect(result.invalidatedCount).toBe(7);
    // 3 GET requests (3-3-1) is the expected pagination cost.
    expect(apiCallCount()).toBe(3);
  });

  it('stops paginating when hasMore=false', async () => {
    const rows: CommitmentBody[] = [
      makeRow({ nonce: '100', status: 'open' }),
      makeRow({ nonce: '200', status: 'open' }),
    ];
    const { ctx, apiCallCount } = fakeContext({ onChainFloor: 0n, rows, pageSize: 1000 });
    await cancelAllOnSpeculation(ctx, { ...baseArgs, newMinNonce: 1_000n });
    // 2 rows fit in one 1000-page → exactly 1 API call.
    expect(apiCallCount()).toBe(1);
  });

  // ── Hidden-row defensive narrow (M5/PR1) ────────────────────────────────
  // The PUBLIC list is filtered to `book_visible=true` upstream (core-api M2),
  // so in production hidden bodies don't reach this function — the maker's
  // hidden book is fundamentally invisible to anonymous reads. The
  // explicit-newMinNonce requirement (above) protects against the
  // latent-exposure failure mode; this narrow is the type-level + runtime
  // belt-and-braces that prevents the function from crashing if a hidden
  // body ever slips through (a future recovery-overlap response, a server
  // bug).
  it('defensively skips a hidden row leaked into the list response without crashing', async () => {
    const hiddenRow = {
      redacted: true as const,
      payloadAvailable: false as const,
      commitmentHash: '0x' + 'cd'.repeat(32),
      maker: SIGNER_ADDR,
      contestId: CONTEST_ID.toString(),
      positionType: 0 as const,
      status: 'cancelled' as const,
      storedStatus: 'open' as const,
      filledRiskAmount: '0',
      expiry: '2099-01-01T00:00:00.000Z',
      bookVisible: false as const,
      nonceInvalidated: false,
    };
    const rows = [
      makeRow({ nonce: '100', status: 'open' }),
      hiddenRow as unknown as CommitmentBody,
      makeRow({ nonce: '200', status: 'open' }),
    ];
    const { ctx, sentTxs } = fakeContext({ onChainFloor: 0n, rows });
    const result = await cancelAllOnSpeculation(ctx, { ...baseArgs, newMinNonce: 1_000n });
    expect(result.newMinNonce).toBe(1_000n);
    expect(result.invalidatedCount).toBe(2);
    expect(sentTxs).toHaveLength(1);
  });
});
