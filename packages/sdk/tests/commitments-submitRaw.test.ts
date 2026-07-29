/**
 * `submitRaw` happy-path + NONCE_TOO_LOW retry — focused on the canonical
 * `SubmitResult.signedPayload` contract (v0.5.1).
 *
 * Closes the pre-existing coverage gap (`submitRaw` had no happy-path unit
 * test) and locks the retry-path invariant flagged in the v0.5.1
 * review: when the first POST hits NONCE_TOO_LOW, the returned
 * `signedPayload` MUST be the retry's bundle (commitmentHash + signature +
 * message all rebuilt with the new nonce), never the original's. Field-by-
 * field assertions across `hash` / `commitmentHash` / nonce / signature
 * catch any regression that wires the retry path to return stale fields.
 *
 * Also covers the required-`expiry` refusal (the removed blind `now + 24h`
 * default): the refusal itself, that it fires before the signer / chain /
 * POST, and the negative control that an explicit expiry is still accepted
 * and lands verbatim in the signed EIP-712 struct.
 */

import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { submitRaw } from '../src/commitments/submitRaw.js';
import { NonceCounter } from '../src/commitments/context.js';
import { buildDomain, hashCommitment } from '../src/chain/eip712.js';
import { MAX_LINE_TICKS } from '../src/commitments/validation.js';
import { OspexAPIError, OspexValidationError } from '../src/errors.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { CommitmentBody } from '../src/api/types.js';
import type { Signer } from '../src/types/signer.js';

const MAKER = ('0x' + 'aa'.repeat(20)) as `0x${string}`;
const SCORER = ('0x' + 'cc'.repeat(20)) as `0x${string}`;
const MATCHING_MODULE = ('0x' + '11'.repeat(20)) as `0x${string}`;
const POSITION_MODULE = ('0x' + '22'.repeat(20)) as `0x${string}`;
const USDC = ('0x' + '33'.repeat(20)) as `0x${string}`;
const CHAIN_ID = 137 as const;

const SIG_ORIGINAL = ('0x' + '11'.repeat(65)) as `0x${string}`;
const SIG_RETRY = ('0x' + '22'.repeat(65)) as `0x${string}`;

// 30 days from test-run time — well under `validateExpiry`'s 366-day cap
// regardless of when the suite runs (mirrors the moving-target fixture
// pattern in commitments-prepareSubmit.test.ts).
const EXPIRY_SEC = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);

const ARGS = {
  contestId: 42n,
  scorer: SCORER,
  lineTicks: 0,
  positionType: 0 as const,
  oddsTick: 200,
  riskAmount: 1_000_000n,
  expiry: EXPIRY_SEC,
};

// Minimum-viable api wire body that decodes to a visible commitment
// (no `bookVisible: false` ⇒ visible). The submitRaw post() decoder runs
// `toCommitment` + `requireVisibleCommitment` on this, so the field set
// just has to satisfy `CommitmentBody`. Hash is updated per-test to
// match whichever struct the SDK signed.
function fullBody(hash: string): CommitmentBody {
  return {
    commitmentHash: hash,
    maker: MAKER,
    contestId: '42',
    scorer: SCORER,
    lineTicks: 0,
    positionType: 0,
    oddsTick: 200,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '0',
    expiry: new Date(Number(EXPIRY_SEC) * 1000).toISOString(),
    speculationKey: ('0x' + 'ee'.repeat(32)) as `0x${string}`,
    signature: SIG_ORIGINAL,
    status: 'open',
    source: 'agent',
    network: 'polygon',
    nonceInvalidated: false,
    createdAt: '2026-05-30T00:00:00.000Z',
  };
}

/**
 * Build a CommitmentsContext fake. `nonceFloorSeq` is consumed in order
 * by sequential `s_minNonces` reads — so the retry test can return a
 * HIGHER floor on the second read (forcing the retry to pick a different
 * nonce than the original). `apiResponder` lets each test script the
 * `/v1/commitments` POST sequence (e.g. throw NONCE_TOO_LOW once then
 * succeed). `signatureSeq` does the same for `signer.signTypedData` so
 * the retry's signature can differ from the original's.
 *
 * `onSign` observes every `signTypedData` call — both the count ("was
 * anything signed at all?") and the exact typed-data payload handed to the
 * signer, so a test can assert on the struct that was ACTUALLY signed rather
 * than on the value the SDK happened to echo back. `onChainRead` does the
 * same for `readContract`.
 */
