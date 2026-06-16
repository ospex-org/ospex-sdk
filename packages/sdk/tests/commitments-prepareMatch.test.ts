/**
 * Unit tests for the `prepareMatch` orchestrator. Mocks the API
 * (commitments + contests endpoints) and the chain client (USDC
 * allowance reads).
 *
 * Covers:
 *   - { hash } input → fetches commitment via `api.get`
 *   - { commitment } input → does NOT call `api.get`
 *   - speculation existence: matching open spec → existing; no match → lazy
 *   - closed speculation at the same tuple → throws
 *   - lazy non-self-match: reads taker AND maker TreasuryModule allowance
 *   - lazy self-match: taker required = full fee
 *   - maker treasury allowance insufficient on lazy → warning bubbles up
 *   - PositionModule allowance read covers the COMPUTED takerRiskWei6
 *   - missing required field on commitment → throws
 */

import { describe, expect, it, vi } from 'vitest';
import { prepareMatch } from '../src/commitments/prepareMatch.js';
import { MAX_LINE_TICKS } from '../src/commitments/validation.js';
import { NonceCounter } from '../src/commitments/context.js';
import type { CommitmentsContext } from '../src/commitments/context.js';
import type { Hex, Signer } from '../src/types/signer.js';
import type { Commitment } from '../src/types/commitment.js';
import type { Contest } from '../src/types/contest.js';

const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
const TAKER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const SCORER = '0x4444444444444444444444444444444444444444' as Hex;
const HASH = '0x'.padEnd(66, '5') as Hex;
const FAR_FUTURE_ISO = '2099-05-08T02:00:00Z';

const ADDRESSES = {
  matchingModule: '0x'.padEnd(42, '1') as Hex,
  positionModule: '0x'.padEnd(42, '2') as Hex,
  usdc: '0x'.padEnd(42, '3') as Hex,
  linkToken: '0x'.padEnd(42, '4') as Hex,
  ospexCore: '0x'.padEnd(42, '5') as Hex,
  speculationModule: '0x'.padEnd(42, '6') as Hex,
  contestModule: '0x'.padEnd(42, '7') as Hex,
  leaderboardModule: '0x'.padEnd(42, '8') as Hex,
  rulesModule: '0x'.padEnd(42, '9') as Hex,
  treasuryModule: '0x'.padEnd(42, 'b') as Hex,
  secondaryMarketModule: '0x'.padEnd(42, 'c') as Hex,
  oracleModule: '0x'.padEnd(42, 'd') as Hex,
  scorers: {
    moneyline: '0x'.padEnd(42, 'e') as Hex,
    spread: '0x'.padEnd(42, 'f') as Hex,
    total: '0x'.padEnd(42, '0') as Hex,
  },
};

function buildSigner(addr: Hex = TAKER): Signer {
  return {
    getAddress: vi.fn(async () => addr),
    signTypedData: vi.fn(),
    signTransaction: vi.fn(),
  } as unknown as Signer;
}

function makeCommitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    visibility: 'visible',
    redacted: false,
    commitmentHash: HASH,
    maker: MAKER,
    contestId: '42',
    scorer: SCORER,
    lineTicks: 0,
    positionType: 0,
    oddsTick: 250,
    marketType: 'moneyline',
    riskAmount: '1000000',
    filledRiskAmount: '0',
    remainingRiskAmount: '1000000',
    nonce: '17000000001',
    expiry: FAR_FUTURE_ISO,
    speculationKey: '0x'.padEnd(66, 'a'),
    signature: '0x'.padEnd(132, 's'),
    status: 'open',
    storedStatus: 'open',
    source: 'submit',
    network: 'polygon',
    nonceInvalidated: false,
    isLive: true,
    createdAt: '2026-05-09T00:00:00Z',
    ...overrides,
  };
}

function buildContest(overrides: Partial<Contest> = {}): Contest {
  return {
    contestId: '42',
    awayTeam: 'Los Angeles Lakers',
    homeTeam: 'Denver Nuggets',
    sport: 'nba',
    sportId: 1,
    matchTime: FAR_FUTURE_ISO,
    status: 'verified',
    awayTeamId: 'lakers-uuid',
    homeTeamId: 'nuggets-uuid',
    speculations: [],
    ...overrides,
  };
}

