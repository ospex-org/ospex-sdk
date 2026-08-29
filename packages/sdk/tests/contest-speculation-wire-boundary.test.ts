/**
 * Wire-boundary tests for the four decode paths #207's second pass moved
 * behind `parseWire()`: `contests.get`, `speculations.list`,
 * `speculations.get`, and the `speculations.subscribe` delta decode — plus
 * the commitment schema all of their orderbooks share.
 *
 * They live here rather than in `api.test.ts` because the fixtures are the
 * point: every one of them is a body core-api can actually serve, read off
 * the handlers rather than off the SDK's own types, and several are long
 * enough that inlining them would bury the assertions. `api.test.ts` keeps
 * the `contests.list` and `games.*` boundaries it already had.
 *
 * Three shapes of test here, and each catches something the others cannot:
 *
 *   1. REFUSALS, asserting the dotted `field` path — so a schema attached at
 *      the wrong nesting level reddens rather than merely throwing.
 *   2. ACCEPTANCES, each named for the specific wrong schema it rules out.
 *      Without them a refuse-everything schema passes the whole refusal half.
 *   3. FULL-MAP ROUND TRIPS, one per body, where every field carries a value
 *      unique to that field and the WHOLE decoded object is compared. This is
 *      the only shape that catches the two silent failures: a schema that
 *      forgets a key the mapper reads (zod strips it, nothing throws, the
 *      field just vanishes), and a swap between two same-typed assignments in
 *      a mapper. Twelve of the contest detail body's fields and all
 *      twenty-two of a commitment's had no swap coverage anywhere before
 *      these.
 *
 * On nullability: a mistyped NUMBER is refused by `z.string()`,
 * `z.string().nullable()` and `z.string().min(1)` alike, so it says nothing
 * about whether a field is nullable. `null` is the discriminating input, and
 * it is used in BOTH directions below — refused where core-api sentinels with
 * `''` instead, accepted where core-api genuinely serves it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OspexClient, OspexValidationError } from '../src/index.js';
import type { Commitment } from '../src/types/commitment.js';

const apiUrl = 'https://api.example.test';

function clientFor(body: unknown): OspexClient {
  const fetchImpl: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  return new OspexClient({ apiUrl, fetch: fetchImpl });
}

/** Await a promise, returning the rejection value instead of throwing. */
const err = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(() => null, (e: unknown) => e);

function expectRefusal(e: unknown, field: string, why: string): void {
  expect(e, why).toBeInstanceOf(OspexValidationError);
  expect((e as OspexValidationError).field, why).toBe(field);
}

/* ------------------------------------------------------------------ */
/* Fixtures — every value unique to its own field                      */
/* ------------------------------------------------------------------ */

/**
 * A visible commitment carrying all twenty-three wire keys, each with a value
 * no other field shares. `status` and `storedStatus` deliberately DIFFER
 * (`partially_filled` vs `open`): they are the one same-typed pair a mapper
 * could swap, and equal values would hide it.
 *
 * `storedStatus: 'open'` + a future expiry + non-zero remaining + not
 * nonce-invalidated is what makes `isLive` true, so the expected value below
 * is fixed rather than clock-dependent.
 *
 * `source` and `network` carry REAL values from core-api's CHECK / enum sets
 * rather than the `x-fieldName` placeholder the other strings use, and that
 * is deliberate: with a placeholder there, every commitment-bearing case in
 * the file doubles as the "an enum on `source` is wrong" control — measured,
 * a mutant adding that enum reddened 92 cases instead of the one aimed at it,
 * which is a decisive kill but a useless diagnosis. The dedicated acceptance
 * case overrides both with values core-api cannot emit.
 */
const visibleCommitmentWire = {
  // No `redacted` key: core-api's `rowToBody` does not emit one, and only the
  // redaction projection adds it (as `true`). An absent flag is the ordinary
  // visible shape, so the fixture carries the ordinary shape; an explicit
  // `false` has its own case below.
  commitmentHash: '0xhash-commitmentHash',
  maker: '0xmaker-maker',
  contestId: 'cid-contestId',
  scorer: '0xscorer-scorer',
  lineTicks: 101,
  positionType: 1,
  oddsTick: 202,
  marketType: 'total',
  riskAmount: '9000001',
  filledRiskAmount: '9000002',
  remainingRiskAmount: '9000003',
  nonce: '9000004',
  expiry: '2099-01-02T03:04:05.111111+00:00',
  speculationKey: '0xkey-speculationKey',
  signature: '0xsig-signature',
  status: 'partially_filled',
  storedStatus: 'open',
  source: 'agent',
  network: 'polygon',
  nonceInvalidated: false,
  bookVisible: true,
  createdAt: '2026-01-02T03:04:05.222222+00:00',
  fillability: {
    advisory: true,
    makerFundingStatus: 'overcommitted',
    orderIndividuallyBackedNow: true,
    makerBookBackedNow: false,
    makerBackingWei6: 'wei6-makerBacking',
    makerVisibleCommittedWei6: 'wei6-makerVisibleCommitted',
    makerCoverageRatioBps: 303,
    checkedAtBlock: 'block-checkedAtBlock',
    stale: false,
  },
};

/** What `toCommitment` must produce from it, key for key. */
const expectedVisibleCommitment: Commitment = {
  visibility: 'visible',
  redacted: false,
  commitmentHash: '0xhash-commitmentHash',
  maker: '0xmaker-maker',
  contestId: 'cid-contestId',
  scorer: '0xscorer-scorer',
  lineTicks: 101,
  positionType: 1,
  oddsTick: 202,
  marketType: 'total',
  riskAmount: '9000001',
  filledRiskAmount: '9000002',
  remainingRiskAmount: '9000003',
  nonce: '9000004',
  expiry: '2099-01-02T03:04:05.111111+00:00',
  speculationKey: '0xkey-speculationKey',
  signature: '0xsig-signature',
  status: 'partially_filled',
  storedStatus: 'open',
  source: 'agent',
  network: 'polygon',
  nonceInvalidated: false,
  isLive: true,
  createdAt: '2026-01-02T03:04:05.222222+00:00',
  fillability: {
    advisory: true,
    makerFundingStatus: 'overcommitted',
    orderIndividuallyBackedNow: true,
    makerBookBackedNow: false,
    makerBackingWei6: 'wei6-makerBacking',
    makerVisibleCommittedWei6: 'wei6-makerVisibleCommitted',
    makerCoverageRatioBps: 303,
    checkedAtBlock: 'block-checkedAtBlock',
    stale: false,
  },
};

/**
 * A redacted commitment — exactly the twelve keys of core-api's
 * PUBLIC_HIDDEN_ALLOWLIST. `speculations.get` surfaces one of these where the
 * contest embed drops it.
 */
const hiddenCommitmentWire = {
  redacted: true,
  payloadAvailable: false,
  commitmentHash: '0xhash-hidden',
  maker: '0xmaker-hidden',
  contestId: 'cid-hidden',
  positionType: 0,
  status: 'cancelled',
  storedStatus: 'partially_filled',
  filledRiskAmount: '7000001',
  expiry: '2098-02-03T04:05:06+00:00',
  bookVisible: false,
  nonceInvalidated: true,
};

/** A speculation with no orderbook: a list row, and a stream delta frame. */
const speculationRowWire = {
  speculationId: 'sid-speculationId',
  contestId: 'cid-specContestId',
  type: 'spread',
  lineTicks: -35,
  line: -3.5,
  awayLine: 3.5,
  homeLine: -3.5,
  speculationStatus: 1,
  winSide: 'home',
  settledAt: '2026-07-01T04:00:14.987654+00:00',
  voided: false,
};