function fakeContext(opts: {
  apiResponder: (callIndex: number) => Promise<CommitmentBody>;
  nonceFloorSeq: bigint[];
  signatureSeq: `0x${string}`[];
  onSign?: (payload: unknown) => void;
  onChainRead?: (functionName: string) => void;
}): CommitmentsContext {
  let nonceReadIdx = 0;
  let sigIdx = 0;
  let apiCallIdx = 0;

  const publicClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      opts.onChainRead?.(functionName);
      if (functionName === 'allowance') return 1_000_000n;
      if (functionName === 's_minNonces') {
        const floor = opts.nonceFloorSeq[nonceReadIdx] ?? opts.nonceFloorSeq[opts.nonceFloorSeq.length - 1];
        nonceReadIdx += 1;
        return floor ?? 0n;
      }
      throw new Error(`unexpected readContract: ${functionName}`);
    },
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => MAKER,
    signTypedData: async (payload) => {
      opts.onSign?.(payload);
      const sig = opts.signatureSeq[sigIdx] ?? opts.signatureSeq[opts.signatureSeq.length - 1];
      sigIdx += 1;
      return sig ?? SIG_ORIGINAL;
    },
    signTransaction: async () => '0xdead' as `0x${string}`,
  };

  return {
    api: {
      request: async () => {
        // Pre-increment: an apiResponder throw (the retry test's path)
        // must still advance the index, otherwise the SDK's NONCE_TOO_LOW
        // retry POSTs against the same callIndex and the test ends up in
        // an infinite-throw loop instead of exercising the retry success.
        const idx = apiCallIdx;
        apiCallIdx += 1;
        return opts.apiResponder(idx);
      },
    } as unknown as CommitmentsContext['api'],
    requireSigner: () => signer,
    getChainId: () => CHAIN_ID,
    getAddresses: () =>
      ({
        matchingModule: MATCHING_MODULE,
        positionModule: POSITION_MODULE,
        usdc: USDC,
      }) as unknown as ReturnType<CommitmentsContext['getAddresses']>,
    requireChainClient: () => publicClient,
    nonceCounter: new NonceCounter(),
  };
}

/**
 * A context whose signer, chain client, addresses, chain id and API
 * transport ALL throw if touched.
 *
 * A guard that claims to fire "before any signer access, chain read, or
 * POST" has to prove it against a hostile context, not a cooperating fake:
 * with a cooperating fake, a regression that moved the guard below the
 * signer would still surface the same typed error and the test would still
 * pass. Here, touching anything replaces the expected
 * `OspexValidationError` with a TRIPWIRE `Error`, and the
 * `toMatchObject({ field: 'expiry' })` assertion goes red.
 */
function tripwireContext(): CommitmentsContext {
  const trip =
    (what: string) =>
    (): never => {
      throw new Error(`TRIPWIRE: submitRaw touched ${what} before refusing`);
    };
  return {
    api: { request: trip('the /v1/commitments POST') } as unknown as CommitmentsContext['api'],
    requireSigner: trip('the signer'),
    getChainId: trip('the chain id'),
    getAddresses: trip('the addresses'),
    requireChainClient: trip('the chain client'),
    nonceCounter: new NonceCounter(),
  } as unknown as CommitmentsContext;
}