interface PublicClientMockOpts {
  /** Default allowance for `allowance(...)` reads when no specific spender match. */
  defaultAllowance?: bigint;
  /** USDC.allowance(taker, positionModule). */
  takerPositionAllowance?: bigint;
  /** USDC.allowance(taker, treasuryModule). */
  takerTreasuryAllowance?: bigint;
  /** USDC.allowance(maker, treasuryModule). */
  makerTreasuryAllowance?: bigint;
  /** Capture every readContract call so tests can assert on call shape. */
  reads?: Array<{ functionName: string; args: readonly unknown[] }>;
}

function buildPublicClient(opts: PublicClientMockOpts = {}): unknown {
  const defaultAllowance = opts.defaultAllowance ?? 0n;
  const positionLower = ADDRESSES.positionModule.toLowerCase();
  const treasuryLower = ADDRESSES.treasuryModule.toLowerCase();
  const makerLower = MAKER.toLowerCase();
  const takerLower = TAKER.toLowerCase();
  return {
    readContract: vi.fn(
      async ({
        functionName,
        args,
      }: {
        functionName: string;
        args: readonly unknown[];
      }) => {
        opts.reads?.push({ functionName, args });
        if (functionName !== 'allowance') {
          throw new Error(`unexpected readContract: ${functionName}`);
        }
        const owner = (args[0] as string).toLowerCase();
        const spender = (args[1] as string).toLowerCase();
        if (spender === positionLower && owner === takerLower) {
          return opts.takerPositionAllowance ?? defaultAllowance;
        }
        if (spender === treasuryLower && owner === takerLower) {
          return opts.takerTreasuryAllowance ?? defaultAllowance;
        }
        if (spender === treasuryLower && owner === makerLower) {
          return opts.makerTreasuryAllowance ?? defaultAllowance;
        }
        return defaultAllowance;
      },
    ),
  };
}

interface CtxOpts {
  commitment?: Commitment;
  contest?: Contest;
  signerAddr?: Hex;
  publicClient?: PublicClientMockOpts;
  /** Spy that the test can assert was/wasn't called. */
  apiRequest?: ReturnType<typeof vi.fn>;
  /** Spy on contests.get (test asserts on the contestId argument). */
  contestsGet?: ReturnType<typeof vi.fn>;
  chainId?: 137 | 80002;
}

function buildContext(opts: CtxOpts = {}): {
  ctx: CommitmentsContext;
  apiRequest: ReturnType<typeof vi.fn>;
  contestsGet: ReturnType<typeof vi.fn>;
  reads: Array<{ functionName: string; args: readonly unknown[] }>;
} {
  const reads: Array<{ functionName: string; args: readonly unknown[] }> = [];
  const apiRequest =
    opts.apiRequest ??
    vi.fn(async (_path: string) => opts.commitment ?? makeCommitment());
  const contestsGet =
    opts.contestsGet ?? vi.fn(async () => opts.contest ?? buildContest());
  const contestsApi = { get: contestsGet, list: vi.fn(), scripts: vi.fn() } as unknown as ReturnType<
    CommitmentsContext['getContestsApi']
  >;
  const ctx: CommitmentsContext = {
    api: { request: apiRequest } as unknown as CommitmentsContext['api'],
    requireSigner: () => buildSigner(opts.signerAddr ?? TAKER),
    getChainId: () => (opts.chainId ?? 137),
    getAddresses: () => ADDRESSES,
    requireChainClient: () =>
      buildPublicClient({
        ...(opts.publicClient ?? {}),
        reads,
      }) as ReturnType<CommitmentsContext['requireChainClient']>,
    nonceCounter: new NonceCounter(),
    getContestsApi: () => contestsApi,
    getSpeculationsApi: () => ({}) as ReturnType<CommitmentsContext['getSpeculationsApi']>,
    getTeams: () => ({}) as ReturnType<CommitmentsContext['getTeams']>,
  };
  return { ctx, apiRequest, contestsGet, reads };
}

