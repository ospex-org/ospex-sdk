/**
 * Unit tests for `commitments.resolveByPrefix`. Mocks `api.request`
 * (the underlying ApiClient method) so api.get and api.list both go
 * through the same controllable channel.
 *
 * Covers:
 *   - full hash → api.get path (no list call)
 *   - full hash but excluded by status filter → throws
 *   - mixed-case full hash → resolves (lowercased on the wire)
 *   - prefix length 8 + unique match → returns
 *   - prefix length 7 → too-short error
 *   - prefix matches 1 cancelled + 1 open under default scope → returns
 *     the open one (cancelled is filtered out by status default)
 *   - status: 'any' resolves cancelled / expired / invalidated rows
 *   - 2 matches in same status scope → ambiguity error lists both
 *   - PAGE_LIMIT (1000) rows returned → "too many" error
 *   - 0 matches → no-match error
 *   - malformed input (non-hex) → typed validation error
 */

import { describe, expect, it, vi } from 'vitest';
import {
  resolveByPrefix,
  MIN_PREFIX_HEX_LEN,
  PAGE_LIMIT,
} from '../src/commitments/resolveByPrefix.js';
import { NonceCounter } from '../src/commitments/context.js';
import { OspexAPIError } from '../src/errors.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { CommitmentBody, CommitmentsListBody } from '../src/api/types.js';
import type { Commitment } from '../src/types/commitment.js';

const FAR_FUTURE_ISO = '2099-05-08T02:00:00Z';

/** A list body with the pagination envelope the wire always carries. */
function makeListBody(rows: CommitmentBody[]): CommitmentsListBody {
  return {
    commitments: rows,
    pagination: { limit: PAGE_LIMIT, offset: 0, total: rows.length, hasMore: false },
  };
}

function makeBody(
  hash: string,
  overrides: Partial<CommitmentBody> = {},
): CommitmentBody {
  return {
    commitmentHash: hash,
    maker: '0xaa' + 'aa'.repeat(19),
    contestId: '42',
    scorer: '0xbb' + 'bb'.repeat(19),
    lineTicks: 0,
    positionType: 0,
    oddsTick: 250,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '17000000001',
    expiry: FAR_FUTURE_ISO,
    speculationKey: '0x' + 'cc'.repeat(32),
    signature: '0x' + 'sig'.padEnd(130, '0'),
    status: 'open',
    source: 'submit',
    network: 'polygon',
    nonceInvalidated: false,
    createdAt: '2026-05-09T00:00:00Z',
    ...overrides,
  };
}

interface ApiResponses {
  /** Body returned by api.get(/v1/commitments/<hash>). */
  getResponse?: CommitmentBody;
  /** 404-style throw. */
  getThrows?: Error;
  /** Body returned by api.list(/v1/commitments?...). */
  listResponse?: CommitmentsListBody;
  /** Capture every request for assertion. */
  calls?: Array<{ path: string; opts?: Record<string, unknown> }>;
}

function buildCtx(api: ApiResponses): CommitmentsContext {
  const calls = api.calls ?? [];
  return {
    api: {
      request: vi.fn(async (path: string, opts?: Record<string, unknown>) => {
        calls.push({ path, ...(opts ? { opts } : {}) });
        if (path.startsWith('/v1/commitments/')) {
          if (api.getThrows) throw api.getThrows;
          return api.getResponse ?? makeBody(path.split('/').pop()!);
        }
        // List path
        return api.listResponse ?? makeListBody([]);
      }),
    } as unknown as CommitmentsContext['api'],
    requireSigner: () => {
      throw new Error('not used');
    },
    getChainId: () => 137,
    getAddresses: () => ({}) as ReturnType<CommitmentsContext['getAddresses']>,
    requireChainClient: () => {
      throw new Error('not used');
    },
    nonceCounter: new NonceCounter(),
    getContestsApi: () => ({}) as ReturnType<CommitmentsContext['getContestsApi']>,
    getSpeculationsApi: () => ({}) as ReturnType<CommitmentsContext['getSpeculationsApi']>,
    getTeams: () => ({}) as ReturnType<CommitmentsContext['getTeams']>,
  };
}