describe('submitRaw — expiry is REQUIRED (no wall-clock default)', () => {
  // submitRaw reads no contest, so it has no match time to derive a safe
  // expiry from. The blind `now + 24h` default it used to apply left a
  // commitment matchable deep into live play — the stale-fill exposure
  // MatchingModule's NatSpec assigns to off-chain infrastructure to prevent.
  // These tests pin the refusal; deleting the guard turns them red.

  it('refuses an omitted expiry BEFORE touching the signer, the chain, or the POST', async () => {
    // Destructure-and-drop: the `expiry` KEY is absent from the args object,
    // which is what a TS consumer that simply forgets the field produces.
    const { expiry: _drop, ...NO_EXPIRY } = ARGS;
    await expect(submitRaw(tripwireContext(), NO_EXPIRY)).rejects.toMatchObject({
      field: 'expiry',
    });
  });

  it('nothing is signed, read, or POSTed when expiry is omitted', async () => {
    // Same claim, counted explicitly against a cooperating fake — so a
    // failure here names WHICH side effect leaked, rather than just tripping.
    let posted = false;
    let signCount = 0;
    const chainReads: string[] = [];
    const ctx = fakeContext({
      apiResponder: async () => {
        posted = true;
        return fullBody('0xPLACEHOLDER');
      },
      nonceFloorSeq: [0n],
      signatureSeq: [SIG_ORIGINAL],
      onSign: () => {
        signCount += 1;
      },
      onChainRead: (fn) => chainReads.push(fn),
    });

    const { expiry: _drop, ...NO_EXPIRY } = ARGS;
    await expect(submitRaw(ctx, NO_EXPIRY)).rejects.toBeInstanceOf(OspexValidationError);
    expect(signCount).toBe(0);
    expect(chainReads).toEqual([]);
    expect(posted).toBe(false);
  });

  it('refuses an EXPLICIT `expiry: undefined` too (the JS / non-exactOptional caller)', async () => {
    // `exactOptionalPropertyTypes` forbids writing `expiry: undefined` in
    // this repo, but a plain-JS consumer, or one compiled without that flag,
    // can hand it over — and `args.expiry === undefined` is the same thing at
    // runtime. The cast reproduces that caller; the guard must treat both
    // shapes identically.
    const EXPLICIT_UNDEFINED = { ...ARGS, expiry: undefined } as unknown as typeof ARGS;
    await expect(submitRaw(tripwireContext(), EXPLICIT_UNDEFINED)).rejects.toMatchObject({
      field: 'expiry',
    });
  });

  it('NEGATIVE CONTROL: an explicit expiry is accepted and signed VERBATIM into the EIP-712 struct', async () => {
    // Pair for the refusals above: the guard must reject ONLY the omitted
    // case. Without this, a `submitRaw` broken to always throw would pass
    // every test in this block.
    const signedExpiries: bigint[] = [];
    const ctx = fakeContext({
      apiResponder: async () => fullBody('0xPLACEHOLDER'),
      nonceFloorSeq: [0n],
      signatureSeq: [SIG_ORIGINAL],
      onSign: (payload) => {
        signedExpiries.push((payload as { message: { expiry: bigint } }).message.expiry);
      },
    });

    const result = await submitRaw(ctx, ARGS);

    // Probe the artifact the signer actually saw, not just the SDK's echo:
    // the expiry handed to signTypedData is the caller's value, unmodified.
    expect(signedExpiries).toEqual([EXPIRY_SEC]);
    expect(result.signedPayload.commitment.expiry).toBe(EXPIRY_SEC);
    // ...and the signed struct still hashes to the returned hash.
    const domain = buildDomain(CHAIN_ID, MATCHING_MODULE);
    expect(hashCommitment(domain, result.signedPayload.commitment)).toBe(result.hash);
  });

  it('a PRESENT but invalid expiry is still refused by validateExpiry, before signing or posting', async () => {
    // Removing the default must not remove the bound checks that ran after
    // it. Sweep both ends: already-past, and beyond the 366-day cap.
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const cases: Array<{ label: string; expiry: bigint }> = [
      { label: 'in the past', expiry: nowSec - 60n },
      { label: 'exactly now', expiry: nowSec },
      { label: 'beyond the 366-day cap', expiry: nowSec + 400n * 24n * 60n * 60n },
    ];
    for (const { label, expiry } of cases) {
      let posted = false;
      let signCount = 0;
      const ctx = fakeContext({
        apiResponder: async () => {
          posted = true;
          return fullBody('0xPLACEHOLDER');
        },
        nonceFloorSeq: [0n],
        signatureSeq: [SIG_ORIGINAL],
        onSign: () => {
          signCount += 1;
        },
      });
      await expect(
        submitRaw(ctx, { ...ARGS, expiry }),
        `expiry ${label}`,
      ).rejects.toMatchObject({ field: 'expiry' });
      expect(signCount, `expiry ${label}`).toBe(0);
      expect(posted, `expiry ${label}`).toBe(false);
    }
  });
});

describe('submitRaw — happy path returns signedPayload', () => {
  it('result.signedPayload matches the SDK-signed struct (hash + signature + nonce)', async () => {
    const ctx = fakeContext({
      apiResponder: async () => fullBody('0xPLACEHOLDER'),
      nonceFloorSeq: [0n],
      signatureSeq: [SIG_ORIGINAL],
    });

    const result = await submitRaw(ctx, ARGS);

    // The hash on the envelope is the same hash the SDK locally computed
    // via `hashCommitment(domain, message)` — and that same hash is in the
    // canonical signedPayload (so a caller can hand `signedPayload`
    // directly to `cancelOnchainSigned` without recomputing).
    expect(result.signedPayload.commitmentHash).toBe(result.hash);
    // The signature on the payload is verbatim from the signer (the SDK
    // never re-derives it after the sign call).
    expect(result.signedPayload.signature).toBe(SIG_ORIGINAL);
    // The struct on the payload is the same OspexCommitmentMessage the SDK
    // signed, in canonical bigint form (NOT decimal-string).
    expect(result.signedPayload.commitment.maker.toLowerCase()).toBe(MAKER.toLowerCase());
    expect(result.signedPayload.commitment.contestId).toBe(ARGS.contestId);
    expect(result.signedPayload.commitment.scorer.toLowerCase()).toBe(SCORER.toLowerCase());
    expect(result.signedPayload.commitment.lineTicks).toBe(ARGS.lineTicks);
    expect(result.signedPayload.commitment.positionType).toBe(ARGS.positionType);
    expect(result.signedPayload.commitment.oddsTick).toBe(ARGS.oddsTick);
    expect(result.signedPayload.commitment.riskAmount).toBe(ARGS.riskAmount);
    expect(result.signedPayload.commitment.expiry).toBe(ARGS.expiry);

    // The struct hashes back to the result hash under the configured
    // domain — proves the payload is "act-on-able" without re-fetching.
    const domain = buildDomain(CHAIN_ID, MATCHING_MODULE);
    expect(hashCommitment(domain, result.signedPayload.commitment)).toBe(result.hash);
  });
});