describe('prepareMatch — input modes', () => {
  it('{ hash }: fetches commitment via api.request(/v1/commitments/<hash>)', async () => {
    const fakeBody = makeCommitment();
    const apiRequest = vi.fn(async () => fakeBody);
    const { ctx } = buildContext({ apiRequest });
    await prepareMatch(ctx, { hash: HASH });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]?.[0]).toBe(`/v1/commitments/${HASH.toLowerCase()}`);
  });

  it('{ commitment }: does NOT call api.request — no double-fetch', async () => {
    const apiRequest = vi.fn();
    const { ctx } = buildContext({ apiRequest });
    await prepareMatch(ctx, { commitment: makeCommitment() });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('rejects when both { hash } and { commitment } are provided', async () => {
    const { ctx } = buildContext();
    await expect(
      prepareMatch(ctx, { hash: HASH, commitment: makeCommitment() }),
    ).rejects.toThrow(/either.*not both/i);
  });

  it('rejects when neither is provided', async () => {
    const { ctx } = buildContext();
    await expect(prepareMatch(ctx, {})).rejects.toThrow(/required/i);
  });

  it('throws when commitment is missing a required field', async () => {
    const broken = makeCommitment({ signature: null });
    const { ctx } = buildContext({ commitment: broken });
    await expect(prepareMatch(ctx, { commitment: broken })).rejects.toThrow(
      /missing required fields.*signature/,
    );
  });

  it('refuses a poisoned line (|lineTicks| > MAX_LINE_TICKS) before any network read', async () => {
    const poisoned = makeCommitment({ marketType: 'spread', lineTicks: MAX_LINE_TICKS + 1 });
    const { ctx, contestsGet } = buildContext({ commitment: poisoned });
    await expect(prepareMatch(ctx, { commitment: poisoned })).rejects.toMatchObject({
      field: 'lineTicks',
    });
    // Fails fast — the parent contest is never fetched.
    expect(contestsGet).not.toHaveBeenCalled();
  });
});

describe('prepareMatch — speculation classification', () => {
  it('matching open speculation → existing mode + speculationId', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '101',
          contestId: '42',
          type: 'moneyline',
          lineTicks: 0,
          line: 0,
          speculationStatus: 0,
        },
      ],
    });
    const { ctx } = buildContext({ contest });
    const p = await prepareMatch(ctx, { commitment: makeCommitment() });
    expect(p.speculation.mode).toBe('existing');
    expect(p.speculation.speculationId).toBe('101');
    expect(p.speculation.lazyCreation).toBeUndefined();
  });

  it('no matching speculation → lazy mode', async () => {
    const contest = buildContest({ speculations: [] });
    const { ctx } = buildContext({ contest });
    const p = await prepareMatch(ctx, { commitment: makeCommitment() });
    expect(p.speculation.mode).toBe('lazy');
    expect(p.speculation.speculationId).toBeNull();
    expect(p.speculation.lazyCreation).toBeDefined();
  });

  it('matching but CLOSED speculation → throws (would revert at recordFill)', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '101',
          contestId: '42',
          type: 'moneyline',
          lineTicks: 0,
          line: 0,
          speculationStatus: 1, // closed
        },
      ],
    });
    const { ctx } = buildContext({ contest });
    await expect(prepareMatch(ctx, { commitment: makeCommitment() })).rejects.toThrow(
      /closed.*settled or scored/,
    );
  });
});