const FULL_HASH = '0x' + 'a1'.repeat(32);

describe('resolveByPrefix — full-hash fast path', () => {
  it('valid full hash → calls api.get, NOT api.list', async () => {
    const calls: Array<{ path: string }> = [];
    const ctx = buildCtx({
      getResponse: makeBody(FULL_HASH),
      calls,
    });
    const result = await resolveByPrefix(ctx, FULL_HASH);
    expect(result.commitmentHash).toBe(FULL_HASH);
    expect(calls).toEqual([{ path: `/v1/commitments/${FULL_HASH.toLowerCase()}` }]);
  });

  it('mixed-case full hash → lowercased on the wire', async () => {
    const mixed = '0xA1B2c3D4'.padEnd(66, 'a');
    const calls: Array<{ path: string }> = [];
    const ctx = buildCtx({
      getResponse: makeBody(mixed.toLowerCase()),
      calls,
    });
    const result = await resolveByPrefix(ctx, mixed);
    expect(result.commitmentHash).toBe(mixed.toLowerCase());
    // The path should be lowercased.
    expect(calls[0]?.path).toBe(`/v1/commitments/${mixed.toLowerCase()}`);
  });

  it('full hash but excluded by status filter → throws', async () => {
    const ctx = buildCtx({
      getResponse: makeBody(FULL_HASH, { status: 'cancelled' }),
    });
    await expect(
      resolveByPrefix(ctx, FULL_HASH, { status: ['open', 'partially_filled'] }),
    ).rejects.toThrow(/excluded by the status filter/);
  });

  it('full hash with status: "any" passes through cancelled rows', async () => {
    const ctx = buildCtx({
      getResponse: makeBody(FULL_HASH, { status: 'cancelled' }),
    });
    const result = await resolveByPrefix(ctx, FULL_HASH, { status: 'any' });
    expect(result.status).toBe('cancelled');
  });
});