describe('submitRaw — commitment line magnitude guard', () => {
  it('rejects |lineTicks| > MAX_LINE_TICKS before signing or posting', async () => {
    let posted = false;
    const ctx = fakeContext({
      apiResponder: async () => {
        posted = true;
        return fullBody('0xPLACEHOLDER');
      },
      nonceFloorSeq: [0n],
      signatureSeq: [SIG_ORIGINAL],
    });
    await expect(
      submitRaw(ctx, { ...ARGS, lineTicks: MAX_LINE_TICKS + 1 }),
    ).rejects.toMatchObject({ field: 'lineTicks' });
    // The guard is the first thing submitRaw does — nothing was signed or POSTed.
    expect(posted).toBe(false);
  });

  it('accepts a line exactly at the MAX_LINE_TICKS boundary', async () => {
    const ctx = fakeContext({
      apiResponder: async () => fullBody('0xPLACEHOLDER'),
      nonceFloorSeq: [0n],
      signatureSeq: [SIG_ORIGINAL],
    });
    await expect(
      submitRaw(ctx, { ...ARGS, lineTicks: MAX_LINE_TICKS }),
    ).resolves.toBeDefined();
  });
});

describe('submitRaw — beforePost precondition (just-in-time fail-closed gate)', () => {
  it('runs synchronously immediately before the POST', async () => {
    const calls: string[] = [];
    const ctx = fakeContext({
      apiResponder: async () => {
        calls.push('post');
        return fullBody('0xPLACEHOLDER');
      },
      nonceFloorSeq: [0n],
      signatureSeq: [SIG_ORIGINAL],
    });

    await submitRaw(ctx, { ...ARGS, beforePost: () => calls.push('beforePost') });

    // beforePost fires, then the POST — proving the hook is the last thing
    // before the irreversible request (no await between them).
    expect(calls).toEqual(['beforePost', 'post']);
  });

  it('throwing aborts WITHOUT posting and propagates the exact error', async () => {
    let postCount = 0;
    const ctx = fakeContext({
      apiResponder: async () => {
        postCount += 1;
        return fullBody('0xPLACEHOLDER');
      },
      nonceFloorSeq: [0n],
      signatureSeq: [SIG_ORIGINAL],
    });

    const boom = new Error('own-state degraded after signing');
    await expect(
      submitRaw(ctx, { ...ARGS, beforePost: () => { throw boom; } }),
    ).rejects.toBe(boom);
    expect(postCount).toBe(0); // the POST never happened — fail-closed at the side-effect boundary
  });

  it('rejects an async (thenable-returning) hook fail-closed — does NOT post', async () => {
    let postCount = 0;
    const ctx = fakeContext({
      apiResponder: async () => {
        postCount += 1;
        return fullBody('0xPLACEHOLDER');
      },
      nonceFloorSeq: [0n],
      signatureSeq: [SIG_ORIGINAL],
    });

    // An async hook typechecks against `() => void` (TS's void-return rule) but
    // cannot fail-close — the SDK would otherwise ignore the returned Promise and
    // POST anyway. The runtime guard must reject it BEFORE posting (fail-closed).
    await expect(
      submitRaw(ctx, { ...ARGS, beforePost: () => Promise.resolve() }),
    ).rejects.toBeInstanceOf(OspexValidationError);
    expect(postCount).toBe(0); // never posted — the async-hook misuse failed closed
  });

  it('a rejecting async hook fails closed WITHOUT an unhandledRejection (no POST, submitRaw rejects)', async () => {
    let postCount = 0;
    const ctx = fakeContext({
      apiResponder: async () => {
        postCount += 1;
        return fullBody('0xPLACEHOLDER');
      },
      nonceFloorSeq: [0n],
      signatureSeq: [SIG_ORIGINAL],
    });

    // The dangerous misuse: an async hook that REJECTS after yielding. The SDK
    // must (a) refuse the submit, and (b) NOT let the hook's rejection surface as
    // an unhandledRejection (which can crash the host process). Capture any
    // unhandled rejection for the duration of this test to prove it doesn't fire.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        submitRaw(ctx, {
          ...ARGS,
          beforePost: async () => { await Promise.resolve(); throw new Error('async hook rejected after yielding'); },
        }),
      ).rejects.toBeInstanceOf(OspexValidationError);
      expect(postCount).toBe(0); // never posted — fail-closed for the side effect
      // Drain microtasks (where the hook's rejection would settle) + one macrotask
      // (where Node would emit unhandledRejection) before asserting none fired.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0); // safe for the process — the rejection was swallowed
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('guards the NONCE_TOO_LOW retry POST too — a degradation between the initial POST and the retry aborts the retry', async () => {
    let beforePostCount = 0;
    let postCount = 0;
    const ctx = fakeContext({
      apiResponder: async (callIndex) => {
        postCount += 1;
        if (callIndex === 0) {
          throw new OspexAPIError('nonce too low', { apiCode: 'NONCE_TOO_LOW', status: 409 });
        }
        return fullBody('0xPLACEHOLDER');
      },
      nonceFloorSeq: [0n, 5_000_000_000n],
      signatureSeq: [SIG_ORIGINAL, SIG_RETRY],
    });

    const boom = new Error('degraded during the retry re-sign');
    await expect(
      submitRaw(ctx, {
        ...ARGS,
        // healthy before the initial POST, degraded before the retry POST
        beforePost: () => { beforePostCount += 1; if (beforePostCount === 2) throw boom; },
      }),
    ).rejects.toBe(boom);
    expect(beforePostCount).toBe(2); // called before the initial POST AND before the retry POST
    expect(postCount).toBe(1); // only the initial POST fired (→ NONCE_TOO_LOW); the retry POST was aborted by beforePost
  });
});