describe('prepareMatch — allowance reads', () => {
  it('existing mode reads ONLY taker PositionModule allowance', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '101',
          contestId: '42',
          type: 'moneyline',
          lineTicks: 0,
          line: 0,
          speculationStatus: 0,
        },
      ],
    });
    const { ctx, reads } = buildContext({ contest });
    await prepareMatch(ctx, { commitment: makeCommitment() });
    // Only one allowance read (taker → positionModule). Treasury reads
    // are skipped in existing mode.
    const allowanceReads = reads.filter((r) => r.functionName === 'allowance');
    expect(allowanceReads).toHaveLength(1);
    expect((allowanceReads[0]!.args[0] as string).toLowerCase()).toBe(TAKER.toLowerCase());
    expect((allowanceReads[0]!.args[1] as string).toLowerCase()).toBe(
      ADDRESSES.positionModule.toLowerCase(),
    );
  });

  it('lazy mode reads taker (Position) + taker (Treasury) + maker (Treasury) — three reads', async () => {
    const contest = buildContest({ speculations: [] });
    const { ctx, reads } = buildContext({ contest });
    await prepareMatch(ctx, { commitment: makeCommitment() });
    const allowanceReads = reads.filter((r) => r.functionName === 'allowance');
    expect(allowanceReads).toHaveLength(3);

    const triples = allowanceReads.map((r) => ({
      owner: (r.args[0] as string).toLowerCase(),
      spender: (r.args[1] as string).toLowerCase(),
    }));
    // Use sets to avoid asserting on ordering (Promise.all is parallel).
    expect(triples).toEqual(
      expect.arrayContaining([
        { owner: TAKER.toLowerCase(), spender: ADDRESSES.positionModule.toLowerCase() },
        { owner: TAKER.toLowerCase(), spender: ADDRESSES.treasuryModule.toLowerCase() },
        { owner: MAKER.toLowerCase(), spender: ADDRESSES.treasuryModule.toLowerCase() },
      ]),
    );
  });
});

describe('prepareMatch — lazy fee + self-match', () => {
  it('lazy non-self-match: takerShare = half fee', async () => {
    const contest = buildContest({ speculations: [] });
    const { ctx } = buildContext({ contest });
    const p = await prepareMatch(ctx, { commitment: makeCommitment() });
    expect(p.selfMatch).toBe(false);
    expect(p.speculation.lazyCreation?.takerShareWei6).toBe('250000');
    const lazyRow = p.approvals.find((r) => r.purpose === 'lazy-creation-fee');
    expect(BigInt(lazyRow!.required)).toBe(250_000n);
  });

  it('lazy self-match: takerShare = FULL fee (same wallet pays both halves)', async () => {
    const contest = buildContest({ speculations: [] });
    const { ctx } = buildContext({ contest, signerAddr: MAKER });
    const p = await prepareMatch(ctx, { commitment: makeCommitment() });
    expect(p.selfMatch).toBe(true);
    expect(p.speculation.lazyCreation?.takerShareWei6).toBe('500000');
    const lazyRow = p.approvals.find((r) => r.purpose === 'lazy-creation-fee');
    expect(BigInt(lazyRow!.required)).toBe(500_000n);
    expect(p.warnings).toContain('self-match');
  });

  it('lazy + maker treasury allowance < maker share → warning + boolean false', async () => {
    const contest = buildContest({ speculations: [] });
    const { ctx } = buildContext({
      contest,
      publicClient: { makerTreasuryAllowance: 100_000n },
    });
    const p = await prepareMatch(ctx, { commitment: makeCommitment() });
    expect(p.warnings).toContain('maker-treasury-allowance-insufficient');
    expect(p.speculation.lazyCreation?.makerTreasuryAllowanceSufficient).toBe(false);
  });
});

describe('prepareMatch — taker position allowance', () => {
  it('takerPositionAllowance is exposed on the commitment-risk approval row', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '101',
          contestId: '42',
          type: 'moneyline',
          lineTicks: 0,
          line: 0,
          speculationStatus: 0,
        },
      ],
    });
    const { ctx } = buildContext({
      contest,
      publicClient: { takerPositionAllowance: 2_000_000n },
    });
    const p = await prepareMatch(ctx, { commitment: makeCommitment() });
    const commitmentRow = p.approvals.find((r) => r.purpose === 'commitment-risk');
    expect(BigInt(commitmentRow!.current)).toBe(2_000_000n);
    // taker risk @ tick 250 fully filling 1 USDC maker = 1.5 USDC. Allowance 2 USDC → sufficient.
    expect(commitmentRow!.needsApproval).toBe(false);
  });

  it('needsApproval flips when taker allowance < takerRiskWei6', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '101',
          contestId: '42',
          type: 'moneyline',
          lineTicks: 0,
          line: 0,
          speculationStatus: 0,
        },
      ],
    });
    const { ctx } = buildContext({
      contest,
      publicClient: { takerPositionAllowance: 1_000_000n },
    });
    const p = await prepareMatch(ctx, { commitment: makeCommitment() });
    const commitmentRow = p.approvals.find((r) => r.purpose === 'commitment-risk');
    // 1 USDC allowance < 1.5 USDC required → needsApproval true.
    expect(commitmentRow!.needsApproval).toBe(true);
  });
});