/**
 * The `GET /v1/contests/:contestId` body — all twenty-five keys core-api's
 * detail handler emits, each with a value unique to it, plus one speculation
 * carrying both an orderbook and every flat field.
 *
 * `gameId` is NOT here: the detail handler does not emit it. The adversarial
 * case that DOES send one is separate, below.
 */
const contestDetailWire = {
  contestId: 'v-contestId',
  awayTeam: 'v-awayTeam',
  homeTeam: 'v-homeTeam',
  sport: 'v-sport',
  sportId: 11,
  matchTime: '2026-05-03T00:00:01+00:00',
  status: 'v-status',
  chainStartTime: '2026-05-03T00:00:02+00:00',
  gameMatchTime: '2026-05-03T00:00:03+00:00',
  gameEarliestMatchTime: '2026-05-03T00:00:04+00:00',
  gameRundownMatchTime: '2026-05-03T00:00:05+00:00',
  gameSportspageMatchTime: '2026-05-03T00:00:06+00:00',
  jsonoddsId: 'v-jsonoddsId',
  rundownId: 'v-rundownId',
  sportspageId: 'v-sportspageId',
  contestCreator: 'v-contestCreator',
  leagueId: 'v-leagueId',
  awayScore: 12,
  homeScore: 13,
  contestCreatedAt: '2026-05-03T00:00:07+00:00',
  verifiedAt: '2026-05-03T00:00:08+00:00',
  scoredAt: '2026-05-03T00:00:09+00:00',
  voidedAt: '2026-05-03T00:00:10+00:00',
  awayTeamId: 'v-awayTeamId',
  homeTeamId: 'v-homeTeamId',
  speculations: [{ ...speculationRowWire, orderbook: [visibleCommitmentWire] }],
};

/** The `contest` block on `GET /v1/speculations/:id` — all thirteen keys. */
const parentContextWire = {
  contestId: 'p-contestId',
  awayTeam: 'p-awayTeam',
  homeTeam: 'p-homeTeam',
  awayTeamId: 'p-awayTeamId',
  homeTeamId: 'p-homeTeamId',
  sport: 'p-sport',
  matchTime: '2026-06-03T00:00:01+00:00',
  chainStartTime: '2026-06-03T00:00:02+00:00',
  gameMatchTime: '2026-06-03T00:00:03+00:00',
  gameEarliestMatchTime: '2026-06-03T00:00:04+00:00',
  gameRundownMatchTime: '2026-06-03T00:00:05+00:00',
  gameSportspageMatchTime: '2026-06-03T00:00:06+00:00',
  status: 'p-status',
};

/** The `GET /v1/speculations/:speculationId` body. */
const speculationDetailWire = {
  ...speculationRowWire,
  orderbook: [visibleCommitmentWire],
  contest: parentContextWire,
};

const listBody = (rows: unknown[]): unknown => ({
  speculations: rows,
  pagination: { limit: 100, offset: 0, total: rows.length, hasMore: false },
});

/* ------------------------------------------------------------------ */
/* contests.get                                                        */
/* ------------------------------------------------------------------ */

describe('contests.get wire boundary — full map', () => {
  it('decodes every field of a maximal detail body, and only those fields', async () => {
    // The assertion is the WHOLE object, not a sample. A schema that forgets
    // one key strips it silently (no throw, no type error) and a mapper that
    // swaps two same-typed assignments — `verifiedAt` for `scoredAt`, the two
    // provider snapshots, the two team ids — changes nothing a per-field
    // check on one of them would see. Every value here is unique to its own
    // field, so both die.
    const contest = await clientFor(contestDetailWire).contests.get('42');
    expect(contest).toStrictEqual({
      contestId: 'v-contestId',
      awayTeam: 'v-awayTeam',
      homeTeam: 'v-homeTeam',
      sport: 'v-sport',
      sportId: 11,
      matchTime: '2026-05-03T00:00:01+00:00',
      status: 'v-status',
      chainStartTime: '2026-05-03T00:00:02+00:00',
      gameMatchTime: '2026-05-03T00:00:03+00:00',
      gameEarliestMatchTime: '2026-05-03T00:00:04+00:00',
      gameRundownMatchTime: '2026-05-03T00:00:05+00:00',
      gameSportspageMatchTime: '2026-05-03T00:00:06+00:00',
      jsonoddsId: 'v-jsonoddsId',
      rundownId: 'v-rundownId',
      sportspageId: 'v-sportspageId',
      contestCreator: 'v-contestCreator',
      leagueId: 'v-leagueId',
      awayScore: 12,
      homeScore: 13,
      contestCreatedAt: '2026-05-03T00:00:07+00:00',
      verifiedAt: '2026-05-03T00:00:08+00:00',
      scoredAt: '2026-05-03T00:00:09+00:00',
      voidedAt: '2026-05-03T00:00:10+00:00',
      awayTeamId: 'v-awayTeamId',
      homeTeamId: 'v-homeTeamId',
      speculations: [
        {
          speculationId: 'sid-speculationId',
          contestId: 'cid-specContestId',
          type: 'spread',
          lineTicks: -35,
          line: -3.5,
          awayLine: 3.5,
          homeLine: -3.5,
          speculationStatus: 1,
          winSide: 'home',
          settledAt: '2026-07-01T04:00:14.987654+00:00',
          voided: false,
          orderbook: [expectedVisibleCommitment],
        },
      ],
    });
  });

  it('decodes an orderbook commitment field for field, including the 22-key spread', async () => {
    // Stated separately from the whole-contest assertion above because this
    // is the surface with no coverage at all before now: every contests.get
    // and speculations.get fixture in the suite served `orderbook: []`.
    const contest = await clientFor(contestDetailWire).contests.get('42');
    expect(contest.speculations[0]?.orderbook?.[0]).toStrictEqual(expectedVisibleCommitment);
  });
});

describe('contests.get wire boundary — refusals', () => {
  const MISTYPED: Array<[string, unknown]> = [
    ['contestId', 123],
    ['awayTeam', 123],
    ['homeTeam', 123],
    ['sport', 123],
    ['sportId', '11'],
    ['matchTime', 123],
    ['status', 123],
    ['chainStartTime', 123],
    ['gameMatchTime', 123],
    ['gameEarliestMatchTime', 123],
    ['gameRundownMatchTime', 123],
    ['gameSportspageMatchTime', 123],
    ['jsonoddsId', 123],
    ['rundownId', 123],
    ['sportspageId', 123],
    ['contestCreator', 123],
    ['leagueId', 123],
    ['awayScore', '12'],
    ['homeScore', '13'],
    ['contestCreatedAt', 123],
    ['verifiedAt', 123],
    ['scoredAt', 123],
    ['voidedAt', 123],
    ['awayTeamId', 123],
    ['homeTeamId', 123],
    ['speculations', 'not-an-array'],
  ];

  for (const [field, bad] of MISTYPED) {
    it(`REFUSES a mistyped ${field}, naming it`, async () => {
      expectRefusal(
        await err(clientFor({ ...contestDetailWire, [field]: bad }).contests.get('42')),
        field,
        field,
      );
    });
  }

  it('REFUSES a mistyped field inside a nested speculation, naming the path through it', async () => {
    const body = {
      ...contestDetailWire,
      speculations: [{ ...speculationRowWire, speculationStatus: 2 }],
    };
    expectRefusal(
      await err(clientFor(body).contests.get('42')),
      'speculations.0.speculationStatus',
      'nested speculation',
    );
  });

  it('REFUSES a mistyped field inside a nested ORDERBOOK row, naming the full path', async () => {
    // Two levels of nesting below the body root. The path is what makes this
    // actionable on a 1000-row book, and it is also what proves the
    // discriminated union is doing the discriminating: a plain `z.union`
    // reports `invalid_union` with an EMPTY path here, which `parseWire`
    // would surface as `speculations.0.orderbook.0` — the row but not the
    // field. Measured on zod 3.25.76.
    const body = {
      ...contestDetailWire,
      speculations: [
        {
          ...speculationRowWire,
          orderbook: [{ ...visibleCommitmentWire, maker: 42 }],
        },
      ],
    };
    expectRefusal(
      await err(clientFor(body).contests.get('42')),
      'speculations.0.orderbook.0.maker',
      'nested orderbook row',
    );
  });

  it('a non-object detail body is a typed error, not a TypeError', async () => {
    const e = await err(clientFor('nope').contests.get('42'));
    expect(e).toBeInstanceOf(OspexValidationError);
    expect((e as OspexValidationError).field).toBe('body');
  });

  /**
   * `null` on a field core-api sentinels with `''` instead. These are the
   * cases a mistyped-number matrix cannot reach: `z.string()` and
   * `z.string().nullable()` both refuse `123`, so only `null` separates them,
   * and the wrong one lets a `null` into a `Contest` field declared `string`.
   */
  const NON_NULLABLE = [
    'contestId',
    'awayTeam',
    'homeTeam',
    'sport',
    'sportId',
    'matchTime',
    'status',
    'chainStartTime',
    'gameMatchTime',
    'gameEarliestMatchTime',
    'gameRundownMatchTime',
    'gameSportspageMatchTime',
    'contestCreator',
    'leagueId',
    'speculations',
  ] as const;

  for (const field of NON_NULLABLE) {
    it(`REFUSES a null ${field}`, async () => {
      expectRefusal(
        await err(clientFor({ ...contestDetailWire, [field]: null }).contests.get('42')),
        field,
        `${field} accepted a null`,
      );
    });
  }
});

