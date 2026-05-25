/**
 * `client.positions.ensurePositionClaimed` — the idempotent claim path,
 * the claim-side mirror of `ensureSpeculationSettled`. Branches:
 *   1. pre-flight read unclaimed → sends claim          → 'claimed' (+payout)
 *   2. pre-flight read claimed → no tx                  → 'alreadyClaimed'
 *   3. unclaimed, claim pre-send-reverts AlreadyClaimed,
 *      re-read claimed                                  → 'recovered'
 *   4. unclaimed, claim reverts NotSettled, re-read
 *      still unclaimed                                  → rethrows (loud)
 *   4b. same for NoPayout                               → rethrows (loud)
 *   5. pre-flight read fails → falls through, claim ok  → 'claimed'
 *   6. unclaimed, claim PROVABLY reverts on inclusion,
 *      re-read claimed                                  → 'recovered'
 *   7. unclaimed, claim tx SUCCEEDS but POSITION_CLAIMED
 *      event missing/unparseable                        → stays loud (NOT recovered)
 *   8. unclaimed, claim reverts but re-read still
 *      unclaimed                                        → stays loud
 *
 * Plus the non-negotiable claim-side guarantees:
 *   - `alreadyClaimed` / `recovered` carry NO payout (the contract zeroes
 *     economic fields post-claim; the SDK never fabricates one).
 *   - `NotSettled` / `NoPayout` stay loud (only `AlreadyClaimed` is benign).
 *   - state-based recovery requires a PROVEN on-chain revert — a confirmed
 *     tx with an unparseable event is a loud failure, never a recovery (the
 *     #98 review blocker).
 *
 * The chain client is faked: `readContract` is driven by a queue of
 * getPosition responses, and the claim pipeline (estimateGas → sign →
 * broadcast → receipt) is programmable per test.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toBytes,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { ensurePositionClaimed } from '../src/positions/ensureClaimed.js';
import { OspexChainError, OspexValidationError } from '../src/errors.js';
import type { PositionsContext } from '../src/positions/context.js';
import type { Signer } from '../src/types/signer.js';

const SIGNER_ADDR = '0xabcdefabcdef0123456789abcdef0123456789ab';
const OSPEX_CORE = '0x0000000000000000000000000000000000abcdef' as `0x${string}`;
const POSITION_MODULE = '0x0000000000000000000000000000000000beef00' as `0x${string}`;

const EVENT_TYPE_CLAIMED = keccak256(toBytes('POSITION_CLAIMED'));
const ALREADY_CLAIMED_SELECTOR = keccak256(toBytes('PositionModule__AlreadyClaimed()')).slice(0, 10);
const NOT_SETTLED_SELECTOR = keccak256(toBytes('PositionModule__NotSettled()')).slice(0, 10);
const NO_PAYOUT_SELECTOR = keccak256(toBytes('PositionModule__NoPayout()')).slice(0, 10);

// Cross-check the runtime-computed selectors against the published ABI
// selectors — guards against an upstream custom-error rename silently
// breaking recovery classification.
describe('PositionModule error selectors', () => {
  it('match the published ABI selectors', () => {
    expect(ALREADY_CLAIMED_SELECTOR).toBe('0x9ec7917e');
    expect(NOT_SETTLED_SELECTOR).toBe('0x0c95096e');
    expect(NO_PAYOUT_SELECTOR).toBe('0xd3467fd7');
  });
});

const CORE_EVENT_EMITTED_ABI = [
  {
    type: 'event',
    name: 'CoreEventEmitted',
    inputs: [
      { name: 'eventType', type: 'bytes32', indexed: true },
      { name: 'emitter', type: 'address', indexed: true },
      { name: 'eventData', type: 'bytes', indexed: false },
    ],
    anonymous: false,
  },
] as const;

function makeClaimedLog(
  speculationId: bigint,
  user: `0x${string}`,
  positionType: 0 | 1,
  payout: bigint,
): { address: `0x${string}`; topics: Hash[]; data: `0x${string}` } {
  const innerEventData = encodeAbiParameters(
    [
      { name: 'speculationId', type: 'uint256' },
      { name: 'user', type: 'address' },
      { name: 'positionType', type: 'uint8' },
      { name: 'payout', type: 'uint256' },
    ],
    [speculationId, user, positionType, payout],
  );
  const wrappedData = encodeAbiParameters([{ type: 'bytes' }], [innerEventData]);
  const topics = encodeEventTopics({
    abi: CORE_EVENT_EMITTED_ABI,
    eventName: 'CoreEventEmitted',
    args: { eventType: EVENT_TYPE_CLAIMED, emitter: OSPEX_CORE },
  });
  return { address: OSPEX_CORE, topics: topics as Hash[], data: wrappedData };
}

type PositionRead = { claimed: boolean } | Error;

function fakeCtx(opts: {
  reads: PositionRead[];
  estimateGas?: () => Promise<bigint>;
  receiptStatus?: 'success' | 'reverted';
  claimedLog?: { address: `0x${string}`; topics: Hash[]; data: `0x${string}` };
}): { ctx: PositionsContext; sendRaw: ReturnType<typeof vi.fn> } {
  let readIdx = 0;
  const sendRaw = vi.fn(async () => ('0x' + 'aa'.repeat(32)) as Hash);
  // The receipt `broadcastSignedTx` sees. On a non-success status it attaches
  // this to the thrown OspexChainError — so it carries gas fields, letting a
  // recovered inclusion-time race be billed without a separate re-fetch.
  const receipt = {
    status: opts.receiptStatus ?? 'success',
    transactionHash: ('0x' + 'aa'.repeat(32)) as Hash,
    blockNumber: 12345n,
    gasUsed: 50_000n,
    effectiveGasPrice: 30_000_000_000n,
    logs: opts.claimedLog ? [opts.claimedLog] : [],
  } as unknown as TransactionReceipt;

  const publicClient = {
    readContract: async () => {
      const r = opts.reads[readIdx++];
      if (r === undefined) throw new Error(`unexpected readContract call #${readIdx}`);
      if (r instanceof Error) throw r;
      return r;
    },
    sendRawTransaction: sendRaw,
    waitForTransactionReceipt: async () => receipt,
    getTransactionCount: async () => 7,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 50n, maxPriorityFeePerGas: 1n }),
    estimateGas: opts.estimateGas ?? (async () => 80_000n),
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => SIGNER_ADDR as `0x${string}`,
    signTypedData: async () => '0xdead' as `0x${string}`,
    signTransaction: async () => '0xfeed' as `0x${string}`,
  };

  const ctx: PositionsContext = {
    api: { request: async () => ({}) } as unknown as PositionsContext['api'],
    positionsApi: {} as unknown as PositionsContext['positionsApi'],
    requireSigner: () => signer,
    getChainId: () => 137,
    getAddresses: () =>
      ({
        matchingModule: '0x' + '11'.repeat(20),
        positionModule: POSITION_MODULE,
        usdc: '0x' + '33'.repeat(20),
        ospexCore: OSPEX_CORE,
        speculationModule: '0x' + '44'.repeat(20),
        contestModule: '0x' + '55'.repeat(20),
        leaderboardModule: '0x' + '66'.repeat(20),
        rulesModule: '0x' + '77'.repeat(20),
        treasuryModule: '0x' + '88'.repeat(20),
        secondaryMarketModule: '0x' + '99'.repeat(20),
        oracleModule: '0x' + 'aa'.repeat(20),
        scorers: {
          moneyline: '0x' + 'bb'.repeat(20),
          spread: '0x' + 'cc'.repeat(20),
          total: '0x' + 'dd'.repeat(20),
        },
      }) as unknown as ReturnType<PositionsContext['getAddresses']>,
    requireChainClient: () => publicClient,
  };
  return { ctx, sendRaw };
}

/** An error shaped like a viem pre-send revert carrying raw revert data. */
function revertWithData(data: string): Error {
  return Object.assign(new Error('execution reverted'), { data });
}