describe('prepareMatch — chain id pass-through', () => {
  it('preview carries the configured chainId and matchingModule address', async () => {
    const contest = buildContest({
      speculations: [
        {
          speculationId: '101',
          contestId: '42',
          type: 'moneyline',
          lineTicks: 0,
          line: 0,
          speculationStatus: 0,
        },
      ],
    });
    const { ctx } = buildContext({ contest, chainId: 80002 });
    const p = await prepareMatch(ctx, { commitment: makeCommitment() });
    expect(p.chainId).toBe(80002);
    expect(p.verifyingContract.toLowerCase()).toBe(ADDRESSES.matchingModule.toLowerCase());
  });
});

describe('prepareMatch — taker override (preview-only without signer unlock)', () => {
  // Critical agent-trust contract from spec §17.2: `--json` preview-only
  // paths in the CLI must not trigger a passphrase prompt or a keystore
  // decrypt. The SDK side of that contract is the `args.taker` override
  // — when set, `prepareMatch` MUST NOT call the configured signer.

  const EXPLICIT_TAKER: Hex = '0x'.padEnd(42, 'e') as Hex;

  it('uses args.taker as the taker address when provided', async () => {
    const { ctx } = buildContext();
    const p = await prepareMatch(ctx, {
      commitment: makeCommitment(),
      taker: EXPLICIT_TAKER,
    });
    // The taker fields in the preview should reflect the explicit
    // address, not the buildSigner default (TAKER).
    expect(p.taker.toLowerCase()).toBe(EXPLICIT_TAKER.toLowerCase());
  });

  it('does NOT call signer.getAddress when args.taker is provided', async () => {
    const signer = buildSigner();
    const ctx: CommitmentsContext = {
      api: { request: vi.fn() } as unknown as CommitmentsContext['api'],
      requireSigner: () => signer,
      getChainId: () => 137,
      getAddresses: () => ADDRESSES,
      requireChainClient: () =>
        buildPublicClient({}) as ReturnType<CommitmentsContext['requireChainClient']>,
      nonceCounter: new NonceCounter(),
      getContestsApi: () => ({
        get: vi.fn(async () => buildContest()),
        list: vi.fn(),
        scripts: vi.fn(),
      }) as unknown as ReturnType<CommitmentsContext['getContestsApi']>,
      getSpeculationsApi: () => ({}) as ReturnType<CommitmentsContext['getSpeculationsApi']>,
      getTeams: () => ({}) as ReturnType<CommitmentsContext['getTeams']>,
    };
    await prepareMatch(ctx, {
      commitment: makeCommitment(),
      taker: EXPLICIT_TAKER,
    });
    expect(signer.getAddress).not.toHaveBeenCalled();
  });

  it('works when no signer is configured at all (requireSigner would throw)', async () => {
    // Simulates the CLI's "construct OspexClient without signer for the
    // --json preview branch" pattern.
    const ctx: CommitmentsContext = {
      api: { request: vi.fn() } as unknown as CommitmentsContext['api'],
      requireSigner: () => {
        throw new Error('no signer configured — should never be called');
      },
      getChainId: () => 137,
      getAddresses: () => ADDRESSES,
      requireChainClient: () =>
        buildPublicClient({}) as ReturnType<CommitmentsContext['requireChainClient']>,
      nonceCounter: new NonceCounter(),
      getContestsApi: () => ({
        get: vi.fn(async () => buildContest()),
        list: vi.fn(),
        scripts: vi.fn(),
      }) as unknown as ReturnType<CommitmentsContext['getContestsApi']>,
      getSpeculationsApi: () => ({}) as ReturnType<CommitmentsContext['getSpeculationsApi']>,
      getTeams: () => ({}) as ReturnType<CommitmentsContext['getTeams']>,
    };
    const p = await prepareMatch(ctx, {
      commitment: makeCommitment(),
      taker: EXPLICIT_TAKER,
    });
    expect(p.taker.toLowerCase()).toBe(EXPLICIT_TAKER.toLowerCase());
  });

  it('selfMatch flag still computes correctly under explicit taker', async () => {
    const commitment = makeCommitment();
    const { ctx } = buildContext({ commitment });
    const selfTaker = commitment.maker as Hex;
    const p = await prepareMatch(ctx, { commitment, taker: selfTaker });
    expect(p.selfMatch).toBe(true);
  });

  it('falls back to signer.getAddress when args.taker is unset (current behavior preserved)', async () => {
    const signer = buildSigner();
    const ctx: CommitmentsContext = {
      api: { request: vi.fn() } as unknown as CommitmentsContext['api'],
      requireSigner: () => signer,
      getChainId: () => 137,
      getAddresses: () => ADDRESSES,
      requireChainClient: () =>
        buildPublicClient({}) as ReturnType<CommitmentsContext['requireChainClient']>,
      nonceCounter: new NonceCounter(),
      getContestsApi: () => ({
        get: vi.fn(async () => buildContest()),
        list: vi.fn(),
        scripts: vi.fn(),
      }) as unknown as ReturnType<CommitmentsContext['getContestsApi']>,
      getSpeculationsApi: () => ({}) as ReturnType<CommitmentsContext['getSpeculationsApi']>,
      getTeams: () => ({}) as ReturnType<CommitmentsContext['getTeams']>,
    };
    await prepareMatch(ctx, { commitment: makeCommitment() });
    expect(signer.getAddress).toHaveBeenCalled();
  });
});