describe('contests.get wire boundary — acceptances', () => {
  /**
   * Every case below is the negative control for one wrong schema. Without
   * them the refusal matrix above passes on a schema that refuses everything.
   */

  it('ACCEPTS the "" sentinel on every string core-api coalesces — `.min(1)` would refuse a real contest', async () => {
    // core-api's detail handler writes `?? ''` on nine strings, so an
    // unverified contest with no linked games row serves `''` for the whole
    // start-time block. A non-empty rule turns that into a hard failure on
    // the most ordinary row there is.
    const blanked = {
      ...contestDetailWire,
      awayTeam: '',
      homeTeam: '',
      sport: '',
      matchTime: '',
      status: '',
      contestCreator: '',
      chainStartTime: '',
      gameMatchTime: '',
      gameEarliestMatchTime: '',
      gameRundownMatchTime: '',
      gameSportspageMatchTime: '',
    };
    const contest = await clientFor(blanked).contests.get('42');
    expect(contest.chainStartTime).toBe('');
    expect(contest.gameSportspageMatchTime).toBe('');
    expect(contest.status).toBe('');
  });

  it('ACCEPTS a "" jsonoddsId — the detail handler coalesces with ?? where the LIST handler uses ||', async () => {
    // The asymmetry is core-api's and it is easy to lose: a row whose
    // `jsonodds_id` column holds an empty string is served as `''` by
    // `/v1/contests/:id` and as `null` by `/v1/contests`. The list schema's
    // identity-pair refinement requires a NON-EMPTY string; lifting it onto
    // the detail schema would refuse this body.
    const contest = await clientFor({ ...contestDetailWire, jsonoddsId: '' }).contests.get('42');
    expect(contest.jsonoddsId).toBe('');
  });

  it('ACCEPTS a PostgREST +00:00 microsecond timestamp — `.datetime()` would refuse every row', async () => {
    // zod v3's `.datetime()` defaults to Z-only, and PostgREST renders every
    // `timestamptz` with an offset. One modifier, total outage.
    const contest = await clientFor({
      ...contestDetailWire,
      verifiedAt: '2026-05-29T15:00:00.123456+00:00',
    }).contests.get('42');
    expect(contest.verifiedAt).toBe('2026-05-29T15:00:00.123456+00:00');
  });

  it('ACCEPTS an unknown sport and status — an enum would fail a whole contest on one value', async () => {
    const contest = await clientFor({
      ...contestDetailWire,
      sport: 'cricket',
      status: 'rain-delay',
    }).contests.get('42');
    expect(contest.sport).toBe('cricket');
    expect(contest.status).toBe('rain-delay');
  });

  it('ACCEPTS an extra server block and strips it — `.strict()` would refuse a forward-compatible server', async () => {
    const contest = await clientFor({
      ...contestDetailWire,
      probablePitchers: { home: 'Cease', away: 'Mikolas' },
    }).contests.get('42');
    expect(contest).not.toHaveProperty('probablePitchers');
    expect(contest.contestId).toBe('v-contestId');
  });

  it('ACCEPTS a minimal older-build body — the whole detail-only block is optional', async () => {
    // This is the shape a core-api predating the detail enrichment serves,
    // and it is what forces every one of those twelve keys to stay
    // `.optional()`. The keys must stay ABSENT rather than being minted:
    // `toContest` copies on `!== undefined`, so a zod `.default()` anywhere
    // here would turn absence into an own-property.
    const minimal = {
      contestId: '42',
      awayTeam: 'A',
      homeTeam: 'B',
      sport: 'nba',
      sportId: 1,
      matchTime: '2026-05-03T00:00:00Z',
      status: 'verified',
      speculations: [],
    };
    const contest = await clientFor(minimal).contests.get('42');
    for (const absent of [
      'chainStartTime',
      'gameMatchTime',
      'gameEarliestMatchTime',
      'gameRundownMatchTime',
      'gameSportspageMatchTime',
      'jsonoddsId',
      'rundownId',
      'sportspageId',
      'contestCreator',
      'leagueId',
      'awayScore',
      'homeScore',
      'contestCreatedAt',
      'verifiedAt',
      'scoredAt',
      'voidedAt',
      'awayTeamId',
      'homeTeamId',
    ]) {
      expect(contest, `${absent} was minted from an absent key`).not.toHaveProperty(absent);
    }
  });

  /**
   * The other direction, and it is not symmetry for its own sake: a schema
   * broken to refuse every null passes all fifteen NON_NULLABLE cases above.
   * These eleven are the fields where `null` is a VALUE core-api serves —
   * `?? null`, not `?? ''` — and refusing one is an outage rather than a
   * caught bug.
   */
  const NULLABLE_WITH_VALUE = [
    'jsonoddsId',
    'rundownId',
    'sportspageId',
    'awayScore',
    'homeScore',
    'contestCreatedAt',
    'verifiedAt',
    'scoredAt',
    'voidedAt',
    'awayTeamId',
    'homeTeamId',
  ] as const;

  for (const field of NULLABLE_WITH_VALUE) {
    it(`ACCEPTS a null ${field}, and keeps it distinct from the key being absent`, async () => {
      // Present-and-null: the key EXISTS and holds null. `toBe(null)` alone
      // would also pass on an absent key reading back as undefined, so the
      // property check is what discriminates.
      const served: Record<string, unknown> = { ...contestDetailWire, [field]: null };
      const withNull = await clientFor(served).contests.get('42');
      expect(withNull, `${field} present-and-null`).toHaveProperty(field, null);

      // Typed as a Record before the computed-key destructure: an object
      // literal has no string index signature, so destructuring it by a
      // computed key is TS2537 under `yarn typecheck:tests`.
      const { [field]: _omitted, ...withoutKey } = served;
      const absent = await clientFor(withoutKey).contests.get('42');
      expect(absent, `${field} absent`).not.toHaveProperty(field);
    });
  }

  it('ACCEPTS a speculation with no settlement trio — the pre-#41 tolerance, on the DETAIL path', async () => {
    // Pinned on the list path already. Replicated here because a schema
    // written from the settlement trio's old `required` interface declaration
    // would refuse this body, and nothing else on this surface would catch it.
    const body = {
      ...contestDetailWire,
      speculations: [
        {
          speculationId: '9',
          contestId: '1',
          type: 'moneyline',
          lineTicks: 0,
          line: null,
          speculationStatus: 0,
        },
      ],
    };
    const contest = await clientFor(body).contests.get('42');
    expect(contest.speculations[0]?.winSide).toBeNull();
    expect(contest.speculations[0]?.settledAt).toBeNull();
    expect(contest.speculations[0]?.voided).toBe(false);
    expect(contest.speculations[0]).not.toHaveProperty('orderbook');
  });

  it('ACCEPTS a redacted orderbook row and decodes it to the hidden variant', async () => {
    // core-api's contest handler DROPS a redacted row rather than surfacing
    // one, so this body is not what it serves today. The schema admits it
    // anyway: `Speculation.orderbook` is already the public `Commitment[]`
    // union, so accepting one costs nothing, while refusing one would turn a
    // server-side change into a whole-contest failure on the market-maker's
    // discovery path.
    const body = {
      ...contestDetailWire,
      speculations: [{ ...speculationRowWire, orderbook: [hiddenCommitmentWire] }],
    };
    const contest = await clientFor(body).contests.get('42');
    expect(contest.speculations[0]?.orderbook?.[0]).toStrictEqual({
      visibility: 'hidden',
      redacted: true,
      payloadAvailable: false,
      commitmentHash: '0xhash-hidden',
      maker: '0xmaker-hidden',
      contestId: 'cid-hidden',
      positionType: 0,
      status: 'cancelled',
      storedStatus: 'partially_filled',
      filledRiskAmount: '7000001',
      expiry: '2098-02-03T04:05:06+00:00',
      bookVisible: false,
      nonceInvalidated: true,
    });
  });

  it('ACCEPTS a commitment with no bookVisible / storedStatus — the two real back-compat shapes', async () => {
    // `bookVisible` is omitted by a build predating the M2 own-state migration
    // and `storedStatus` by one predating effective-status. `redacted` is NOT
    // in this list: no build sends it on a full body, so its absence is the
    // ordinary shape rather than a tolerance — the fixture already omits it.
    //
    // The observable here is the `storedStatus` fallback landing on `status`,
    // which is only sound because `status` holds a value that CAN be stored.
    // The case where it does not is refused, below.
    const { bookVisible: _bv, storedStatus: _ss, ...older } = visibleCommitmentWire;
    const body = {
      ...contestDetailWire,
      speculations: [{ ...speculationRowWire, orderbook: [older] }],
    };
    const contest = await clientFor(body).contests.get('42');
    const row = contest.speculations[0]?.orderbook?.[0];
    expect(row?.redacted).toBe(false);
    expect(row?.storedStatus).toBe('partially_filled');
  });

  it('ACCEPTS an explicit redacted:false — a producer may state the discriminant', async () => {
    // The negative control for the fixture's omission: the visible arm's
    // discriminant is `z.literal(false).optional()`, so BOTH an absent key and
    // an explicit `false` must select that arm. Without this, narrowing it to
    // a required literal would pass every other case in the file.
    const body = {
      ...contestDetailWire,
      speculations: [
        { ...speculationRowWire, orderbook: [{ ...visibleCommitmentWire, redacted: false }] },
      ],
    };
    const contest = await clientFor(body).contests.get('42');
    expect(contest.speculations[0]?.orderbook?.[0]?.visibility).toBe('visible');
  });
});