describe('resolveByPrefix — prefix path', () => {
  it('unique match in first page → returns it', async () => {
    const HASH_A = '0x' + 'a1'.repeat(32);
    const HASH_B = '0x' + 'b2'.repeat(32);
    const ctx = buildCtx({
      listResponse: makeListBody([makeBody(HASH_A), makeBody(HASH_B)]),
    });
    const result = await resolveByPrefix(ctx, '0x' + 'a1'.repeat(4));
    expect(result.commitmentHash).toBe(HASH_A);
  });

  it('prefix shorter than MIN_PREFIX_HEX_LEN → too-short error', async () => {
    const ctx = buildCtx({});
    // 7 hex chars after 0x = below minimum (8).
    await expect(resolveByPrefix(ctx, '0xabcdef0')).rejects.toThrow(
      new RegExp(`at least ${MIN_PREFIX_HEX_LEN} hex chars`),
    );
  });

  it('malformed input (non-hex chars after 0x) → typed validation error', async () => {
    const ctx = buildCtx({});
    await expect(resolveByPrefix(ctx, '0xZZZZZZZZ')).rejects.toThrow(/not a 0x-prefixed hex string/);
  });

  it('input without 0x prefix → typed validation error', async () => {
    const ctx = buildCtx({});
    await expect(resolveByPrefix(ctx, 'abcdef12')).rejects.toThrow(/not a 0x-prefixed hex string/);
  });

  it('empty input → throws', async () => {
    const ctx = buildCtx({});
    await expect(resolveByPrefix(ctx, '')).rejects.toThrow(/non-empty/);
  });

  it('default status scope filters out cancelled rows from the result', async () => {
    // Both rows match the prefix; one is open, one is cancelled. Default
    // scope is open+partially_filled, so list filtering on the API side
    // would return only the open one. We mock that behavior here.
    const HASH_A = '0x' + 'a1'.repeat(32);
    const ctx = buildCtx({
      listResponse: makeListBody([makeBody(HASH_A)]),
    });
    const result = await resolveByPrefix(ctx, '0x' + 'a1'.repeat(4));
    expect(result.commitmentHash).toBe(HASH_A);
    expect(result.status).toBe('open');
  });

  it('status: "any" sends all STORED statuses (never the effective-only "expired" token) + includeInvalidated + includeExpired, and still resolves an effective-expired row', async () => {
    const calls: Array<{ path: string; opts?: Record<string, unknown> }> = [];
    const ctx = buildCtx({
      // Effective `expired` row (raw stored `open`) — returned by the server via
      // includeExpired=true, NOT by a status=expired filter.
      listResponse: makeListBody([
        makeBody('0x' + 'a1'.repeat(32), { status: 'expired', storedStatus: 'open' }),
      ]),
      calls,
    });
    const result = await resolveByPrefix(ctx, '0x' + 'a1'.repeat(4), { status: 'any' });
    expect(result.status).toBe('expired');

    // The wire `status=` filter is the stored column — it must NOT include
    // `expired` (core-api returns 400 for it); expired rows arrive via the flag.
    expect(calls[0]?.path).toBe('/v1/commitments');
    const query = (calls[0]?.opts as { query?: Record<string, unknown> } | undefined)?.query;
    expect(query?.status).toBe('open,partially_filled,filled,cancelled');
    expect(query?.includeInvalidated).toBe(true);
    expect(query?.includeExpired).toBe(true);
  });

  it('multiple matches in the result set → ambiguity error lists candidate hashes', async () => {
    // Both rows share the first 8 hex chars after 0x ("a1a1a1a1"); the
    // resolver must error rather than return either.
    const HASH_A = '0xa1a1a1a1' + 'aa'.repeat(28);
    const HASH_B = '0xa1a1a1a1' + 'bb'.repeat(28);
    const ctx = buildCtx({
      listResponse: makeListBody([makeBody(HASH_A), makeBody(HASH_B)]),
    });
    await expect(resolveByPrefix(ctx, '0xa1a1a1a1')).rejects.toThrow(
      /ambiguous prefix.*matches.*0xa1a1a1a1/i,
    );
  });

  it('PAGE_LIMIT rows returned (full page) → "too many" error', async () => {
    // Fill the page with rows that DON'T match the prefix to confirm
    // the resolver doesn't claim "matched too many" — it claims the
    // search space was too large.
    const dummy = '0x' + 'cc'.repeat(32); // doesn't share the prefix below
    const rows = Array.from({ length: PAGE_LIMIT }, () => makeBody(dummy));
    const ctx = buildCtx({ listResponse: makeListBody(rows) });
    await expect(resolveByPrefix(ctx, '0xa1a1a1a1')).rejects.toThrow(
      /too many commitments.*pass the full hash or add filters/,
    );
  });

  it('zero matches → "no commitment matches prefix" error', async () => {
    const ctx = buildCtx({ listResponse: makeListBody([]) });
    await expect(resolveByPrefix(ctx, '0xa1a1a1a1')).rejects.toThrow(
      /no commitment matches prefix.*within the requested status scope/,
    );
  });
});

describe('resolveByPrefix — passes through filters', () => {
  it('forwards contestId / maker / scorer / speculationId to api.list query', async () => {
    const calls: Array<{ path: string; opts?: Record<string, unknown> }> = [];
    const ctx = buildCtx({
      listResponse: makeListBody([makeBody('0x' + 'a1'.repeat(32))]),
      calls,
    });
    await resolveByPrefix(ctx, '0x' + 'a1'.repeat(4), {
      contestId: 42,
      maker: '0xdeadbeef',
      scorer: '0xfeedface',
      speculationId: 101,
    });
    const query = (calls[0]?.opts as { query?: Record<string, unknown> })?.query;
    expect(query?.contestId).toBe('42');
    expect(query?.maker).toBe('0xdeadbeef');
    expect(query?.scorer).toBe('0xfeedface');
    expect(query?.speculationId).toBe('101');
  });
});

void OspexAPIError;