describe('prepareMatch — redacted commitment refusal', () => {
  it('throws OspexValidationError({ field: "commitment" }) when the input commitment is redacted', async () => {
    // Pass a PublicHiddenCommitment as the input. The narrow at the top of
    // prepareMatch must fire BEFORE any contest fetch / chain read, so the
    // context can refuse every dependency without affecting the verdict.
    const hidden = {
      visibility: 'hidden' as const,
      redacted: true as const,
      payloadAvailable: false as const,
      commitmentHash: HASH,
      maker: MAKER,
      contestId: '42',
      positionType: 0 as const,
      status: 'cancelled' as const,
      storedStatus: 'open' as const,
      filledRiskAmount: '0',
      expiry: FAR_FUTURE_ISO,
      bookVisible: false as const,
      nonceInvalidated: false,
    };
    const ctx: CommitmentsContext = {
      api: {
        request: () => {
          throw new Error('no API read expected — narrow should fire first');
        },
      } as unknown as CommitmentsContext['api'],
      requireSigner: () => {
        throw new Error('no signer expected — narrow should fire first');
      },
      getChainId: () => 137,
      getAddresses: () => ADDRESSES,
      requireChainClient: () => {
        throw new Error('no chain client expected — narrow should fire first');
      },
      nonceCounter: new NonceCounter(),
      getContestsApi: () => ({
        get: () => {
          throw new Error('no contest fetch expected — narrow should fire first');
        },
        list: vi.fn(),
        scripts: vi.fn(),
      }) as unknown as ReturnType<CommitmentsContext['getContestsApi']>,
      getSpeculationsApi: () => ({}) as ReturnType<CommitmentsContext['getSpeculationsApi']>,
      getTeams: () => ({}) as ReturnType<CommitmentsContext['getTeams']>,
    };
    await expect(
      prepareMatch(ctx, { commitment: hidden }),
    ).rejects.toMatchObject({
      name: 'OspexValidationError',
      field: 'commitment',
      message: expect.stringContaining('prepare a match against'),
    });
  });
});