/* ------------------------------------------------------------------ */
/* storedStatus — the one combination the legacy fallback cannot express */
/* ------------------------------------------------------------------ */

/**
 * `storedStatus` may be omitted by a core-api predating effective-status, and
 * the mapper then reads the raw lifecycle off `status`. That is sound only
 * while `status` holds a value that can be STORED. `'expired'` cannot: it is
 * derived, no writer stores it, and a build old enough to omit `storedStatus`
 * never derived it.
 *
 * Until the #207 review, the pair was reconciled with
 * `body.storedStatus ?? (body.status as StoredCommitmentStatus)` — and that
 * cast published `storedStatus: 'expired'` into a field the public type
 * declares as four values. Measured against the built SDK, which is where the
 * claim lives: a consumer reads the artifact, not the source.
 */
describe('commitment storedStatus / status invariant', () => {
  const withoutStored = (over: Record<string, unknown> = {}): unknown => {
    const { storedStatus: _drop, ...rest } = visibleCommitmentWire;
    return { ...rest, ...over };
  };
  const bookOf = (row: unknown): unknown => ({ ...speculationDetailWire, orderbook: [row] });

  it('REFUSES an effective `expired` with no storedStatus, naming the missing field', async () => {
    expectRefusal(
      await err(clientFor(bookOf(withoutStored({ status: 'expired' }))).speculations.get('500')),
      'orderbook.0.storedStatus',
      'expired without storedStatus',
    );
  });

  it('ACCEPTS an effective `expired` WITH a storedStatus — the shape core-api actually serves', async () => {
    // The negative control. Without it, a schema that refused every `expired`
    // row would pass the case above, and `expired` is an ordinary effective
    // status for a time-expired open commitment.
    const detail = await clientFor(
      bookOf({ ...visibleCommitmentWire, status: 'expired', storedStatus: 'open' }),
    ).speculations.get('500');
    const row = detail.orderbook[0];
    expect(row?.status).toBe('expired');
    expect(row?.storedStatus).toBe('open');
  });

  it('ACCEPTS every OTHER status with no storedStatus — the legacy fallback still works', async () => {
    // The second control: the refusal above must be about `expired` alone, not
    // about an absent `storedStatus`. All four stored values fall back cleanly.
    for (const status of ['open', 'partially_filled', 'filled', 'cancelled'] as const) {
      const detail = await clientFor(bookOf(withoutStored({ status }))).speculations.get('500');
      expect(detail.orderbook[0]?.storedStatus, status).toBe(status);
    }
  });

  it('REFUSES the same shape on the UNGUARDED commitments.list path, as a typed error', async () => {
    // `commitments.list` has no schema yet, so the boundary cannot refuse this
    // one — the resolver does, and it must still be an `OspexValidationError`
    // rather than a value outside the declared union. This is the case that
    // covers `resolveStoredStatus`'s own guard, which is unreachable from the
    // two guarded endpoints.
    const listBody = {
      commitments: [withoutStored({ status: 'expired' })],
      pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
    };
    const e = await err(clientFor(listBody).commitments.list());
    expect(e).toBeInstanceOf(OspexValidationError);
    expect((e as OspexValidationError).field).toBe('storedStatus');
  });
});

/* ------------------------------------------------------------------ */
/* The uint256 amounts — the one content rule, and why it is allowed    */
/* ------------------------------------------------------------------ */

/**
 * These four are the repo rule's stated exception rather than a departure
 * from it: a content rule belongs at a boundary when something downstream
 * coerces the value. `computeIsLive` calls `BigInt(remainingRiskAmount)`, and
 * the public type documents all four as uint256 decimal strings that a
 * consumer may parse.
 *
 * Measured against the built SDK before the guard existed: a
 * `remainingRiskAmount` of `'not-decimal'` escaped as a raw `SyntaxError`
 * ("Cannot convert not-decimal to a BigInt"), which is not an
 * `OspexValidationError` and so is not something a consumer's catch is
 * documented to see; and the other three were published verbatim.
 */