describe('submitRaw — NONCE_TOO_LOW retry path returns the retry signedPayload (not the original)', () => {
  it('returned signedPayload reflects the retry struct, hash, and signature — original is discarded', async () => {
    // The retry path: first POST throws NONCE_TOO_LOW, SDK re-reads the
    // nonce floor (now higher), picks a NEW nonce, signs a NEW struct,
    // hashes a NEW hash, POSTs again, and returns the retry bundle. The
    // invariant: the returned signedPayload is the RETRY's bundle —
    // never the original (which doesn't match the persisted server row).
    const ctx = fakeContext({
      apiResponder: async (callIndex) => {
        if (callIndex === 0) {
          throw new OspexAPIError('nonce too low', { apiCode: 'NONCE_TOO_LOW', status: 409 });
        }
        return fullBody('0xPLACEHOLDER');
      },
      // First read picks nonce N=0; after NONCE_TOO_LOW, the fresh read
      // bumps the floor to 5_000_000_000 (well above the initial pick).
      nonceFloorSeq: [0n, 5_000_000_000n],
      // Different signatures so we can directly assert the retry's, not
      // the original's, is on the returned payload.
      signatureSeq: [SIG_ORIGINAL, SIG_RETRY],
    });

    const result = await submitRaw(ctx, ARGS);

    // The retry's signature won — original (SIG_ORIGINAL) is discarded.
    expect(result.signedPayload.signature).toBe(SIG_RETRY);
    expect(result.signedPayload.signature).not.toBe(SIG_ORIGINAL);

    // The retry struct's nonce is the post-floor-bump value, not the
    // initial pick. (The exact retry nonce comes from `NonceCounter.next`
    // and depends on `nowUnixSec()` too, but it MUST be ≥ the new floor
    // — anything less would mean the SDK ignored the floor.)
    expect(result.signedPayload.commitment.nonce).toBeGreaterThanOrEqual(5_000_000_000n);

    // The hash on the envelope is the retry hash — and the canonical
    // signedPayload's commitmentHash matches it. If the SDK regressed
    // and put the original signedPayload on a retry envelope, this would
    // fail (envelope hash from retryHash, signedPayload hash from original).
    expect(result.signedPayload.commitmentHash).toBe(result.hash);

    // Cross-check the hash via the canonical helper — proves the
    // commitment struct on the payload actually hashes to the envelope's
    // hash (not just a coincidentally-matching string).
    const domain = buildDomain(CHAIN_ID, MATCHING_MODULE);
    expect(hashCommitment(domain, result.signedPayload.commitment)).toBe(result.hash);
  });
});
