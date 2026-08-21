/**
 * API client tests with a mocked fetch. We don't open real sockets —
 * each test installs a fetch stub that returns a canned Response, then
 * asserts the URL/method/body the SDK constructed and that the response
 * is decoded into the public types.
 */

import { describe, expect, it } from 'vitest';
import { OspexAPIError, OspexClient, OspexValidationError } from '../src/index.js';

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function makeFetch(
  responder: (req: CapturedRequest) => { status: number; body: unknown },
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ url, init });
    const { status, body } = responder({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch: fetchImpl, calls };
}

const apiUrl = 'https://api.example.test';

/**
 * Fixture guards for the start-time family. There are two, because the wire
 * has two shapes: a contest with a linked games row carries independent
 * values, and one with no linkage carries the `""` sentinel in every
 * game-derived field.
 *
 * `expectDistinctStartTimes` — where the values are independent they must all
 * differ, or a swap between two same-typed fields in a mapper is invisible to
 * the assertions that follow. Measured before this helper existed:
 * `chainStartTime` and `gameMatchTime` shared one literal in the contest
 * fixtures, and swapping those two assignments in `toContest`, `toContext`,
 * `decodeContestUpdate` and `contestToUpdate` left the whole suite green in
 * all four places. Sentinels (`''` / `null`) are excluded — they are
 * legitimately repeated across fields and carry no positional information.
 *
 * `expectUnlinkedGameStartTimes` — the no-games-row fixtures cannot satisfy
 * that rule, and should not be edited until they do. With no linkage,
 * core-api's served bound is a `LEAST(...)` over a NULL join side, so
 * `matchTime` and `chainStartTime` come out equal there; forcing them apart
 * would buy distinctness with a body that view does not produce. This guard
 * pins the shape that makes the exemption legitimate instead — every
 * game-derived companion is the `""` sentinel, leaving no independent pair
 * for distinctness to discriminate.
 *
 * Bound worth stating, because it is narrower than it looks: these are call
 * sites, not a structural property of the file. Re-sharing a literal inside a
 * guarded fixture reddens (measured); deleting the CALL along with the
 * literal does not.
 */
function expectDistinctStartTimes(values: Array<string | null | undefined>): void {
  const real = values.filter((v): v is string => typeof v === 'string' && v !== '');
  expect(new Set(real).size).toBe(real.length);
}

function expectUnlinkedGameStartTimes(fixture: {
  gameMatchTime: string;
  gameEarliestMatchTime: string;
  gameRundownMatchTime: string;
  gameSportspageMatchTime: string;
}): void {
  expect([
    fixture.gameMatchTime,
    fixture.gameEarliestMatchTime,
    fixture.gameRundownMatchTime,
    fixture.gameSportspageMatchTime,
  ]).toEqual(['', '', '', '']);
}