describe('positions.ensurePositionClaimed', () => {
  it('1. sends the claim tx when the position is unclaimed (payout event-sourced)', async () => {
    const { ctx, sendRaw } = fakeCtx({
      reads: [{ claimed: false }], // pre-flight: unclaimed
      claimedLog: makeClaimedLog(42n, SIGNER_ADDR as `0x${string}`, 0, 191_000_000n),
    });
    const r = await ensurePositionClaimed(ctx, { speculationId: 42n, positionType: 0 });
    expect(r.outcome).toBe('claimed');
    expect(r.payoutWei6).toBe(191_000_000n);
    expect(r.payoutUSDC).toBeCloseTo(191, 6);
    expect(r.txHash).toMatch(/^0x[0-9a-f]+$/);
    expect(r.blockNumber).toBe(12345n);
    expect(sendRaw).toHaveBeenCalledTimes(1);
  });

  it('2. skips the tx when the position is already claimed (pre-flight) — no payout', async () => {
    const { ctx, sendRaw } = fakeCtx({
      reads: [{ claimed: true }], // pre-flight: already claimed
    });
    const r = await ensurePositionClaimed(ctx, { speculationId: 42n, positionType: 1 });
    expect(r.outcome).toBe('alreadyClaimed');
    expect(r.positionType).toBe(1);
    expect(r.txHash).toBeUndefined();
    // No derived payout — economic fields are zeroed post-claim.
    expect(r.payoutWei6).toBeUndefined();
    expect(r.payoutUSDC).toBeUndefined();
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it('3. recovers when the claim pre-send-reverts AlreadyClaimed (no tx broadcast, no payout)', async () => {
    const { ctx, sendRaw } = fakeCtx({
      reads: [
        { claimed: false }, // pre-flight: unclaimed
        { claimed: true }, // re-read: claimed
      ],
      estimateGas: async () => {
        throw revertWithData(ALREADY_CLAIMED_SELECTOR);
      },
    });
    const r = await ensurePositionClaimed(ctx, { speculationId: 42n, positionType: 0 });
    expect(r.outcome).toBe('recovered');
    expect(r.payoutWei6).toBeUndefined();
    // Pre-send revert — nothing was broadcast, so no reverted tx hash.
    expect(r.revertedTxHash).toBeUndefined();
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it('4. rethrows a genuine NotSettled failure (re-read still unclaimed) — stays loud', async () => {
    const { ctx } = fakeCtx({
      reads: [
        { claimed: false }, // pre-flight: unclaimed
        { claimed: false }, // re-read: still unclaimed
      ],
      estimateGas: async () => {
        throw revertWithData(NOT_SETTLED_SELECTOR);
      },
    });
    await expect(
      ensurePositionClaimed(ctx, { speculationId: 42n, positionType: 0 }),
    ).rejects.toBeInstanceOf(OspexChainError);
  });

  it('4b. rethrows a genuine NoPayout failure (re-read still unclaimed) — stays loud', async () => {
    const { ctx } = fakeCtx({
      reads: [
        { claimed: false },
        { claimed: false },
      ],
      estimateGas: async () => {
        throw revertWithData(NO_PAYOUT_SELECTOR);
      },
    });
    await expect(
      ensurePositionClaimed(ctx, { speculationId: 42n, positionType: 0 }),
    ).rejects.toBeInstanceOf(OspexChainError);
  });

  it('5. degrades gracefully when the pre-flight read fails, then claims', async () => {
    const { ctx, sendRaw } = fakeCtx({
      reads: [new Error('rpc hiccup')], // pre-flight read throws
      claimedLog: makeClaimedLog(42n, SIGNER_ADDR as `0x${string}`, 0, 50_000_000n),
    });
    const r = await ensurePositionClaimed(ctx, { speculationId: 42n, positionType: 0 });
    expect(r.outcome).toBe('claimed');
    expect(r.payoutWei6).toBe(50_000_000n);
    expect(sendRaw).toHaveBeenCalledTimes(1);
  });

  it('6. recovers from a PROVEN inclusion-time revert via re-read, preserving the reverted tx hash + receipt', async () => {
    const { ctx, sendRaw } = fakeCtx({
      reads: [
        { claimed: false }, // pre-flight: unclaimed
        { claimed: true }, // re-read: claimed
      ],
      receiptStatus: 'reverted', // estimateGas ok, but the mined tx reverts
    });
    const r = await ensurePositionClaimed(ctx, { speculationId: 42n, positionType: 0 });
    expect(r.outcome).toBe('recovered');
    expect(r.payoutWei6).toBeUndefined(); // not event-sourced
    expect(r.txHash).toBeUndefined(); // not a confirmed claim
    // This wallet DID broadcast a claim that reverted — the audit trail must
    // keep its hash AND the authoritative (broadcast-time) receipt so the gas
    // it spent can be accounted.
    expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(r.revertedTxHash).toBe(('0x' + 'aa'.repeat(32)) as `0x${string}`);
    expect(r.revertedReceipt).toBeDefined();
    expect(r.revertedReceipt?.status).toBe('reverted');
    expect(r.revertedReceipt?.gasUsed).toBe(50_000n);
    expect(r.revertedReceipt?.effectiveGasPrice).toBe(30_000_000_000n);
  });

  // #98 review blocker: strict claim() throws OspexChainError({ txHash }) when
  // a SUCCESSFUL tx had no parseable POSITION_CLAIMED event. The payout really
  // happened (so a post-read says claimed) — but that error carries NO
  // reverted receipt, so recovery MUST NOT fire. Mislabeling it 'recovered'
  // would drop a real payout and tag a confirmed tx as reverted.
  it('7. stays LOUD when the claim tx SUCCEEDS but POSITION_CLAIMED is unparseable (never recovers)', async () => {
    const { ctx, sendRaw } = fakeCtx({
      reads: [
        { claimed: false }, // pre-flight: unclaimed
        { claimed: true }, // a post-read WOULD say claimed — must not rescue
      ],
      receiptStatus: 'success', // tx confirms...
      // ...but no claimedLog → claim() can't parse POSITION_CLAIMED → throws.
    });
    await expect(
      ensurePositionClaimed(ctx, { speculationId: 42n, positionType: 0 }),
    ).rejects.toMatchObject({
      name: 'OspexChainError',
      message: expect.stringMatching(/POSITION_CLAIMED/i),
    });
    expect(sendRaw).toHaveBeenCalledTimes(1); // the tx was broadcast (and succeeded)
  });

  it('8. stays LOUD when the claim reverts but a re-read shows the position is still unclaimed', async () => {
    // A genuine claim revert (not a benign already-claimed race): the tx
    // reverted AND the position is still unclaimed → must propagate.
    const { ctx } = fakeCtx({
      reads: [
        { claimed: false }, // pre-flight: unclaimed
        { claimed: false }, // re-read: STILL unclaimed
      ],
      receiptStatus: 'reverted',
    });
    await expect(
      ensurePositionClaimed(ctx, { speculationId: 42n, positionType: 0 }),
    ).rejects.toBeInstanceOf(OspexChainError);
  });

  it('rejects a non-positive speculationId before any chain work', async () => {
    const { ctx, sendRaw } = fakeCtx({ reads: [] });
    await expect(
      ensurePositionClaimed(ctx, { speculationId: 0n, positionType: 0 }),
    ).rejects.toBeInstanceOf(OspexValidationError);
    expect(sendRaw).not.toHaveBeenCalled();
  });

  it('rejects an invalid positionType before any chain work', async () => {
    const { ctx, sendRaw } = fakeCtx({ reads: [] });
    await expect(
      ensurePositionClaimed(ctx, { speculationId: 1n, positionType: 5 as unknown as 0 | 1 }),
    ).rejects.toBeInstanceOf(OspexValidationError);
    expect(sendRaw).not.toHaveBeenCalled();
  });
});