describe('commitment uint256 amounts', () => {
  const bookOf = (over: Record<string, unknown>): unknown => ({
    ...speculationDetailWire,
    orderbook: [{ ...visibleCommitmentWire, ...over }],
  });

  for (const field of [
    'riskAmount',
    'filledRiskAmount',
    'remainingRiskAmount',
    'nonce',
  ] as const) {
    it(`REFUSES a non-decimal ${field} as a TYPED error, naming the field`, async () => {
      expectRefusal(
        await err(clientFor(bookOf({ [field]: 'not-decimal' })).speculations.get('500')),
        `orderbook.0.${field}`,
        field,
      );
    });

    it(`REFUSES an empty ${field} — "" is not a uint256 and BigInt("") is 0n, which is a lie`, async () => {
      // `BigInt('')` does NOT throw; it returns `0n`. So an empty string is the
      // input a "does BigInt survive it" rule would miss while still corrupting
      // every amount it touches.
      expectRefusal(
        await err(clientFor(bookOf({ [field]: '' })).speculations.get('500')),
        `orderbook.0.${field}`,
        `${field} empty`,
      );
    });
  }

  it('ACCEPTS a full-width uint256 and a zero — the rule bounds FORM, not magnitude', async () => {
    // The negative control. A `.max()` or a `Number`-based check would refuse
    // the first; core-api serves `numeric(78,0)` values that exceed every
    // float. `'0'` is the routine value for an unfilled commitment.
    const max = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    const detail = await clientFor(
      bookOf({ riskAmount: max, filledRiskAmount: '0', remainingRiskAmount: max, nonce: '0' }),
    ).speculations.get('500');
    const row = detail.orderbook[0];
    expect(row?.visibility === 'visible' ? row.riskAmount : null).toBe(max);
    expect(row?.filledRiskAmount).toBe('0');
  });

  it('REFUSES a non-decimal filledRiskAmount on the REDACTED arm too', async () => {
    // The hidden allow-list carries `filledRiskAmount`, so the guard has to be
    // on both arms. Enumerating the arm the mapper touches less is exactly how
    // the first pass at this missed `doctor` on the CLI side.
    expectRefusal(
      await err(
        clientFor({
          ...speculationDetailWire,
          orderbook: [{ ...hiddenCommitmentWire, filledRiskAmount: '12.5' }],
        }).speculations.get('500'),
      ),
      'orderbook.0.filledRiskAmount',
      'hidden arm',
    );
  });
});