describe('OspexClient API surface', () => {
  it('contests.list builds the right URL and decodes the response', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        contests: [
          {
            contestId: '42',
            awayTeam: 'Lakers',
            homeTeam: 'Celtics',
            sport: 'nba',
            sportId: 1,
            matchTime: '2026-05-03T00:00:00Z',
            status: 'verified',
            speculations: [
              {
                speculationId: '101',
                contestId: '42',
                type: 'spread',
                lineTicks: -35,
                line: -3.5,
                awayLine: 3.5,
                homeLine: -3.5,
                speculationStatus: 0,
                winSide: null,
                settledAt: null,
                voided: false,
              },
            ],
          },
        ],
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const contests = await client.contests.list({ sport: 'nba', hours: 12 });
    expect(contests).toHaveLength(1);
    const first = contests[0]!;
    expect(first.contestId).toBe('42');
    expect(first.speculations[0]!.awayLine).toBe(3.5);
    expect(first.speculations[0]!.contestId).toBe('42');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/contests');
    expect(url.searchParams.get('sport')).toBe('nba');
    expect(url.searchParams.get('window')).toBe('12');
  });

  it('contests.get hits the path-parameter endpoint and surfaces jsonoddsId', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        contestId: '42',
        jsonoddsId: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
        awayTeam: 'A',
        homeTeam: 'B',
        sport: 'nba',
        sportId: 1,
        matchTime: '2026-05-03T00:00:00Z',
        status: 'verified',
        speculations: [],
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const contest = await client.contests.get('42');
    expect(calls[0]!.url).toBe(`${apiUrl}/v1/contests/42`);
    expect(contest.jsonoddsId).toBe('a783e37e-4ce1-4f42-9dd6-615568f73044');
    // Scope pin: gameId is a LIST-row key — the detail body never carries
    // it (pinned server-side too), and the mapper must not mint it from
    // jsonoddsId. Without this, a toContest mutant deriving gameId on
    // detail reads passes every suite.
    expect(contest).not.toHaveProperty('gameId');
  });

  it('contests.list leaves the game identity keys ABSENT when the server omits them (older core-api)', async () => {
    // Until the game-identity change this test pinned the OPPOSITE
    // contract ("list rows do not surface jsonoddsId — detail-only");
    // list rows now carry gameId + jsonoddsId. What survives is the
    // additivity control: an older server's rows decode with no
    // identity own-keys minted, absent stays absent.
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        contests: [
          {
            contestId: '1',
            awayTeam: 'A',
            homeTeam: 'B',
            sport: 'nba',
            sportId: 1,
            matchTime: '2026-05-03T00:00:00Z',
            status: 'verified',
            speculations: [],
          },
        ],
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const [first] = await client.contests.list();
    expect(first).not.toHaveProperty('gameId');
    expect(first).not.toHaveProperty('jsonoddsId');
  });

  it('contests copy the start-time companion fields verbatim, including "" sentinels', async () => {
    // This one runs on the LIST path, which decodes through the zod boundary
    // in `api/contests.ts`. That schema end fails silently — a field on the
    // types + copy site but missing from the schema is stripped at runtime
    // with nothing to compile against — so this test is what pins it. The
    // detail path (`contests.get`) is an unvalidated cast+copy and cannot.
    //
    // Every value below is distinct, so each assertion can only pass if the
    // mapper copied THAT field — see `expectDistinctStartTimes`.
    const served = {
      matchTime: '2026-05-02T23:15:00Z',
      chainStartTime: '2026-05-03T00:00:00Z',
      gameMatchTime: '2026-05-03T00:05:00Z',
      gameEarliestMatchTime: '2026-05-02T23:30:00Z',
      gameRundownMatchTime: '2026-05-03T00:10:00Z',
      gameSportspageMatchTime: '2026-05-03T00:20:00Z',
    };
    expectDistinctStartTimes(Object.values(served));
    // Unverified + no games row → the server's "" sentinels must survive
    // verbatim (not dropped, not nulled). The two provider snapshots use the
    // same "" sentinel on contest surfaces, even though `/v1/games` serves
    // them nullable. Guarded by shape rather than by distinctness — see
    // `expectUnlinkedGameStartTimes`.
    const unlinked = {
      matchTime: '2026-05-04T00:00:00Z',
      chainStartTime: '',
      gameMatchTime: '',
      gameEarliestMatchTime: '',
      gameRundownMatchTime: '',
      gameSportspageMatchTime: '',
    };
    expectUnlinkedGameStartTimes(unlinked);
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        contests: [
          {
            contestId: '1',
            awayTeam: 'A',
            homeTeam: 'B',
            sport: 'nba',
            sportId: 1,
            ...served,
            status: 'verified',
            speculations: [],
          },
          {
            contestId: '2',
            awayTeam: 'C',
            homeTeam: 'D',
            sport: 'nba',
            sportId: 1,
            ...unlinked,
            status: 'unverified',
            speculations: [],
          },
        ],
        pagination: { limit: 100, offset: 0, total: 2, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const [first, second] = await client.contests.list();
    expect(first?.matchTime).toBe(served.matchTime);
    expect(first?.chainStartTime).toBe(served.chainStartTime);
    expect(first?.gameMatchTime).toBe(served.gameMatchTime);
    expect(first?.gameEarliestMatchTime).toBe(served.gameEarliestMatchTime);
    expect(first?.gameRundownMatchTime).toBe(served.gameRundownMatchTime);
    expect(first?.gameSportspageMatchTime).toBe(served.gameSportspageMatchTime);
    expect(second?.chainStartTime).toBe('');
    expect(second?.gameMatchTime).toBe('');
    expect(second?.gameEarliestMatchTime).toBe('');
    expect(second?.gameSportspageMatchTime).toBe('');
    expect(second?.gameRundownMatchTime).toBe('');
  });

  it('contests leave the start-time companion keys ABSENT (not undefined-assigned) when the server omits them', async () => {
    // Negative control for additivity: an older core-api body without the
    // fields decodes exactly as before, with no new own-keys minted.
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        contests: [
          {
            contestId: '1',
            awayTeam: 'A',
            homeTeam: 'B',
            sport: 'nba',
            sportId: 1,
            matchTime: '2026-05-03T00:00:00Z',
            status: 'verified',
            speculations: [],
          },
        ],
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const [first] = await client.contests.list();
    expect(first).not.toHaveProperty('chainStartTime');
    expect(first).not.toHaveProperty('gameMatchTime');
    expect(first).not.toHaveProperty('gameEarliestMatchTime');
    expect(first).not.toHaveProperty('gameRundownMatchTime');
    expect(first).not.toHaveProperty('gameSportspageMatchTime');
  });

  it('contests.list({ date }) sends the date param and no window', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: { contests: [], pagination: { limit: 100, offset: 0, total: 0, hasMore: false } },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    await client.contests.list({ date: '2026-08-14', sport: 'mlb' });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/contests');
    expect(url.searchParams.get('date')).toBe('2026-08-14');
    expect(url.searchParams.get('sport')).toBe('mlb');
    // No hours option → no window param; the API 400s a request naming both.
    expect(url.searchParams.get('window')).toBeNull();
  });

  it('dated contest rows copy gameFinalType verbatim, including the "" sentinel', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        contests: [
          {
            contestId: '1',
            awayTeam: 'Cubs',
            homeTeam: 'Reds',
            sport: 'mlb',
            sportId: 5,
            matchTime: '2026-08-14T18:10:00Z',
            status: 'scored',
            gameFinalType: 'Finished',
            speculations: [],
          },
          {
            contestId: '2',
            awayTeam: 'Mets',
            homeTeam: 'Braves',
            sport: 'mlb',
            sportId: 5,
            matchTime: '2026-08-14T23:10:00Z',
            status: 'verified',
            // No result status reported yet → the "" sentinel must survive
            // verbatim (not dropped, not nulled).
            gameFinalType: '',
            speculations: [],
          },
        ],
        pagination: { limit: 100, offset: 0, total: 2, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const [first, second] = await client.contests.list({ date: '2026-08-14' });
    expect(first?.gameFinalType).toBe('Finished');
    expect(second?.gameFinalType).toBe('');
  });

  it('contests.list rows surface the game identity keys verbatim, including null (no linkage)', async () => {
    // Through the REAL decode path: the zod schema's unknown-key strip
    // means these keys survive only because the schema names them — a
    // schema that forgot them would pass every shape test and silently
    // drop the identity here.
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        contests: [
          {
            contestId: '1',
            awayTeam: 'Cubs',
            homeTeam: 'Reds',
            sport: 'mlb',
            sportId: 5,
            matchTime: '2026-08-14T18:10:00Z',
            status: 'verified',
            gameId: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
            jsonoddsId: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
            speculations: [],
          },
          {
            contestId: '2',
            awayTeam: 'Sox',
            homeTeam: 'Yanks',
            sport: 'mlb',
            sportId: 5,
            matchTime: '2026-08-14T23:10:00Z',
            status: 'verified',
            // Created without a JSONOdds linkage → the server serves both
            // keys as null. null is a VALUE and must survive the copy —
            // an `if (body.gameId)` truthiness bug would drop it.
            gameId: null,
            jsonoddsId: null,
            speculations: [],
          },
        ],
        pagination: { limit: 100, offset: 0, total: 2, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const [first, second] = await client.contests.list();
    expect(first?.gameId).toBe('a783e37e-4ce1-4f42-9dd6-615568f73044');
    expect(first?.jsonoddsId).toBe('a783e37e-4ce1-4f42-9dd6-615568f73044');
    expect(second).toHaveProperty('gameId');
    expect(second).toHaveProperty('jsonoddsId');
    expect(second?.gameId).toBeNull();
    expect(second?.jsonoddsId).toBeNull();
  });

  it('contests leave the gameFinalType key ABSENT when the server omits it (default listings)', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        contests: [
          {
            contestId: '1',
            awayTeam: 'A',
            homeTeam: 'B',
            sport: 'nba',
            sportId: 1,
            matchTime: '2026-05-03T00:00:00Z',
            status: 'verified',
            speculations: [],
          },
        ],
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const [first] = await client.contests.list();
    expect(first).not.toHaveProperty('gameFinalType');
  });

  // ── contests.list wire-schema boundary (zod via parseWire) ────────────
  // A mistyped field must throw the TYPED error, never propagate into the
  // public `Contest` — the concrete hazard was a non-string `gameFinalType`
  // flowing verbatim into the CLI's agent JSON payload.

  function listBodyWith(row: Record<string, unknown>): { status: number; body: unknown } {
    return {
      status: 200,
      body: {
        contests: [
          {
            contestId: '1',
            awayTeam: 'A',
            homeTeam: 'B',
            sport: 'mlb',
            sportId: 5,
            matchTime: '2026-08-14T18:10:00Z',
            status: 'scored',
            speculations: [],
            ...row,
          },
        ],
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      },
    };
  }

  it('contests.list REFUSES a non-string gameFinalType as OspexValidationError, with the field path', async () => {
    const { fetch } = makeFetch(() => listBodyWith({ gameFinalType: 123 }));
    const client = new OspexClient({ apiUrl, fetch });
    const err = await client.contests.list({ date: '2026-08-14' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OspexValidationError);
    expect((err as OspexValidationError).field).toBe('contests.0.gameFinalType');
  });

  // The five start-time companions are `z.string().optional()` on the list
  // row: absent is tolerated (older core-api builds), `""` is the sentinel,
  // and `null` is refused. `null` is the discriminating input rather than a
  // number — `z.string()`, `z.string().nullable()` and `z.any()` all refuse a
  // number, and only the first refuses `null`. Measured before these existed:
  // widening any of the five to `.nullable()` or `z.any()` left the whole
  // suite green, so the KEYS were pinned but their TYPE was not.
  //
  // Worth stating because it is a live coupling: the underlying columns are
  // nullable in the database, and what makes them strings here is a `?? ''`
  // in core-api's contest projections. If that coalesce is ever dropped, this
  // boundary rejects the whole page rather than leaking `null` into a
  // `string`-typed public field — loud, and deliberately so.
  for (const field of [
    'chainStartTime',
    'gameMatchTime',
    'gameEarliestMatchTime',
    'gameRundownMatchTime',
    'gameSportspageMatchTime',
  ] as const) {
    it(`contests.list REFUSES a null ${field}, with the field path`, async () => {
      const { fetch } = makeFetch(() => listBodyWith({ [field]: null }));
      const client = new OspexClient({ apiUrl, fetch });
      const err = await client.contests.list().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OspexValidationError);
      expect((err as OspexValidationError).field).toBe(`contests.0.${field}`);
    });

    it(`contests.list ACCEPTS the "" sentinel on ${field}`, async () => {
      // Negative control for the refusal above: a schema broken to refuse
      // everything would pass the five tests above and fail these five.
      const { fetch } = makeFetch(() => listBodyWith({ [field]: '' }));
      const client = new OspexClient({ apiUrl, fetch });
      const [row] = await client.contests.list();
      expect(row?.[field]).toBe('');
    });
  }

  it('contests.list REFUSES a non-string, non-null gameId', async () => {
    const { fetch } = makeFetch(() => listBodyWith({ gameId: 123 }));
    const client = new OspexClient({ apiUrl, fetch });
    const err = await client.contests.list().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OspexValidationError);
    expect((err as OspexValidationError).field).toBe('contests.0.gameId');
  });

  it('contests.list REFUSES a non-string, non-null jsonoddsId', async () => {
    const { fetch } = makeFetch(() => listBodyWith({ jsonoddsId: 123 }));
    const client = new OspexClient({ apiUrl, fetch });
    const err = await client.contests.list().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OspexValidationError);
    expect((err as OspexValidationError).field).toBe('contests.0.jsonoddsId');
  });

  // ── identity-pair contract (cross-field) ────────────────────────────
  // The two keys are documented as deliberately redundant and EQUAL. The
  // accept set is exactly what real servers emit — both absent (older
  // core-api), both null (no linkage), or the same non-empty string; the
  // three accepting states are already pinned above (the older-server
  // absent-key control, and the verbatim test's equal + both-null rows).
  // Everything else would let two consumers choose different "canonical"
  // identifiers from the same row, so the boundary refuses it.
  const GID = 'a783e37e-4ce1-4f42-9dd6-615568f73044';
  const PAIR_REJECTS: Array<{ name: string; row: Record<string, unknown>; field: string }> = [
    { name: 'only gameId present', row: { gameId: GID }, field: 'contests.0.jsonoddsId' },
    { name: 'only jsonoddsId present', row: { jsonoddsId: GID }, field: 'contests.0.gameId' },
    {
      name: 'unequal non-empty strings',
      row: { gameId: 'id-A', jsonoddsId: 'id-B' },
      field: 'contests.0.gameId',
    },
    {
      name: 'null gameId beside a string jsonoddsId',
      row: { gameId: null, jsonoddsId: GID },
      field: 'contests.0.gameId',
    },
    {
      name: 'string gameId beside a null jsonoddsId',
      row: { gameId: GID, jsonoddsId: null },
      field: 'contests.0.gameId',
    },
    {
      name: 'both empty strings (the server normalizes "" to null; "" here is no known server)',
      row: { gameId: '', jsonoddsId: '' },
      field: 'contests.0.gameId',
    },
  ];
  for (const { name, row, field } of PAIR_REJECTS) {
    it(`identity-pair contract: REFUSES ${name}`, async () => {
      const { fetch } = makeFetch(() => listBodyWith(row));
      const client = new OspexClient({ apiUrl, fetch });
      const err = await client.contests.list().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OspexValidationError);
      expect((err as OspexValidationError).field).toBe(field);
    });
  }

  it('contests.get REFUSES to mint the list-only gameId from an adversarial detail body', async () => {
    // The detail path reuses the shared mapper on an unvalidated cast+copy
    // body — the list-only `gameId` is attached on the list path AFTER the
    // mapper, so even a detail body that carries the key cannot mint it.
    // The fixture value is distinct from jsonoddsId, so this also catches
    // a mapper deriving gameId FROM jsonoddsId. (The absent-input control
    // is the `contests.get ... surfaces jsonoddsId` test above.)
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        contestId: '42',
        gameId: 'UNEXPECTED-DETAIL-VALUE',
        jsonoddsId: 'a783e37e-4ce1-4f42-9dd6-615568f73044',
        awayTeam: 'A',
        homeTeam: 'B',
        sport: 'nba',
        sportId: 1,
        matchTime: '2026-05-03T00:00:00Z',
        status: 'verified',
        speculations: [],
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const contest = await client.contests.get('42');
    expect(contest).not.toHaveProperty('gameId');
    expect(contest.jsonoddsId).toBe('a783e37e-4ce1-4f42-9dd6-615568f73044');
  });

  it('the boundary covers the whole row, not one field — a mistyped speculationStatus is refused too', async () => {
    const { fetch } = makeFetch(() =>
      listBodyWith({
        speculations: [
          {
            speculationId: '9',
            contestId: '1',
            type: 'total',
            lineTicks: 85,
            line: 8.5,
            speculationStatus: 2,
            winSide: null,
            settledAt: null,
            voided: false,
          },
        ],
      }),
    );
    const client = new OspexClient({ apiUrl, fetch });
    await expect(client.contests.list()).rejects.toBeInstanceOf(OspexValidationError);
  });

  it('a non-object list body is a typed error, not a TypeError', async () => {
    const { fetch } = makeFetch(() => ({ status: 200, body: 'nope' }));
    const client = new OspexClient({ apiUrl, fetch });
    await expect(client.contests.list()).rejects.toBeInstanceOf(OspexValidationError);
  });

  it('negative control: the schema keeps the pre-#41 tolerance — a speculation without the settlement trio decodes', async () => {
    // The settlement fields are optional at the boundary because an older
    // core-api omits them; `toSpeculation` degrades to null/false. This pin
    // stops the schema from quietly becoming stricter than the mapper.
    const { fetch } = makeFetch(() =>
      listBodyWith({
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
      }),
    );
    const client = new OspexClient({ apiUrl, fetch });
    const [first] = await client.contests.list();
    expect(first?.speculations[0]?.winSide).toBeNull();
    expect(first?.speculations[0]?.voided).toBe(false);
  });

  it('speculations.list builds /v1/speculations with filters', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        speculations: [
          {
            speculationId: '500',
            contestId: '42',
            type: 'moneyline',
            lineTicks: 0,
            line: null,
            speculationStatus: 0,
            winSide: null,
            settledAt: null,
            voided: false,
          },
        ],
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const specs = await client.speculations.list({ contestId: '42', status: 'open' });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.speculationId).toBe('500');
    expect(specs[0]!.contestId).toBe('42');
    expect(specs[0]!.winSide).toBeNull();
    expect(specs[0]!.speculationStatus).toBe(0);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/speculations');
    expect(url.searchParams.get('contestId')).toBe('42');
    expect(url.searchParams.get('status')).toBe('open');
  });

  it('speculations.get returns orderbook + parent contest context', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        speculationId: '500',
        contestId: '42',
        type: 'moneyline',
        lineTicks: 0,
        line: null,
        speculationStatus: 0,
        winSide: null,
        settledAt: null,
        voided: false,
        orderbook: [],
        contest: {
          contestId: '42',
          awayTeam: 'Lakers',
          homeTeam: 'Celtics',
          sport: 'nba',
          matchTime: '2026-05-03T00:00:00Z',
          status: 'verified',
        },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const detail = await client.speculations.get('500');
    expect(calls[0]!.url).toBe(`${apiUrl}/v1/speculations/500`);
    expect(detail.contest.awayTeam).toBe('Lakers');
    expect(detail.orderbook).toEqual([]);
    expect(detail.winSide).toBeNull();
    expect(detail.settledAt).toBeNull();
  });

  it('speculations.get surfaces the settled outcome (winSide/settledAt/voided) on a closed speculation', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        speculationId: '2',
        contestId: '2',
        type: 'moneyline',
        lineTicks: 0,
        line: null,
        speculationStatus: 1,
        winSide: 'away',
        settledAt: '2026-07-01T04:00:14+00:00',
        voided: false,
        orderbook: [],
        contest: {
          contestId: '2',
          awayTeam: 'Chicago White Sox',
          homeTeam: 'Baltimore Orioles',
          sport: 'mlb',
          matchTime: '2026-06-30T22:35:00Z',
          status: 'scored',
        },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const detail = await client.speculations.get('2');
    expect(detail.speculationStatus).toBe(1);
    expect(detail.winSide).toBe('away');
    expect(detail.settledAt).toBe('2026-07-01T04:00:14+00:00');
    expect(detail.voided).toBe(false);
    // Negative control: this parent-context body predates the start-time
    // companions — the keys must stay absent, not undefined-assigned.
    expect(detail.contest).not.toHaveProperty('chainStartTime');
    expect(detail.contest).not.toHaveProperty('gameMatchTime');
    expect(detail.contest).not.toHaveProperty('gameEarliestMatchTime');
    expect(detail.contest).not.toHaveProperty('gameRundownMatchTime');
    expect(detail.contest).not.toHaveProperty('gameSportspageMatchTime');
  });

  it('speculations.get parent context copies the start-time companion fields verbatim', async () => {
    // Distinct values throughout — a swap between any two of these six in
    // `toContext` has to redden one of the assertions below.
    const servedContext = {
      matchTime: '2026-05-02T23:15:00Z',
      chainStartTime: '2026-05-03T00:00:00Z',
      gameMatchTime: '2026-05-03T00:05:00Z',
      gameEarliestMatchTime: '2026-05-02T23:30:00Z',
      gameRundownMatchTime: '2026-05-03T00:10:00Z',
      gameSportspageMatchTime: '2026-05-03T00:20:00Z',
    };
    expectDistinctStartTimes(Object.values(servedContext));
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        speculationId: '500',
        contestId: '42',
        type: 'moneyline',
        lineTicks: 0,
        line: null,
        speculationStatus: 0,
        winSide: null,
        settledAt: null,
        voided: false,
        orderbook: [],
        contest: {
          contestId: '42',
          awayTeam: 'Lakers',
          homeTeam: 'Celtics',
          sport: 'nba',
          ...servedContext,
          status: 'verified',
        },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const detail = await client.speculations.get('500');
    expect(detail.contest.matchTime).toBe(servedContext.matchTime);
    expect(detail.contest.chainStartTime).toBe(servedContext.chainStartTime);
    expect(detail.contest.gameMatchTime).toBe(servedContext.gameMatchTime);
    expect(detail.contest.gameEarliestMatchTime).toBe(servedContext.gameEarliestMatchTime);
    expect(detail.contest.gameRundownMatchTime).toBe(servedContext.gameRundownMatchTime);
    expect(detail.contest.gameSportspageMatchTime).toBe(servedContext.gameSportspageMatchTime);
  });

  it('speculations.get parent context copies "" provider-snapshot sentinels verbatim', async () => {
    // A verified contest with no games row: core-api coalesces every
    // games-sourced companion to "" on contest surfaces, and the served bound
    // reduces to the chain start. Paired with the test above (real values
    // accepted) so neither direction passes on a mapper broken to always emit
    // one or the other. Shape-guarded, not distinctness-guarded — see
    // `expectUnlinkedGameStartTimes`.
    const unlinkedContext = {
      matchTime: '2026-05-03T00:00:00Z',
      chainStartTime: '2026-05-03T00:00:00Z',
      gameMatchTime: '',
      gameEarliestMatchTime: '',
      gameRundownMatchTime: '',
      gameSportspageMatchTime: '',
    };
    expectUnlinkedGameStartTimes(unlinkedContext);
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        speculationId: '501',
        contestId: '43',
        type: 'moneyline',
        lineTicks: 0,
        line: null,
        speculationStatus: 0,
        winSide: null,
        settledAt: null,
        voided: false,
        orderbook: [],
        contest: {
          contestId: '43',
          awayTeam: 'Lakers',
          homeTeam: 'Celtics',
          sport: 'nba',
          ...unlinkedContext,
          status: 'verified',
        },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const detail = await client.speculations.get('501');
    expect(detail.contest.gameRundownMatchTime).toBe('');
    expect(detail.contest.gameSportspageMatchTime).toBe('');
  });

  it('games.get copies the start-time diagnostics verbatim (null floor is a real value, absent keys stay absent)', async () => {
    const gameBody = {
      gameId: 'g1',
      slug: 'stl-sd-2026-05-08',
      sport: 'mlb',
      matchTime: '2026-05-08T01:00:00Z',
      status: 'upcoming',
      homeTeam: { name: 'San Diego Padres', abbreviation: 'SD' },
      awayTeam: { name: 'St. Louis Cardinals', abbreviation: 'STL' },
      hasOdds: true,
      contestCreated: false,
      contestId: null,
      canCreateContest: true,
      externalIds: { jsonodds: 'g1', sportspage: '336545', rundown: 'rd1' },
    };
    // Served with a raw feed value + a null floor (column unset) + one
    // captured and one uncaptured provider snapshot — every value copied
    // verbatim; null is NOT collapsed into key-absence, and NOT rewritten to
    // the `""` sentinel the contest surfaces use for the same two snapshots.
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        ...gameBody,
        gameMatchTime: '2026-05-08T02:00:00Z',
        earliestMatchTime: null,
        rundownMatchTime: '2026-05-08T02:20:00Z',
        sportspageMatchTime: null,
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const game = await client.games.get('g1');
    expect(game.gameMatchTime).toBe('2026-05-08T02:00:00Z');
    expect(game).toHaveProperty('earliestMatchTime', null);
    expect(game.rundownMatchTime).toBe('2026-05-08T02:20:00Z');
    // `toHaveProperty(k, null)` is the discriminating form here: it needs the
    // key to EXIST and to hold null. A mapper that dropped the key, or one
    // that coalesced null to the contest surfaces' `""`, fails it.
    expect(game).toHaveProperty('sportspageMatchTime', null);

    // The MIRRORED mix, because a null assertion on one snapshot proves
    // nothing about the other: measured, a `?? ''` on the rundown copy alone
    // survived a version of this test that only ever served rundown as a
    // string. Each null here sits beside a non-null sibling in the same
    // response, so a mapper that nulls everything fails too.
    const { fetch: mirroredFetch } = makeFetch(() => ({
      status: 200,
      body: {
        ...gameBody,
        gameMatchTime: '2026-05-08T02:00:00Z',
        earliestMatchTime: null,
        rundownMatchTime: null,
        sportspageMatchTime: '2026-05-08T02:40:00Z',
      },
    }));
    const mirroredClient = new OspexClient({ apiUrl, fetch: mirroredFetch });
    const mirroredGame = await mirroredClient.games.get('g1');
    expect(mirroredGame).toHaveProperty('rundownMatchTime', null);
    expect(mirroredGame.sportspageMatchTime).toBe('2026-05-08T02:40:00Z');

    // A retained (string) floor and both snapshots captured — copied
    // verbatim, not normalised. Distinct values throughout, so a swap
    // between two of the four same-typed diagnostics cannot pass.
    const flooredServed = {
      matchTime: '2026-05-08T00:10:00Z',
      gameMatchTime: '2026-05-08T02:00:00Z',
      earliestMatchTime: '2026-05-08T00:30:00Z',
      rundownMatchTime: '2026-05-08T02:20:00Z',
      sportspageMatchTime: '2026-05-08T02:40:00Z',
    };
    expectDistinctStartTimes(Object.values(flooredServed));
    const { fetch: flooredFetch } = makeFetch(() => ({
      status: 200,
      body: { ...gameBody, ...flooredServed },
    }));
    const flooredClient = new OspexClient({ apiUrl, fetch: flooredFetch });
    const flooredGame = await flooredClient.games.get('g1');
    expect(flooredGame.matchTime).toBe(flooredServed.matchTime);
    expect(flooredGame.gameMatchTime).toBe(flooredServed.gameMatchTime);
    expect(flooredGame.earliestMatchTime).toBe(flooredServed.earliestMatchTime);
    expect(flooredGame.rundownMatchTime).toBe(flooredServed.rundownMatchTime);
    expect(flooredGame.sportspageMatchTime).toBe(flooredServed.sportspageMatchTime);

    // Negative control: an older core-api body without the diagnostics
    // decodes with the keys absent, not undefined-assigned. Distinct from
    // the null case above — `not.toHaveProperty` fails on a present null.
    const { fetch: oldFetch } = makeFetch(() => ({ status: 200, body: gameBody }));
    const oldClient = new OspexClient({ apiUrl, fetch: oldFetch });
    const oldGame = await oldClient.games.get('g1');
    expect(oldGame).not.toHaveProperty('gameMatchTime');
    expect(oldGame).not.toHaveProperty('earliestMatchTime');
    expect(oldGame).not.toHaveProperty('rundownMatchTime');
    expect(oldGame).not.toHaveProperty('sportspageMatchTime');
  });

  it('commitments.list passes the speculationId filter through', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        commitments: [],
        pagination: { limit: 100, offset: 0, total: 0, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    await client.commitments.list({ speculationId: '500' });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('speculationId')).toBe('500');
  });

  it('positions.byAddress validates the address and lowercases it', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        address: '0xabc',
        positions: [],
        totals: { totalCount: 0, totalRiskUSDC: 0, totalProfitUSDC: 0, activeCount: 0 },
        pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    await client.positions.byAddress('0xABCDEFabcdef0123456789ABCDEF0123456789AB');
    expect(calls[0]!.url).toBe(
      `${apiUrl}/v1/positions/0xabcdefabcdef0123456789abcdef0123456789ab`,
    );
  });

  it('positions.byAddress rejects an invalid address', async () => {
    const client = new OspexClient({ apiUrl });
    await expect(client.positions.byAddress('not-an-address')).rejects.toThrow();
  });

  it('positions.status decodes the three-bucket response (active | pendingSettle | claimable)', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        address: '0xabcdefabcdef0123456789abcdef0123456789ab',
        active: [
          {
            positionId: 'a',
            speculationId: '10',
            positionType: 0,
            team: 'A',
            opponent: 'B',
            market: 'moneyline',
            oddsDecimal: 2,
            riskAmountUSDC: 100,
            profitAmountUSDC: 100,
          },
        ],
        pendingSettle: [
          {
            positionId: 'p',
            speculationId: '20',
            positionType: 0,
            team: 'A',
            opponent: 'B',
            market: 'moneyline',
            oddsDecimal: 2,
            riskAmountUSDC: 50,
            profitAmountUSDC: 50,
            result: 'won',
            predictedWinSide: 'away',
            estimatedPayoutUSDC: 100,
            estimatedPayoutWei6: '100000000',
          },
        ],
        claimable: [
          {
            positionId: 'c',
            speculationId: '30',
            positionType: 1,
            team: 'B',
            opponent: 'A',
            market: 'spread',
            oddsDecimal: 1.91,
            riskAmountUSDC: 100,
            profitAmountUSDC: 91,
            result: 'won',
            estimatedPayoutUSDC: 191,
            estimatedPayoutWei6: '191000000',
          },
        ],
        totals: {
          activeCount: 1,
          pendingSettleCount: 1,
          claimableCount: 1,
          estimatedPayoutUSDC: 191,
          estimatedPayoutWei6: '191000000',
          pendingSettlePayoutUSDC: 100,
          pendingSettlePayoutWei6: '100000000',
        },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const status = await client.positions.status('0xABCDEFabcdef0123456789ABCDEF0123456789AB');
    expect(status.active).toHaveLength(1);
    expect(status.pendingSettle).toHaveLength(1);
    expect(status.pendingSettle[0]!.predictedWinSide).toBe('away');
    expect(status.claimable).toHaveLength(1);
    expect(status.totals.pendingSettlePayoutWei6).toBe('100000000');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/positions/0xabcdefabcdef0123456789abcdef0123456789ab/status');
  });

  it('positions.claimParams returns claimable entries with a single-step txParams array', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        address: '0xabcdefabcdef0123456789abcdef0123456789ab',
        positions: [
          {
            positionId: 'pid',
            speculationId: '42',
            description: 'A moneyline — Won (≈ $191.00)',
            bucket: 'claimable',
            result: 'won',
            estimatedPayoutUSDC: 191,
            estimatedPayoutWei6: '191000000',
            txParams: [
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '42', positionType: 0 },
              },
            ],
          },
        ],
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const params = await client.positions.claimParams('0xABCDEFabcdef0123456789ABCDEF0123456789AB');
    expect(params.positions).toHaveLength(1);
    expect(params.positions[0]!.bucket).toBe('claimable');
    expect(params.positions[0]!.txParams).toHaveLength(1);
    expect(params.positions[0]!.txParams[0]!.method).toBe('claimPosition');
  });

  it('positions.claimParams returns pendingSettle entries with a settle+claim txParams array', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        address: '0xabcdefabcdef0123456789abcdef0123456789ab',
        positions: [
          {
            positionId: 'pid',
            speculationId: '99',
            description: 'A moneyline — Won (≈ $50.00, needs settle)',
            bucket: 'pendingSettle',
            result: 'won',
            estimatedPayoutUSDC: 50,
            estimatedPayoutWei6: '50000000',
            txParams: [
              {
                method: 'settleSpeculation',
                target: 'SpeculationModule',
                args: { speculationId: '99' },
              },
              {
                method: 'claimPosition',
                target: 'PositionModule',
                args: { speculationId: '99', positionType: 0 },
              },
            ],
          },
        ],
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const params = await client.positions.claimParams('0xABCDEFabcdef0123456789ABCDEF0123456789AB');
    expect(params.positions).toHaveLength(1);
    expect(params.positions[0]!.bucket).toBe('pendingSettle');
    expect(params.positions[0]!.txParams).toHaveLength(2);
    expect(params.positions[0]!.txParams[0]!.method).toBe('settleSpeculation');
    expect(params.positions[0]!.txParams[0]!.target).toBe('SpeculationModule');
    expect(params.positions[0]!.txParams[1]!.method).toBe('claimPosition');
    expect(params.positions[0]!.txParams[1]!.target).toBe('PositionModule');
  });

  it('commitments.list joins array statuses with commas', async () => {
    const { fetch, calls } = makeFetch(() => ({
      status: 200,
      body: {
        commitments: [],
        pagination: { limit: 100, offset: 0, total: 0, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    await client.commitments.list({ status: ['open', 'partially_filled'], maker: '0x1' });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('status')).toBe('open,partially_filled');
    expect(url.searchParams.get('maker')).toBe('0x1');
  });

  it('non-2xx with an API error envelope throws OspexAPIError with status + apiCode', async () => {
    const { fetch } = makeFetch(() => ({
      status: 404,
      body: { error: 'Contest not found', code: 'NOT_FOUND' },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    await expect(client.contests.get('999')).rejects.toMatchObject({
      name: 'OspexAPIError',
      status: 404,
      apiCode: 'NOT_FOUND',
    });
    await expect(client.contests.get('999')).rejects.toBeInstanceOf(OspexAPIError);
  });

  it('authDomain returns just the domain (M1 surface)', async () => {
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        domain: {
          name: 'Ospex',
          version: '1',
          chainId: 137,
          verifyingContract: '0xabc',
        },
        network: 'polygon',
        actions: {},
        requestFormat: { description: '', endpoints: {}, example: { action: {}, signature: '' } },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const domain = await client.protocol.authDomain();
    expect(domain).toEqual({
      name: 'Ospex',
      version: '1',
      chainId: 137,
      verifyingContract: '0xabc',
    });
  });

});
