import { describe, expect, it } from 'vitest';
import {
  contestToUpdate,
  decodeContestUpdate,
  decodeFill,
  decodePositionDelta,
} from '../src/realtime/decoders.js';
import { OspexValidationError } from '../src/index.js';
import type { Contest } from '../src/types/contest.js';
import {
  CONTEST_INPUT_FIELDS,
  CONTEST_START_TIME_FIELDS,
  CONTEST_START_TIME_MATRIX,
  expectContestStartTimeInputsDistinct,
  expectMatrixSeparatesEveryPair,
  expectUnlinkedGameStartTimes,
  expectWireValidContestStartTimes,
} from './fixtures/start-times.js';

/**
 * The start-time fixtures are the shared matrix from
 * `tests/fixtures/start-times.ts`; the guards run on them here so a row
 * edited into a body core-api cannot serve reddens in this file too.
 *
 * The stream carries the whole matrix — the contests stream resource has no
 * `start_time IS NOT NULL` predicate, so the pre-verification row (a `""`
 * chainStartTime beside real game-derived values) reaches a subscriber.
 *
 * Both guards are call sites, not structural properties of this file:
 * re-sharing a literal inside a guarded fixture reddens, deleting the CALL
 * along with the literal does not.
 */

describe('decodePositionDelta', () => {
  it('maps the recovery body to a Position carrying userAddress + claimedAt', () => {
    const body = {
      speculationId: '7',
      userAddress: '0xabc',
      positionType: 1 as const,
      riskAmountUSDC: 10,
      profitAmountUSDC: 5,
      claimed: true,
      positionCreatedAt: 't0',
      claimedAt: 't1',
    };
    expect(decodePositionDelta(body)).toEqual({
      speculationId: '7',
      positionType: 1,
      riskAmountUSDC: 10,
      profitAmountUSDC: 5,
      claimed: true,
      positionCreatedAt: 't0',
      userAddress: '0xabc',
      claimedAt: 't1',
    });
  });
});

describe('decodeContestUpdate', () => {
  it('copies the lifecycle slice and drops extra fields (speculations / enrichment)', () => {
    const body = {
      contestId: '1',
      awayTeam: 'A',
      homeTeam: 'H',
      sport: 'nba',
      sportId: 1,
      matchTime: 't',
      status: 'scored',
      awayScore: 100,
      homeScore: 99,
      verifiedAt: 'v',
      scoredAt: 's',
      voidedAt: null,
      contestCreatedAt: 'c',
      speculations: [{}],
      jsonoddsId: 'x',
    };
    const out = decodeContestUpdate(body);
    expect(out).toEqual({
      contestId: '1',
      awayTeam: 'A',
      homeTeam: 'H',
      sport: 'nba',
      sportId: 1,
      matchTime: 't',
      status: 'scored',
      awayScore: 100,
      homeScore: 99,
      verifiedAt: 'v',
      scoredAt: 's',
      voidedAt: null,
      contestCreatedAt: 'c',
    });
    expect(out).not.toHaveProperty('speculations');
    expect(out).not.toHaveProperty('jsonoddsId');
    // Negative control: this body predates the start-time companions —
    // the keys must stay absent on the decoded update, not undefined-assigned.
    // Driven by the module's `CONTEST_INPUT_FIELDS`, which is pinned against a
    // literal in `start-time-fixtures.test.ts`, so dropping an entry reddens
    // there instead of quietly un-checking a key here.
    for (const field of CONTEST_INPUT_FIELDS) {
      expect(out, `decodeContestUpdate additivity: ${field}`).not.toHaveProperty(field);
    }
  });

  for (const { id, served } of CONTEST_START_TIME_MATRIX) {
    it(`copies the start-time companion fields verbatim (${id})`, () => {
      expectWireValidContestStartTimes(served, `decodeContestUpdate ${id}`);
      expectContestStartTimeInputsDistinct(served, `decodeContestUpdate ${id}`);
      if (id === 'unlinked') {
        // Paired with the populated rows: a decoder broken to always emit ""
        // fails those, one broken to drop "" fails this one.
        expectUnlinkedGameStartTimes(served, 'decodeContestUpdate unlinked');
      }
      const out = decodeContestUpdate({
        contestId: '1',
        awayTeam: 'A',
        homeTeam: 'H',
        sport: 'nba',
        sportId: 1,
        ...served,
        status: 'verified',
        awayScore: null,
        homeScore: null,
        verifiedAt: 'v',
        scoredAt: null,
        voidedAt: null,
        contestCreatedAt: 'c',
      });
      for (const field of CONTEST_START_TIME_FIELDS) {
        expect(out[field], `${id}.${field}`).toBe(served[field]);
      }
    });
  }

  it('the decoded matrix separates every start-time pair somewhere', () => {
    expectMatrixSeparatesEveryPair(
      CONTEST_START_TIME_MATRIX.map((c) => c.served),
      CONTEST_START_TIME_FIELDS,
      'decodeContestUpdate matrix',
    );
  });
});

