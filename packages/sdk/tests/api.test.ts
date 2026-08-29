/**
 * API client tests with a mocked fetch. We don't open real sockets —
 * each test installs a fetch stub that returns a canned Response, then
 * asserts the URL/method/body the SDK constructed and that the response
 * is decoded into the public types.
 */

import { describe, expect, it } from 'vitest';
import { OspexAPIError, OspexClient, OspexValidationError } from '../src/index.js';
import {
  CONTEST_INPUT_FIELDS,
  CONTEST_START_TIME_FIELDS,
  CONTEST_START_TIME_MATRIX,
  GAME_INPUT_FIELDS,
  GAME_START_TIME_FIELDS,
  GAME_START_TIME_MATRIX,
  contestCase,
  expectContestStartTimeInputsDistinct,
  expectGameStartTimeInputsDistinct,
  expectMatrixSeparatesEveryPair,
  expectUnlinkedGameStartTimes,
  expectWireValidContestStartTimes,
  expectWireValidGameStartTimes,
  gameCase,
  listableContestCases,
} from './fixtures/start-times.js';

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
 * The start-time fixtures come from `tests/fixtures/start-times.ts`, which
 * also carries the guards run on them here. Two things worth knowing before
 * editing one:
 *
 *   - `matchTime` is a `LEAST(...)` over the other served fields, so it EQUALS
 *     one of them in every row core-api can produce. A fixture giving all six
 *     fields distinct values asserts a body the view cannot serve.
 *   - which input ties `matchTime` therefore changes per row, and that is the
 *     point: distinctness holds ACROSS the matrix rather than within a row, so
 *     no single pair of fields is shared everywhere.
 *
 * `expectWireValidContestStartTimes` pins the first; the pair-separation check
 * in `start-time-fixtures.test.ts` pins the second. Both are call sites here,
 * not structural properties of this file — re-sharing a literal inside a
 * guarded fixture reddens, deleting the CALL along with the literal does not.
 */

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

  it('contests copy the start-time companion fields verbatim, over the whole listable matrix', async () => {
    // This one runs on the LIST path, which decodes through the zod boundary
    // in `api/contests.ts`. That schema end fails silently — a field on the
    // types + copy site but missing from the schema is stripped at runtime
    // with nothing to compile against — so this test is what pins it. The
    // detail path (`contests.get`) is an unvalidated cast+copy and cannot.
    //
    // Every listable row is served in ONE page, so a mapper that copies the
    // wrong field has to survive all of them. A different input ties
    // `matchTime` in each row, which is what stops the (matchTime, driver)
    // pair from being invisible everywhere at once.
    const cases = listableContestCases();
    for (const { id, served } of cases) {
      expectWireValidContestStartTimes(served, `api list ${id}`);
      expectContestStartTimeInputsDistinct(served, `api list ${id}`);
    }
    expectMatrixSeparatesEveryPair(
      cases.map((c) => c.served),
      CONTEST_START_TIME_FIELDS,
      'api list matrix',
    );
    // The "" sentinels the unlinked row carries must survive verbatim — not
    // dropped, not nulled. The two provider snapshots use the same sentinel
    // on contest surfaces even though `/v1/games` serves them nullable.
    expectUnlinkedGameStartTimes(contestCase('unlinked').served, 'api list unlinked');

    const { fetch } = makeFetch(() => ({
      status: 200,
      body: {
        contests: cases.map(({ served }, index) => ({
          contestId: String(index + 1),
          awayTeam: 'A',
          homeTeam: 'B',
          sport: 'nba',
          sportId: 1,
          ...served,
          status: 'verified',
          speculations: [],
        })),
        pagination: { limit: 100, offset: 0, total: cases.length, hasMore: false },
      },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const rows = await client.contests.list();
    expect(rows).toHaveLength(cases.length);
    rows.forEach((row, index) => {
      const { id, served } = cases[index]!;
      for (const field of CONTEST_START_TIME_FIELDS) {
        expect(row[field], `${id}.${field}`).toBe(served[field]);
      }
    });
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
    // Same consumer rule as the sweeps: `CONTEST_INPUT_FIELDS` is pinned
    // against a literal in `start-time-fixtures.test.ts`, so a dropped entry
    // reddens there rather than silently un-checking a key here.
    for (const field of CONTEST_INPUT_FIELDS) {
      expect(first, `list additivity: ${field}`).not.toHaveProperty(field);
    }
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
  // Driven by the module's list, not a private copy: this is a CONSUMER, and
  // `CONTEST_INPUT_FIELDS` is pinned against a literal enumeration in
  // `start-time-fixtures.test.ts`, so dropping an entry reddens there. The
  // literal belongs in the pin; a second literal here would only shrink in
  // lockstep with it. (Measured before this change: dropping `chainStartTime`
  // or `gameSportspageMatchTime` from the copy that used to sit here took the
  // suite from 1016 to 1014 passing with exit 0.)
  for (const field of CONTEST_INPUT_FIELDS) {
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
  it('covers every identity-pair refusal shape it names', () => {
    // #208: each row is the ONLY assertion for its shape, and dropping one
    // stops refusing that shape with nothing to notice — the suite stays green
    // and only the case count moves, which nothing reads. Pinning the names
    // makes a deletion explicit. The accepting states have their own controls
    // above, so this is the refusing half of an enumerated boundary.
    expect(PAIR_REJECTS.map((r) => r.name)).toEqual([
      'only gameId present',
      'only jsonoddsId present',
      'unequal non-empty strings',
      'null gameId beside a string jsonoddsId',
      'string gameId beside a null jsonoddsId',
      'both empty strings (the server normalizes "" to null; "" here is no known server)',
    ]);
  });

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
    // companions — the keys must stay absent, not undefined-assigned. Driven
    // by the module's `CONTEST_INPUT_FIELDS`, which is pinned against a
    // literal in `start-time-fixtures.test.ts`.
    for (const field of CONTEST_INPUT_FIELDS) {
      expect(detail.contest, `parent-context additivity: ${field}`).not.toHaveProperty(field);
    }
  });

  // The parent-context mapper sees the WHOLE matrix, including the
  // pre-verification row the list endpoint filters out: `speculations.get`
  // has no `start_time IS NOT NULL` predicate, so a contest between
  // CONTEST_CREATED and CONTEST_VERIFIED reaches this surface carrying the
  // "" chainStartTime sentinel beside real game-derived values.
  for (const { id, why, served } of CONTEST_START_TIME_MATRIX) {
    it(`speculations.get parent context copies the start-time companions verbatim (${id})`, async () => {
      expectWireValidContestStartTimes(served, `parent context ${id}`);
      expectContestStartTimeInputsDistinct(served, `parent context ${id}`);
      expect(why).not.toBe('');
      if (id === 'unlinked') {
        expectUnlinkedGameStartTimes(served, 'parent context unlinked');
      }
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
            ...served,
            status: 'verified',
          },
        },
      }));
      const client = new OspexClient({ apiUrl, fetch });
      const detail = await client.speculations.get('500');
      for (const field of CONTEST_START_TIME_FIELDS) {
        expect(detail.contest[field], `${id}.${field}`).toBe(served[field]);
      }
    });
  }

  it('the parent-context matrix separates every start-time pair somewhere', () => {
    // Stated here as well as in `start-time-fixtures.test.ts` because this is
    // the surface whose mapper the separation is protecting: a swap between
    // two same-typed assignments in `toContext` dies in whichever row those
    // two fields differ, and this is what asserts such a row exists.
    expectMatrixSeparatesEveryPair(
      CONTEST_START_TIME_MATRIX.map((c) => c.served),
      CONTEST_START_TIME_FIELDS,
      'parent context matrix',
    );
  });

  // `/v1/games` minimises over a DIFFERENT input set than the contest
  // surfaces: no chain start (a games row precedes any contest), and `null`
  // rather than `""` for an unheld value, because this endpoint passes the
  // column through instead of coalescing it. Applying one surface's rule to
  // the other is the mistake these two matrices exist to keep apart.
  const gameBody = {
    gameId: 'g1',
    slug: 'stl-sd-2026-05-08',
    sport: 'mlb',
    status: 'upcoming',
    homeTeam: { name: 'San Diego Padres', abbreviation: 'SD' },
    awayTeam: { name: 'St. Louis Cardinals', abbreviation: 'STL' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: 'g1', sportspage: '336545', rundown: 'rd1' },
  };

  for (const { id, why, served } of GAME_START_TIME_MATRIX) {
    it(`games.get copies the start-time diagnostics verbatim (${id})`, async () => {
      expectWireValidGameStartTimes(served, `games ${id}`);
      expectGameStartTimeInputsDistinct(served, `games ${id}`);
      expect(why).not.toBe('');
      const { fetch } = makeFetch(() => ({ status: 200, body: { ...gameBody, ...served } }));
      const client = new OspexClient({ apiUrl, fetch });
      const game = await client.games.get('g1');
      for (const field of GAME_START_TIME_FIELDS) {
        // `toHaveProperty(k, v)` is the discriminating form for the nulls: it
        // needs the key to EXIST and to hold the value. A mapper that dropped
        // the key, or one that coalesced null to the contest surfaces' `""`,
        // fails it — `toBe` on an absent key would pass against undefined.
        expect(game, `${id}.${field}`).toHaveProperty(field, served[field]);
      }
    });
  }

  it('the games matrix carries each null beside a non-null sibling, and separates every pair', () => {
    // A null assertion on one snapshot proves nothing about the other:
    // measured, a `?? ''` on the rundown copy alone survived a version of
    // this suite that only ever served rundown as a string. Each snapshot is
    // null in one row and a string in another, in both cases beside a
    // non-null sibling, so neither a null-everything nor a
    // coalesce-everything mapper passes.
    // Consumer of the module's pinned list (`GAME_INPUT_FIELDS`, pinned
    // against a literal in `start-time-fixtures.test.ts`), minus
    // `gameMatchTime`: that input is the raw feed value `/v1/games` always
    // serves — non-nullable in `GameStartTimes` — so it has no null row and
    // asserting one would fail. The other three are the nullable inputs.
    for (const field of GAME_INPUT_FIELDS.filter((f) => f !== 'gameMatchTime')) {
      expect(
        GAME_START_TIME_MATRIX.some((c) => c.served[field] === null),
        `${field} is never null in the matrix`,
      ).toBe(true);
      expect(
        GAME_START_TIME_MATRIX.some((c) => typeof c.served[field] === 'string'),
        `${field} is never a string in the matrix`,
      ).toBe(true);
    }
    expectMatrixSeparatesEveryPair(
      GAME_START_TIME_MATRIX.map((c) => c.served),
      GAME_START_TIME_FIELDS,
      'games matrix',
    );
  });

  it('games.get leaves the start-time diagnostic keys ABSENT when the server omits them', async () => {
    // Negative control: an older core-api body without the diagnostics
    // decodes with the keys absent, not undefined-assigned. Distinct from
    // the null rows above — `not.toHaveProperty` fails on a present null.
    // `matchTime` is the pre-diagnostics raw feed value on such a build.
    const { fetch } = makeFetch(() => ({
      status: 200,
      body: { ...gameBody, matchTime: gameCase('retained-floor-drives').served.gameMatchTime },
    }));
    const client = new OspexClient({ apiUrl, fetch });
    const oldGame = await client.games.get('g1');
    // The games surface's own input list, driven from the module rather than
    // copied: `GAME_INPUT_FIELDS` is pinned against a literal in
    // `start-time-fixtures.test.ts`.
    for (const field of GAME_INPUT_FIELDS) {
      expect(oldGame, `games additivity: ${field}`).not.toHaveProperty(field);
    }
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

/* ------------------------------------------------------------------ */
/* The `/v1/games` wire boundary (sdk#207)                             */
/* ------------------------------------------------------------------ */

/**
 * `games.{list,listAll,get}` decode through `parseWire` now, so a mistyped
 * field fails as a typed `OspexValidationError` instead of landing in a
 * `Game` whose public type declares it a string.
 *
 * The refusals are the easy half. The cases that matter here are the
 * ACCEPTANCES: every one of them is a shape core-api actually serves, and a
 * schema tightened past it takes the whole endpoint down rather than one
 * field. They are written as the negative controls for a specific wrong
 * schema, named in each case, because "it still passes" means nothing unless
 * something plausible would have failed it.
 */
describe('games wire boundary', () => {
  const gameWire = {
    gameId: 'g1',
    slug: 'stl-sd-2026-05-08',
    sport: 'mlb',
    matchTime: '2026-05-08T23:40:00+00:00',
    status: 'upcoming',
    homeTeam: { name: 'San Diego Padres', abbreviation: 'SD' },
    awayTeam: { name: 'St. Louis Cardinals', abbreviation: 'STL' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: 'g1', sportspage: '336545', rundown: 'rd1' },
  };
  const listWire = (games: unknown[], hasMore = false, offset = 0) => ({
    sport: null,
    windowHours: 72,
    availableOnly: true,
    games,
    pagination: { limit: 200, offset, total: games.length + (hasMore ? 1 : 0), hasMore },
  });

  const clientFor = (body: unknown) =>
    new OspexClient({ apiUrl, fetch: makeFetch(() => ({ status: 200, body })).fetch });

  /* ── refusals, with the dotted path ── */

  const MISTYPED: Array<[string, unknown]> = [
    ['gameId', 123],
    ['slug', 123],
    ['sport', 123],
    ['matchTime', 123],
    ['status', 123],
    ['hasOdds', 'yes'],
    ['contestCreated', 'no'],
    ['canCreateContest', 1],
    ['contestId', 7],
  ];

  for (const [field, bad] of MISTYPED) {
    it(`games.get REFUSES a mistyped ${field}, naming it`, async () => {
      const err = await clientFor({ ...gameWire, [field]: bad })
        .games.get('g1')
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(OspexValidationError);
      expect((err as OspexValidationError).field).toBe(field);
    });

    it(`games.list REFUSES a mistyped ${field}, naming the row and the field`, async () => {
      const err = await clientFor(listWire([{ ...gameWire, [field]: bad }]))
        .games.list()
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(OspexValidationError);
      // The row index is what makes this actionable on a 200-row page.
      expect((err as OspexValidationError).field).toBe(`games.0.${field}`);
    });
  }

  it('games.get REFUSES a mistyped NESTED field, naming the path through it', async () => {
    const err = await clientFor({ ...gameWire, homeTeam: { name: 1, abbreviation: 'SD' } })
      .games.get('g1')
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OspexValidationError);
    expect((err as OspexValidationError).field).toBe('homeTeam.name');
  });

  /* ── acceptances: each is the negative control for one wrong schema ── */

  it('ACCEPTS the PostgREST +00:00 microsecond timestamp — `.datetime()` would refuse every row', async () => {
    // zod v3's `.datetime()` defaults to Z-only. Measured against it: this
    // exact string is refused, and so is its fractionless form. PostgREST
    // renders every timestamptz this way, so that one modifier is a total
    // outage on both endpoints.
    const game = await clientFor({
      ...gameWire,
      matchTime: '2026-05-08T23:40:00.123456+00:00',
    }).games.get('g1');
    expect(game.matchTime).toBe('2026-05-08T23:40:00.123456+00:00');
  });

  it('ACCEPTS an unknown sport and status — an enum would fail a whole page on one row', async () => {
    const game = await clientFor({ ...gameWire, sport: 'cricket', status: 'rain-delay' })
      .games.get('g1');
    expect(game.sport).toBe('cricket');
    expect(game.status).toBe('rain-delay');
  });

  it('ACCEPTS "" ids — core-api guards them as values, it does not normalise them away', async () => {
    const game = await clientFor({
      ...gameWire,
      gameId: '',
      slug: '',
      externalIds: { jsonodds: '', sportspage: '', rundown: '' },
    }).games.get('g1');
    expect(game.gameId).toBe('');
    expect(game.externalIds.sportspage).toBe('');
  });

  it('ACCEPTS an extra server block — `.strict()` would refuse it, and core-api sends one', async () => {
    // `probablePitchers` is emitted by core-api and is not declared on
    // `GameBody`; zod's default strip drops it, which is the property that
    // lets a new server field ship without breaking a deployed SDK.
    const game = await clientFor({
      ...gameWire,
      probablePitchers: { home: 'Cease', away: 'Mikolas' },
    }).games.get('g1');
    expect(game.gameId).toBe('g1');
    expect(game).not.toHaveProperty('probablePitchers');
  });

  it('ACCEPTS a non-integer windowHours — the handler validates only finiteness', async () => {
    const games = await clientFor({ ...listWire([gameWire]), windowHours: 1.5 }).games.list();
    expect(games).toHaveLength(1);
  });

  it('ACCEPTS an empty page — `.nonempty()` would refuse an ordinary 200', async () => {
    expect(await clientFor(listWire([])).games.list()).toStrictEqual([]);
  });

  /* ── the strip trap ── */

  it('listAll walks BOTH pages — dropping `hasMore` from the schema loses page 2 silently', async () => {
    // The regression this exists for is not a throw. Omit `hasMore` from the
    // pagination schema and zod STRIPS it: `body.pagination.hasMore` becomes
    // undefined, `!undefined` is true, and listAll returns page one as the
    // whole slate. No error, no type error, a wrong answer — and downstream
    // it turns a real slug into "did not match any upcoming game".
    let call = 0;
    const { fetch } = makeFetch(() => {
      call += 1;
      return call === 1
        ? { status: 200, body: listWire([{ ...gameWire, gameId: 'p1', slug: 'page-one-2026-05-08' }], true, 0) }
        : { status: 200, body: listWire([{ ...gameWire, gameId: 'p2', slug: 'page-two-only-2026-05-08' }], false, 1) };
    });
    // Driven through `resolveGameId`, the public caller of `listAll` and the
    // one that carries the consequence: it matches a slug against the
    // candidate list, so a lost page 2 becomes "no such game".
    const resolved = await new OspexClient({ apiUrl, fetch }).games.resolveGameId(
      'page-two-only-2026-05-08',
    );
    expect(resolved.gameId).toBe('p2');
  });
});

/* ------------------------------------------------------------------ */
/* Nullability — the axis a mistyped-number case cannot reach          */
/* ------------------------------------------------------------------ */

/**
 * A number is refused by `z.string()`, by `z.string().nullable()`, and by
 * `z.string().min(1)` alike, so a mistyped-number case says nothing about
 * whether a field is nullable. `null` is the input that separates them, and
 * it is the one that matters here: a schema widened to `.nullable()` lets a
 * `null` through into a `Game` field the public type declares `string`.
 *
 * Measured before these existed: widening `gameId` to `z.string().nullable()`
 * passed `tsc` AND all 1,096 tests, because the mapper's input was a
 * hand-written interface and the parsed value was cast to it. The input is
 * inferred from the schema now, so that widening is a compile error — and
 * these cases pin the runtime half, per field, in both directions.
 */
describe('games wire boundary — nullability', () => {
  const gameWire = {
    gameId: 'g1',
    slug: 'stl-sd-2026-05-08',
    sport: 'mlb',
    matchTime: '2026-05-08T23:40:00+00:00',
    status: 'upcoming',
    homeTeam: { name: 'San Diego Padres', abbreviation: 'SD' },
    awayTeam: { name: 'St. Louis Cardinals', abbreviation: 'STL' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: 'g1', sportspage: '336545', rundown: 'rd1' },
  };
  const clientFor = (body: unknown) =>
    new OspexClient({ apiUrl, fetch: makeFetch(() => ({ status: 200, body })).fetch });

  /** Every field the wire declares NON-nullable. `null` on any of them is a bug. */
  const NON_NULLABLE = [
    'gameId',
    'slug',
    'sport',
    'matchTime',
    'status',
    'homeTeam',
    'awayTeam',
    'hasOdds',
    'contestCreated',
    'canCreateContest',
    'externalIds',
  ] as const;

  for (const field of NON_NULLABLE) {
    it(`REFUSES a null ${field}`, async () => {
      const err = await clientFor({ ...gameWire, [field]: null })
        .games.get('g1')
        .then(() => null, (e: unknown) => e);
      expect(err, `${field} accepted a null`).toBeInstanceOf(OspexValidationError);
      expect((err as OspexValidationError).field).toBe(field);
    });
  }

  it('REFUSES a null inside a nested object', async () => {
    const err = await clientFor({ ...gameWire, externalIds: { ...gameWire.externalIds, jsonodds: null } })
      .games.get('g1')
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OspexValidationError);
    expect((err as OspexValidationError).field).toBe('externalIds.jsonodds');
  });

  /**
   * The other direction, and it is not symmetry for its own sake: a schema
   * broken to refuse every null would pass all eleven cases above. These are
   * the fields where `null` is a VALUE core-api serves, and refusing one is an
   * outage rather than a caught bug.
   */
  const NULLABLE_WITH_VALUE: Array<[string, (g: Record<string, unknown>) => unknown]> = [
    ['contestId', (g) => g.contestId],
    ['earliestMatchTime', (g) => g.earliestMatchTime],
    ['rundownMatchTime', (g) => g.rundownMatchTime],
    ['sportspageMatchTime', (g) => g.sportspageMatchTime],
  ];

  for (const [field, read] of NULLABLE_WITH_VALUE) {
    it(`ACCEPTS a null ${field}, and keeps it distinct from the key being absent`, async () => {
      // Present-and-null: the key EXISTS and holds null. `toBe(null)` alone
      // would also pass on an absent key reading back as undefined, so the
      // property check is what discriminates.
      const withNull = await clientFor({ ...gameWire, [field]: null }).games.get('g1');
      expect(withNull, `${field} present-and-null`).toHaveProperty(field, null);

      // Absent: `earliestMatchTime` and friends are `.optional()` as well as
      // `.nullable()`, and an older core-api omits them entirely. `contestId`
      // is nullable but REQUIRED, so it is not part of this half.
      if (field === 'contestId') return;
      const { [field]: _omitted, ...withoutKey } = { ...gameWire, [field]: null };
      const absent = await clientFor(withoutKey).games.get('g1');
      expect(absent, `${field} absent`).not.toHaveProperty(field);
    });
  }

  it('ACCEPTS a null externalIds.{sportspage,rundown} — the columns are nullable', async () => {
    const game = await clientFor({
      ...gameWire,
      externalIds: { jsonodds: 'g1', sportspage: null, rundown: null },
    }).games.get('g1');
    expect(game.externalIds.sportspage).toBeNull();
    expect(game.externalIds.rundown).toBeNull();
  });

  it('REFUSES a null on the list wrapper fields, naming the path', async () => {
    const listWire = {
      sport: null,
      windowHours: 72,
      availableOnly: true,
      games: [gameWire],
      pagination: { limit: 200, offset: 0, total: 1, hasMore: false },
    };
    for (const field of ['windowHours', 'availableOnly', 'games'] as const) {
      const err = await clientFor({ ...listWire, [field]: null })
        .games.list()
        .then(() => null, (e: unknown) => e);
      expect(err, `list.${field} accepted a null`).toBeInstanceOf(OspexValidationError);
    }
    // `sport` is the echo of an optional query param and IS nullable — the
    // control that stops the loop above from passing on a refuse-everything
    // schema.
    expect(await clientFor({ ...listWire, sport: null }).games.list()).toHaveLength(1);

    const err = await clientFor({ ...listWire, pagination: { ...listWire.pagination, hasMore: null } })
      .games.list()
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OspexValidationError);
    expect((err as OspexValidationError).field).toBe('pagination.hasMore');
  });
});