describe('contests.get wire boundary — the list-only gameId', () => {
  it('REFUSES to mint gameId from a detail body that carries one, at three layers', async () => {
    // The property is unchanged from before the boundary existed; what
    // changed is how many things enforce it. The schema does not declare
    // `gameId`, so zod strips it before the mapper runs; `toContest`'s input
    // type has no such property, so adding a copy there does not compile; and
    // `list()` attaches it after the shared mapper. The fixture value is
    // distinct from `jsonoddsId`, so this also catches a mapper deriving one
    // from the other.
    const contest = await clientFor({
      ...contestDetailWire,
      gameId: 'UNEXPECTED-DETAIL-VALUE',
    }).contests.get('42');
    expect(contest).not.toHaveProperty('gameId');
    expect(contest.jsonoddsId).toBe('v-jsonoddsId');
  });

  it('REFUSES to mint the dated-list-only gameFinalType either, by the same mechanism', async () => {
    // `gameFinalType` reaches the wire ONLY on `GET /v1/contests?date=` rows.
    // It was declared on the detail schema so the shared `toContest` could copy
    // it, and the #207 review reproduced a detail body minting it — the exact
    // asymmetry this file argues against for `gameId`. It is attached on the
    // list path now, and `ContestWire` declares neither, so a copy added to
    // `toContest` for either key does not compile.
    const contest = await clientFor({
      ...contestDetailWire,
      gameFinalType: 'Finished',
    }).contests.get('42');
    expect(contest).not.toHaveProperty('gameFinalType');
  });

  it('does NOT apply the list schema’s identity-pair refinement', async () => {
    // On the LIST path a `gameId` unequal to `jsonoddsId` is refused with
    // `field: 'gameId'`. Lifting that refinement here would refuse the body
    // above instead of stripping the key — and would additionally refuse the
    // `''` jsonoddsId this endpoint serves. Asserted as a parse SUCCESS so
    // the two surfaces cannot be quietly unified.
    const e = await err(
      clientFor({ ...contestDetailWire, gameId: 'DIFFERENT', jsonoddsId: 'v-jsonoddsId' })
        .contests.get('42'),
    );
    expect(e).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* speculations.list                                                   */
/* ------------------------------------------------------------------ */

describe('speculations.list wire boundary', () => {
  it('decodes a row field for field', async () => {
    const [spec] = await clientFor(listBody([speculationRowWire])).speculations.list();
    expect(spec).toStrictEqual({
      speculationId: 'sid-speculationId',
      contestId: 'cid-specContestId',
      type: 'spread',
      lineTicks: -35,
      line: -3.5,
      awayLine: 3.5,
      homeLine: -3.5,
      speculationStatus: 1,
      winSide: 'home',
      settledAt: '2026-07-01T04:00:14.987654+00:00',
      voided: false,
    });
  });

  const MISTYPED: Array<[string, unknown]> = [
    ['speculationId', 123],
    ['contestId', 123],
    ['type', 'parlay'],
    ['lineTicks', '-35'],
    ['line', '-3.5'],
    ['awayLine', '3.5'],
    ['homeLine', '-3.5'],
    ['speculationStatus', 2],
    ['winSide', 'sideways'],
    ['settledAt', 123],
    ['voided', 'no'],
  ];

  for (const [field, bad] of MISTYPED) {
    it(`REFUSES a mistyped ${field}, naming the row and the field`, async () => {
      expectRefusal(
        await err(clientFor(listBody([{ ...speculationRowWire, [field]: bad }])).speculations.list()),
        `speculations.0.${field}`,
        field,
      );
    });
  }

  it('REFUSES a mistyped pagination field, naming the path', async () => {
    const body = {
      speculations: [speculationRowWire],
      pagination: { limit: 100, offset: 0, total: 1, hasMore: 'yes' },
    };
    expectRefusal(
      await err(clientFor(body).speculations.list()),
      'pagination.hasMore',
      'pagination.hasMore',
    );
  });

  it('REFUSES a body with no pagination wrapper', async () => {
    expectRefusal(
      await err(clientFor({ speculations: [speculationRowWire] }).speculations.list()),
      'pagination',
      'missing pagination',
    );
  });

  it('ACCEPTS an empty page — `.nonempty()` would refuse an ordinary 200', async () => {
    expect(await clientFor(listBody([])).speculations.list()).toStrictEqual([]);
  });

  it('ACCEPTS a moneyline row: null line, no awayLine/homeLine, and the trio absent', async () => {
    // Three tolerances in the one shape core-api serves most often. The
    // spread-only pair must stay ABSENT rather than minted, and the trio is
    // the pre-#41 degradation.
    const [spec] = await clientFor(
      listBody([
        {
          speculationId: '500',
          contestId: '42',
          type: 'moneyline',
          lineTicks: 0,
          line: null,
          speculationStatus: 0,
        },
      ]),
    ).speculations.list();
    expect(spec).not.toHaveProperty('awayLine');
    expect(spec).not.toHaveProperty('homeLine');
    expect(spec?.winSide).toBeNull();
    expect(spec?.voided).toBe(false);
  });

  it('ACCEPTS and strips a `closing` block — it is list-only and no mapper reads it', async () => {
    // core-api attaches the no-vig closing line on the list endpoint only.
    // The public `Speculation` has never carried it; the assertion is that
    // enumerating it is not required, and that it does not leak.
    const [spec] = await clientFor(
      listBody([
        {
          ...speculationRowWire,
          closing: { awayDecimal: 1.9, homeDecimal: 2.1, line: -3.5, estimated: false },
        },
      ]),
    ).speculations.list();
    expect(spec).not.toHaveProperty('closing');
    expect(spec?.speculationId).toBe('sid-speculationId');
  });

  it('ACCEPTS null on the two nullable numerics, and refuses null on the rest', async () => {
    const ok = await clientFor(
      listBody([{ ...speculationRowWire, lineTicks: null, line: null }]),
    ).speculations.list();
    expect(ok[0]?.lineTicks).toBeNull();
    expect(ok[0]?.line).toBeNull();

    for (const field of ['speculationId', 'contestId', 'type', 'speculationStatus'] as const) {
      expectRefusal(
        await err(
          clientFor(listBody([{ ...speculationRowWire, [field]: null }])).speculations.list(),
        ),
        `speculations.0.${field}`,
        `${field} accepted a null`,
      );
    }

    // `winSide` and `settledAt` are `.nullable()` AND `.optional()` — null is
    // how a current core-api reports an unsettled speculation.
    const unsettled = await clientFor(
      listBody([{ ...speculationRowWire, winSide: null, settledAt: null }]),
    ).speculations.list();
    expect(unsettled[0]?.winSide).toBeNull();
    expect(unsettled[0]?.settledAt).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* speculations.get                                                    */
/* ------------------------------------------------------------------ */

describe('speculations.get wire boundary', () => {
  it('decodes the whole detail body — base fields, orderbook and parent context', async () => {
    const detail = await clientFor(speculationDetailWire).speculations.get('500');
    expect(detail).toStrictEqual({
      speculationId: 'sid-speculationId',
      contestId: 'cid-specContestId',
      type: 'spread',
      lineTicks: -35,
      line: -3.5,
      awayLine: 3.5,
      homeLine: -3.5,
      speculationStatus: 1,
      winSide: 'home',
      settledAt: '2026-07-01T04:00:14.987654+00:00',
      voided: false,
      orderbook: [expectedVisibleCommitment],
      contest: {
        contestId: 'p-contestId',
        awayTeam: 'p-awayTeam',
        homeTeam: 'p-homeTeam',
        awayTeamId: 'p-awayTeamId',
        homeTeamId: 'p-homeTeamId',
        sport: 'p-sport',
        matchTime: '2026-06-03T00:00:01+00:00',
        chainStartTime: '2026-06-03T00:00:02+00:00',
        gameMatchTime: '2026-06-03T00:00:03+00:00',
        gameEarliestMatchTime: '2026-06-03T00:00:04+00:00',
        gameRundownMatchTime: '2026-06-03T00:00:05+00:00',
        gameSportspageMatchTime: '2026-06-03T00:00:06+00:00',
        status: 'p-status',
      },
    });
  });

  it('REFUSES a body with no orderbook key rather than fabricating an empty book', async () => {
    // The mapper used to read `body.orderbook ?? []`. On an ORDERBOOK that
    // fallback is worse than a refusal: it reports "no liquidity" — a wrong
    // answer — where the truth is "the server did not say". core-api
    // initialises the key to `[]` before the branch that fills it and spreads
    // it in unconditionally, so a body without it is a broken server, not an
    // old one.
    const { orderbook: _o, ...withoutOrderbook } = speculationDetailWire;
    expectRefusal(
      await err(clientFor(withoutOrderbook).speculations.get('500')),
      'orderbook',
      'missing orderbook',
    );
  });

  it('ACCEPTS an empty orderbook — the ordinary shape for a speculation with no open commitments', async () => {
    // The negative control for the case above: `[]` served explicitly is
    // fine, and only an ABSENT key is refused. Without this, a schema that
    // refused every orderbook would pass.
    const detail = await clientFor({ ...speculationDetailWire, orderbook: [] })
      .speculations.get('500');
    expect(detail.orderbook).toStrictEqual([]);
  });

  it('ACCEPTS a mixed visible + redacted orderbook — this endpoint surfaces hidden rows redacted', async () => {
    // Unlike the contest embed, `/v1/speculations/:id` maps every row through
    // the redaction router into a flat union-typed array. A schema restricted
    // to the visible arm would refuse a body core-api is designed to serve.
    const detail = await clientFor({
      ...speculationDetailWire,
      orderbook: [visibleCommitmentWire, hiddenCommitmentWire],
    }).speculations.get('500');
    expect(detail.orderbook.map((c) => c.visibility)).toStrictEqual(['visible', 'hidden']);
    expect(detail.orderbook[1]).not.toHaveProperty('signature');
  });

  it('REFUSES a mistyped orderbook row, naming the row index and field', async () => {
    expectRefusal(
      await err(
        clientFor({
          ...speculationDetailWire,
          orderbook: [visibleCommitmentWire, { ...visibleCommitmentWire, riskAmount: 1 }],
        }).speculations.get('500'),
      ),
      'orderbook.1.riskAmount',
      'orderbook row',
    );
  });

  it('REFUSES a redacted row whose discriminant does not match its shape', async () => {
    // `payloadAvailable` is the second discriminant on core-api's allow-list.
    // A row claiming `redacted: true` without it is not a shape any build
    // emits, and the discriminated union names the missing field rather than
    // falling back to the visible arm.
    expectRefusal(
      await err(
        clientFor({
          ...speculationDetailWire,
          orderbook: [{ ...hiddenCommitmentWire, payloadAvailable: true }],
        }).speculations.get('500'),
      ),
      'orderbook.0.payloadAvailable',
      'hidden discriminant',
    );
  });

  const CONTEXT_MISTYPED: Array<[string, unknown]> = [
    ['contestId', 123],
    ['awayTeam', 123],
    ['homeTeam', 123],
    ['awayTeamId', 123],
    ['homeTeamId', 123],
    ['sport', 123],
    ['matchTime', 123],
    ['chainStartTime', 123],
    ['gameMatchTime', 123],
    ['gameEarliestMatchTime', 123],
    ['gameRundownMatchTime', 123],
    ['gameSportspageMatchTime', 123],
    ['status', 123],
  ];

  for (const [field, bad] of CONTEXT_MISTYPED) {
    it(`REFUSES a mistyped contest.${field}, naming the path`, async () => {
      expectRefusal(
        await err(
          clientFor({
            ...speculationDetailWire,
            contest: { ...parentContextWire, [field]: bad },
          }).speculations.get('500'),
        ),
        `contest.${field}`,
        field,
      );
    });
  }

  it('ACCEPTS a parent context with both team ids ABSENT — the pre-team-UUID build', async () => {
    // The shape that forces `awayTeamId` / `homeTeamId` to be `.optional()`
    // as well as `.nullable()`. Declaring them required — as the deleted
    // `SpeculationParentContextBody` did — refuses every body that build
    // serves, and every parent-context fixture in this repo. `toContext`
    // degrades them to null.
    const { awayTeamId: _a, homeTeamId: _h, ...older } = parentContextWire;
    const detail = await clientFor({ ...speculationDetailWire, contest: older })
      .speculations.get('500');
    expect(detail.contest.awayTeamId).toBeNull();
    expect(detail.contest.homeTeamId).toBeNull();
  });

  it('ACCEPTS a null team id, and keeps it distinct from the key being absent', async () => {
    const detail = await clientFor({
      ...speculationDetailWire,
      contest: { ...parentContextWire, awayTeamId: null, homeTeamId: null },
    }).speculations.get('500');
    expect(detail.contest).toHaveProperty('awayTeamId', null);
    expect(detail.contest).toHaveProperty('homeTeamId', null);
  });

  it('REFUSES a null on the ""-sentinelled context strings', async () => {
    // The ten fields core-api coalesces with `?? ''`. `null` on any of them
    // is a shape it cannot produce, and the ONLY input that separates
    // `z.string()` from `z.string().nullable()` here.
    for (const field of [
      'contestId',
      'awayTeam',
      'homeTeam',
      'sport',
      'matchTime',
      'chainStartTime',
      'gameMatchTime',
      'gameEarliestMatchTime',
      'gameRundownMatchTime',
      'gameSportspageMatchTime',
      'status',
    ] as const) {
      expectRefusal(
        await err(
          clientFor({
            ...speculationDetailWire,
            contest: { ...parentContextWire, [field]: null },
          }).speculations.get('500'),
        ),
        `contest.${field}`,
        `contest.${field} accepted a null`,
      );
    }
  });

  it('ACCEPTS the "" sentinels on the context start-time block — `.min(1)` would refuse an unlinked contest', async () => {
    const detail = await clientFor({
      ...speculationDetailWire,
      contest: {
        ...parentContextWire,
        chainStartTime: '',
        gameMatchTime: '',
        gameEarliestMatchTime: '',
        gameRundownMatchTime: '',
        gameSportspageMatchTime: '',
      },
    }).speculations.get('500');
    expect(detail.contest.chainStartTime).toBe('');
    expect(detail.contest.gameSportspageMatchTime).toBe('');
  });

  it('ACCEPTS a context with the start-time block ABSENT, and does not mint the keys', async () => {
    const older = {
      contestId: '42',
      awayTeam: 'Lakers',
      homeTeam: 'Celtics',
      sport: 'nba',
      matchTime: '2026-05-03T00:00:00Z',
      status: 'verified',
    };
    const detail = await clientFor({ ...speculationDetailWire, contest: older })
      .speculations.get('500');
    for (const field of [
      'chainStartTime',
      'gameMatchTime',
      'gameEarliestMatchTime',
      'gameRundownMatchTime',
      'gameSportspageMatchTime',
    ]) {
      expect(detail.contest, `${field} was minted`).not.toHaveProperty(field);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The commitment status enums — the one place a content-shaped rule    */
/* is deliberate, so both halves of the trade are pinned.               */
/* ------------------------------------------------------------------ */

describe('commitment status enums', () => {
  const orderbookOf = (row: unknown): unknown => ({ ...speculationDetailWire, orderbook: [row] });

  it('ACCEPTS every value the effective-status union declares', async () => {
    for (const status of ['open', 'partially_filled', 'filled', 'cancelled', 'expired'] as const) {
      const detail = await clientFor(orderbookOf({ ...visibleCommitmentWire, status }))
        .speculations.get('500');
      expect(detail.orderbook[0]?.status, status).toBe(status);
    }
  });

  it('ACCEPTS every value the STORED-status union declares — which excludes `expired`', async () => {
    for (const storedStatus of ['open', 'partially_filled', 'filled', 'cancelled'] as const) {
      const detail = await clientFor(orderbookOf({ ...visibleCommitmentWire, storedStatus }))
        .speculations.get('500');
      expect(detail.orderbook[0]?.storedStatus, storedStatus).toBe(storedStatus);
    }
  });

  it('REFUSES a status outside the union, and that refusal is the deliberate half of the trade', async () => {
    // core-api types `deriveEffectiveStatus`'s return as a bare `string` so
    // an unrecognised STORED value passes through rather than being cast, and
    // a schema of `z.string()` would mirror that. It does not compile: the
    // public `Commitment.status` is a five-value union, so `string` is not
    // assignable to it. Refusing is therefore the honest option rather than a
    // stylistic tightening — the alternative is a value the public type says
    // cannot exist.
    //
    // The bound: reaching this on either guarded endpoint needs a row
    // violating core-api's `commitments_status_check`, because both orderbook
    // queries filter `status in ('open','partially_filled')`. Re-check it
    // before reusing this schema on `/v1/commitments`, which serves rows
    // those filters exclude.
    expectRefusal(
      await err(
        clientFor(orderbookOf({ ...visibleCommitmentWire, status: 'partially_cancelled' }))
          .speculations.get('500'),
      ),
      'orderbook.0.status',
      'unknown status',
    );
  });

  it('ACCEPTS an unknown source and network — the public type declares those `string`', async () => {
    // The control for the case above: it is the PUBLIC TYPE that decides
    // whether the schema is an enum, not a preference for strictness.
    // core-api bounds `source` with a CHECK and `network` with a Postgres
    // enum, and both are still `z.string()` here because `Commitment` declares
    // them `string`. Without this, "use an enum wherever core-api has one"
    // would pass the suite.
    const detail = await clientFor(
      orderbookOf({ ...visibleCommitmentWire, source: 'relay-v2', network: 'base' }),
    ).speculations.get('500');
    const row = detail.orderbook[0];
    expect(row?.visibility === 'visible' ? row.source : null).toBe('relay-v2');
    expect(row?.visibility === 'visible' ? row.network : null).toBe('base');
  });

  it('ACCEPTS a bookVisible=false full body — `z.literal(true)` would refuse the rollback shape', async () => {
    // Under core-api's `REDACT_HIDDEN_PUBLIC=false` deploy-window rollback a
    // hidden row renders as a FULL body carrying `bookVisible: false` and no
    // `redacted` flag. core-api types the field `boolean`; so does the schema.
    const detail = await clientFor(
      orderbookOf({ ...visibleCommitmentWire, bookVisible: false }),
    ).speculations.get('500');
    expect(detail.orderbook[0]?.visibility).toBe('visible');
    // The wire-only flag is stripped from the public visible type.
    expect(detail.orderbook[0]).not.toHaveProperty('bookVisible');
  });
});

/* ------------------------------------------------------------------ */
/* The nullish-absorber class — enumerated from source, not sampled     */
/* ------------------------------------------------------------------ */

/**
 * A blind spot the #207 review found by mutation, and this closes the CLASS
 * rather than the instance.
 *
 * `x ?? y` absorbs BOTH `null` and `undefined`. So for any field a mapper
 * reads that way, widening its schema to `.nullable()` changes NO type — the
 * `??` swallows the null before it reaches the public field — and reddens no
 * assertion unless some case actually sends `null`. Reproduced on this branch:
 * widening `voided` to `.nullable().optional()` passed `tsc` and all 1,242
 * tests. That is precisely the nullability drift #207 exists to catch.
 *
 * Guarded fields fail differently and safely: `if (x !== undefined) out.x = x`
 * puts the widened type straight into the public field, so `tsc` catches it.
 * It is only the `??` sites that need a runtime case.
 *
 * So: scan the mappers for those sites and require every one to be classified
 * below, then drive each classification. A new `??` fails the scan until it is
 * listed, which is the maintenance rule this file cannot enforce by convention.
 */
describe('nullish-absorbing mapper fields', () => {
  const SRC = new URL('../src/', import.meta.url);
  const MAPPER_FILES = ['api/contests.ts', 'api/speculations.ts', 'api/commitments.ts'];

  /**
   * Comments are stripped BEFORE the scan. This is not hygiene — it is
   * required: documenting one of these sites naturally means quoting a
   * `body.x ??` expression, and a scan over raw text would report the prose as
   * a live site.
   */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const executableCode = (file: string): string =>
    stripComments(readFileSync(new URL(file, SRC), 'utf8'));

  function absorbedFields(): string[] {
    const found = new Set<string>();
    for (const file of MAPPER_FILES) {
      for (const m of executableCode(file).matchAll(/body\.([A-Za-z][A-Za-z0-9]*)\s*\?\?/g)) {
        found.add(m[1]!);
      }
    }
    return [...found].sort();
  }

  /**
   * Every absorbing site, and what `null` must do there. `null-is-a-value` is
   * the other half of the control: without it, a schema broken to refuse every
   * null would pass the `refuses-null` half.
   */
  const CLASSIFIED = {
    winSide: 'null-is-a-value',
    settledAt: 'null-is-a-value',
    voided: 'refuses-null',
    awayTeamId: 'null-is-a-value',
    homeTeamId: 'null-is-a-value',
  } as const;

  /** Where each field lives on the wire, so `null` reaches the right schema. */
  const PROBE: Record<keyof typeof CLASSIFIED, (client: OspexClient) => Promise<unknown>> = {
    winSide: (c) => c.speculations.list(),
    settledAt: (c) => c.speculations.list(),
    voided: (c) => c.speculations.list(),
    awayTeamId: (c) => c.speculations.get('500'),
    homeTeamId: (c) => c.speculations.get('500'),
  };

  const bodyWithNull = (field: keyof typeof CLASSIFIED): unknown =>
    field === 'awayTeamId' || field === 'homeTeamId'
      ? { ...speculationDetailWire, contest: { ...parentContextWire, [field]: null } }
      : listBody([{ ...speculationRowWire, [field]: null }]);

  it('every `??` site in the mappers is classified here', () => {
    // The maintenance rule, enforced. Adding a `?? ` to a mapper without
    // classifying its field fails HERE rather than opening the hole silently.
    expect(absorbedFields()).toStrictEqual(Object.keys(CLASSIFIED).sort());
  });

  it('the scan reads executable code, not prose', () => {
    // Guards the guard — on a SYNTHETIC input, deliberately, and that is the
    // whole point. Asserting this against the current mapper files does not
    // work: measured, no comment in the three of them contains `body.x ??`
    // today, so a mutant deleting the comment stripping SURVIVED a battery.
    // A guard whose own test cannot go red is decoration. This one exercises
    // the stripper on an input that discriminates, so the day someone
    // documents one of these sites in prose — the natural thing to do — the
    // scan does not silently start reporting it.
    const sample = [
      '/* a block comment mentioning body.blockDecoy ?? null */',
      '// a line comment mentioning body.lineDecoy ?? null',
      'const x = body.realSite ?? null;',
    ].join('\n');
    const stripped = stripComments(sample);
    expect(stripped, 'a block comment leaked into the scan').not.toContain('body.blockDecoy');
    expect(stripped, 'a line comment leaked into the scan').not.toContain('body.lineDecoy');
    expect(stripped, 'the stripper ate executable code').toContain('body.realSite');
  });

  for (const [field, expected] of Object.entries(CLASSIFIED)) {
    it(`${field}: null is ${expected}`, async () => {
      const key = field as keyof typeof CLASSIFIED;
      const e = await err(PROBE[key](clientFor(bodyWithNull(key))));
      if (expected === 'refuses-null') {
        expect(e, `${field} accepted a null`).toBeInstanceOf(OspexValidationError);
      } else {
        expect(e, `${field} refused a null core-api serves`).toBeNull();
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* speculations.subscribe — the frame decode                            */
/* ------------------------------------------------------------------ */

/**
 * A stream decode failure is NOT surfaced to the caller: `subscribeToStream`
 * catches it, emits `connection_failed` on `onError` and SKIPS the delta. So
 * a schema tightened past what core-api serves loses real speculation updates
 * silently, and the acceptance cases here matter more than the refusal.
 *
 * The frame is the `/v1/speculations` list row minus `closing`, and it decodes
 * through the SAME schema — which is what makes the equality checkable rather
 * than asserted.
 */
describe('speculations.subscribe frame decode', () => {
  const enc = new TextEncoder();

  function streamingClient(snapshotRows: unknown[]): {
    client: OspexClient;
    push: (s: string) => void;
    connected: () => boolean;
  } {
    let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.includes('/v1/stream/speculations')) {
        const stream = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
        init?.signal?.addEventListener(
          'abort',
          () => {
            try {
              ctrl?.error(new Error('aborted'));
            } catch {
              /* already torn down */
            }
          },
          { once: true },
        );
        return { ok: true, status: 200, body: stream, async json() {} } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return listBody(snapshotRows);
        },
      } as unknown as Response;
    };
    const client = new OspexClient({
      apiUrl: 'http://test.local',
      fetch: fetchImpl as unknown as typeof fetch,
    });
    return {
      client,
      connected: () => ctrl !== undefined,
      push: (s) => {
        try {
          ctrl?.enqueue(enc.encode(s));
        } catch {
          /* already torn down */
        }
      },
    };
  }

  /**
   * Wait for a stated condition rather than for a fixed number of turns.
   *
   * A `for (…) await Promise.resolve()` settle is a race: lose it and the
   * frame simply has not arrived yet, which reads as the decode failing.
   * Worse, it makes the pushes below unordered with respect to the SSE
   * connection — `subscribe()` resolves before the transport's connect loop
   * has called `fetch`, so a push issued too early is enqueued into nothing
   * and silently lost. Each step here asserts the thing it is waiting for
   * actually happened, and fails loudly with a label if it does not.
   */
  async function waitFor(pred: () => boolean, label: string, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it('decodes a delta frame, and skips (not tears down) a malformed one', async () => {
    const { client, push, connected } = streamingClient([]);
    const deltas: unknown[] = [];
    const errors: unknown[] = [];
    const sub = await client.speculations.subscribe(
      {},
      {
        onSnapshot: () => {},
        onDelta: (row) => deltas.push(row),
        onError: (e) => errors.push(e),
      },
    );
    await waitFor(connected, 'the SSE connection to open');

    // A frame carrying `closing` — the one key the list row has and the
    // stream frame does not — decodes and the extra block is stripped.
    push(
      `event: delta\ndata: ${JSON.stringify({
        ...speculationRowWire,
        closing: { awayDecimal: 1.9, homeDecimal: 2.1, line: -3.5, estimated: false },
      })}\n\n`,
    );
    await waitFor(() => deltas.length === 1, 'the first delta to arrive');

    // A malformed frame: skipped with an onError, the subscription survives.
    push(`event: delta\ndata: ${JSON.stringify({ ...speculationRowWire, lineTicks: 'x' })}\n\n`);
    await waitFor(() => errors.length === 1, 'the malformed frame to be reported and skipped');

    // And the stream keeps delivering afterwards, which is the property the
    // skip-don't-tear-down contract actually promises.
    push(
      `event: delta\ndata: ${JSON.stringify({ ...speculationRowWire, speculationId: 'after' })}\n\n`,
    );
    await waitFor(() => deltas.length === 2, 'the stream to keep delivering after the skip');
    sub.unsubscribe();

    expect(deltas).toHaveLength(2);
    expect((deltas[0] as { speculationId: string }).speculationId).toBe('sid-speculationId');
    expect(deltas[0]).not.toHaveProperty('closing');
    expect((deltas[1] as { speculationId: string }).speculationId).toBe('after');
    expect(errors).toHaveLength(1);
  });

  it('decodes a frame with the settlement trio absent — the pre-#41 tolerance, on the stream', async () => {
    const { client, push, connected } = streamingClient([]);
    const deltas: unknown[] = [];
    const sub = await client.speculations.subscribe(
      {},
      { onSnapshot: () => {}, onDelta: (row) => deltas.push(row), onError: () => {} },
    );
    await waitFor(connected, 'the SSE connection to open');
    push(
      `event: delta\ndata: ${JSON.stringify({
        speculationId: '9',
        contestId: '1',
        type: 'moneyline',
        lineTicks: 0,
        line: null,
        speculationStatus: 0,
      })}\n\n`,
    );
    await waitFor(() => deltas.length === 1, 'the delta to arrive');
    sub.unsubscribe();

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ speculationId: '9', winSide: null, voided: false });
  });
});