describe('decodeFill', () => {
  it('maps the 16-field fill body 1:1', () => {
    const body = {
      speculationId: '7',
      contestId: '1',
      commitmentHash: '0xhash',
      maker: '0xm',
      taker: '0xt',
      makerPositionType: 0 as const,
      takerPositionType: 1 as const,
      makerRiskAmount: '100',
      takerRiskAmount: '200',
      makerRiskUSDC: 0.0001,
      takerRiskUSDC: 0.0002,
      oddsTick: 220,
      filledAt: 't',
      contestStarted: false,
      txHash: '0xtx',
      logIndex: 3,
    };
    expect(decodeFill(body)).toEqual(body);
  });
});

describe('contestToUpdate', () => {
  it('projects a rich Contest to the lifecycle slice, coercing absent fields to null', () => {
    const contest: Contest = {
      contestId: '1',
      awayTeam: 'A',
      homeTeam: 'H',
      sport: 'nba',
      sportId: 1,
      matchTime: 't',
      status: 'unverified',
      speculations: [],
    };
    expect(contestToUpdate(contest)).toEqual({
      contestId: '1',
      awayTeam: 'A',
      homeTeam: 'H',
      sport: 'nba',
      sportId: 1,
      matchTime: 't',
      status: 'unverified',
      awayScore: null,
      homeScore: null,
      verifiedAt: null,
      scoredAt: null,
      voidedAt: null,
      contestCreatedAt: null,
    });
  });

  it('keeps detail lifecycle fields when present', () => {
    const contest: Contest = {
      contestId: '1',
      awayTeam: 'A',
      homeTeam: 'H',
      sport: 'nba',
      sportId: 1,
      matchTime: 't',
      status: 'scored',
      speculations: [],
      awayScore: 100,
      homeScore: 99,
      scoredAt: 's',
    };
    const out = contestToUpdate(contest);
    expect(out.awayScore).toBe(100);
    expect(out.scoredAt).toBe('s');
    expect(out.verifiedAt).toBeNull();
    // Negative control: absent start-time companions on the Contest stay
    // absent on the projection — never null-coerced like the lifecycle
    // fields, so the snapshot row matches a same-build stream body. Same
    // consumer rule: `CONTEST_INPUT_FIELDS` is pinned against a literal in
    // `start-time-fixtures.test.ts`.
    for (const field of CONTEST_INPUT_FIELDS) {
      expect(out, `contestToUpdate additivity: ${field}`).not.toHaveProperty(field);
    }
  });

  for (const { id, served } of CONTEST_START_TIME_MATRIX) {
    it(`carries the start-time companion fields through the projection (${id})`, () => {
      expectWireValidContestStartTimes(served, `contestToUpdate ${id}`);
      expectContestStartTimeInputsDistinct(served, `contestToUpdate ${id}`);
      if (id === 'unlinked') {
        // Paired with the populated rows, so neither direction passes on a
        // projection broken to always emit one shape.
        expectUnlinkedGameStartTimes(served, 'contestToUpdate unlinked');
      }
      const contest: Contest = {
        contestId: '1',
        awayTeam: 'A',
        homeTeam: 'H',
        sport: 'nba',
        sportId: 1,
        ...served,
        status: 'verified',
        speculations: [],
      };
      const out = contestToUpdate(contest);
      for (const field of CONTEST_START_TIME_FIELDS) {
        expect(out[field], `${id}.${field}`).toBe(served[field]);
      }
    });
  }

  it('the projected matrix separates every start-time pair somewhere', () => {
    expectMatrixSeparatesEveryPair(
      CONTEST_START_TIME_MATRIX.map((c) => c.served),
      CONTEST_START_TIME_FIELDS,
      'contestToUpdate matrix',
    );
  });
});

/* ------------------------------------------------------------------ */
/* The stream decode boundary (sdk#207)                                */
/* ------------------------------------------------------------------ */

/**
 * `decodePositionDelta` and `decodeContestUpdate` validate through
 * `parseWire` now. A refusal here is NOT loud: the stream runner catches it,
 * emits `connection_failed`, and skips the frame — so a schema tightened past
 * what core-api serves loses real deltas silently for any consumer not
 * listening on `onError`. That is why the acceptance cases below outnumber
 * the refusals, and why each names the specific wrong schema it rules out.
 */
describe('decodePositionDelta — wire boundary', () => {
  const wire = {
    speculationId: '7',
    userAddress: '0xabc',
    positionType: 1 as const,
    riskAmountUSDC: 10,
    profitAmountUSDC: 5,
    claimed: true,
    positionCreatedAt: 't0',
    claimedAt: 't1',
  };

  for (const [field, bad] of [
    ['speculationId', 7],
    ['userAddress', 7],
    ['riskAmountUSDC', '10'],
    ['claimed', 'yes'],
    ['positionCreatedAt', 7],
  ] as const) {
    it(`REFUSES a mistyped ${field}, naming it`, () => {
      const err = ((): unknown => {
        try {
          decodePositionDelta({ ...wire, [field]: bad });
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(OspexValidationError);
      expect((err as OspexValidationError).field).toBe(field);
    });
  }

  it('REFUSES a body missing a required key — the one behavioural tightening', () => {
    // Previously an absent key became an own property holding `undefined` and
    // flowed into the public `Position`. This is the change consumers see.
    const { claimed: _dropped, ...partial } = wire;
    expect(() => decodePositionDelta(partial)).toThrow(OspexValidationError);
  });

  // A number is refused by `z.string()` and by `z.string().nullable()` alike,
  // so the mistyped cases above cannot tell a nullable field from a
  // non-nullable one. These can.
  for (const field of ['speculationId', 'userAddress', 'riskAmountUSDC', 'claimed'] as const) {
    it(`REFUSES a null ${field}`, () => {
      const err = ((): unknown => {
        try {
          decodePositionDelta({ ...wire, [field]: null });
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err, `${field} accepted a null`).toBeInstanceOf(OspexValidationError);
      expect((err as OspexValidationError).field).toBe(field);
    });
  }

  it('ACCEPTS a null positionType — the serializer has a branch that emits it', () => {
    // Negative control for dropping `.nullable()`. The column is NOT NULL
    // today so this is unreachable in production, but the public `Position`
    // declares `0 | 1 | null` and the cost of guessing wrong is a dropped
    // delta rather than an error anyone sees.
    expect(decodePositionDelta({ ...wire, positionType: null }).positionType).toBeNull();
  });

  it('ACCEPTS null timestamps and an empty userAddress', () => {
    // No `.min(1)` and no `.nonnegative()`: both would hold against today's
    // rows and both would only add a way to drop a frame.
    const out = decodePositionDelta({
      ...wire,
      userAddress: '',
      positionCreatedAt: null,
      claimedAt: null,
      profitAmountUSDC: -3,
    });
    expect(out.claimedAt).toBeNull();
    expect(out.userAddress).toBe('');
  });

  it('STRIPS an unknown server field rather than refusing it', () => {
    const out = decodePositionDelta({ ...wire, somethingNew: 1 });
    expect(out).not.toHaveProperty('somethingNew');
    expect(out.speculationId).toBe('7');
  });
});

describe('decodeContestUpdate — wire boundary', () => {
  const wire = {
    contestId: '1',
    awayTeam: 'STL',
    homeTeam: 'SD',
    sport: 'mlb',
    sportId: 3,
    matchTime: '2026-05-08T23:40:00+00:00',
    status: 'verified',
    awayScore: null,
    homeScore: null,
    verifiedAt: null,
    scoredAt: null,
    voidedAt: null,
    contestCreatedAt: null,
  };

  for (const [field, bad] of [
    ['contestId', 1],
    ['awayTeam', 1],
    ['sportId', '3'],
    ['status', 1],
    ['awayScore', '0'],
    ['verifiedAt', 1],
  ] as const) {
    it(`REFUSES a mistyped ${field}, naming it`, () => {
      const err = ((): unknown => {
        try {
          decodeContestUpdate({ ...wire, [field]: bad });
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(OspexValidationError);
      expect((err as OspexValidationError).field).toBe(field);
    });
  }

  // Same reason as the position deltas: the mistyped-number cases above do not
  // discriminate the nullability axis, and `""` does not either — a widened
  // `.nullable()` accepts every one of them.
  for (const field of ['contestId', 'awayTeam', 'sport', 'sportId', 'matchTime', 'status'] as const) {
    it(`REFUSES a null ${field}`, () => {
      const err = ((): unknown => {
        try {
          decodeContestUpdate({ ...wire, [field]: null });
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err, `${field} accepted a null`).toBeInstanceOf(OspexValidationError);
      expect((err as OspexValidationError).field).toBe(field);
    });
  }

  it('ACCEPTS a null on the four lifecycle timestamps and both scores', () => {
    // The control for the loop above: a schema broken to refuse every null
    // would pass all six of those and fail this one.
    const out = decodeContestUpdate(wire);
    expect(out.verifiedAt).toBeNull();
    expect(out.awayScore).toBeNull();
  });

  it('ACCEPTS "" on EVERY string, including matchTime', () => {
    // The negative control for copying `FillSchema`'s `.min(1)` habit onto
    // this surface. `""` is core-api's own encoding of "not verified yet" /
    // "no games row linked", minted by its `?? ''` coalescing.
    //
    // `matchTime: ""` specifically is NOT in `CONTEST_START_TIME_MATRIX`,
    // which every other case here reuses: the matrix rows all carry a
    // non-empty matchTime. It is reachable on the STREAM because the list
    // endpoint filters those contests out and the stream does not — so
    // without this line, a `.min(1)` on matchTime would ship green.
    const out = decodeContestUpdate({
      ...wire,
      contestId: '1',
      awayTeam: '',
      homeTeam: '',
      sport: '',
      matchTime: '',
      status: '',
      chainStartTime: '',
      gameMatchTime: '',
      gameEarliestMatchTime: '',
      gameRundownMatchTime: '',
      gameSportspageMatchTime: '',
    });
    expect(out.matchTime).toBe('');
    expect(out.chainStartTime).toBe('');
    expect(out.sport).toBe('');
  });

  it('ACCEPTS the PostgREST +00:00 microsecond timestamp', () => {
    // `.datetime()` on this field would refuse every row core-api serves.
    const out = decodeContestUpdate({ ...wire, matchTime: '2026-05-08T23:40:00.123456+00:00' });
    expect(out.matchTime).toBe('2026-05-08T23:40:00.123456+00:00');
  });

  it('leaves the five companions ABSENT when the server omits them', () => {
    // Not merely "undefined": an older core-api omits the keys, and a
    // present-but-undefined key would stop a delta row and a projected
    // snapshot row from the same build comparing equal.
    const out = decodeContestUpdate(wire);
    for (const field of [
      'chainStartTime',
      'gameMatchTime',
      'gameEarliestMatchTime',
      'gameRundownMatchTime',
      'gameSportspageMatchTime',
    ]) {
      expect(out, `omitted companion ${field}`).not.toHaveProperty(field);
    }
  });
});
