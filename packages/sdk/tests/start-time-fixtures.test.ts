/**
 * The start-time fixture matrices, and the guards that keep them wire-valid.
 *
 * Two jobs, and they are separate on purpose:
 *
 *   1. Run every guard over the real matrices, so a row edited into a body
 *      core-api cannot serve reddens here rather than being asserted about
 *      elsewhere. The defect this file exists to prevent is exactly that — a
 *      fixture that pinned `matchTime` strictly below every served input,
 *      which a `LEAST(...)` cannot produce, with nothing in the suite noticing.
 *
 *   2. Prove each guard can FAIL. A guard installed everywhere and incapable
 *      of failing is not a guard, and the mutation battery cannot tell the
 *      two apart from outside. Each negative control below hands the guard a
 *      row it must refuse, paired with the accepting case above it.
 *
 * Note what these guards are and are not. They check the FIXTURES against
 * core-api's contract; both sides of every comparison come from the fixture,
 * and nothing here exercises the SDK. The SDK assertions live in
 * `api.test.ts` and `stream-decoders.test.ts`, which call the same guards on
 * the same rows.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTEST_START_TIME_FIELDS,
  CONTEST_START_TIME_MATRIX,
  GAME_START_TIME_FIELDS,
  GAME_START_TIME_MATRIX,
  SNAPSHOT_FRESHNESS_MS,
  contestCase,
  expectContestStartTimeInputsDistinct,
  expectFreshSnapshotDrivesMin,
  expectGameStartTimeInputsDistinct,
  expectMatrixSeparatesEveryPair,
  expectStaleGameSnapshotExcluded,
  expectStaleSnapshotExcluded,
  expectUnlinkedGameStartTimes,
  expectWireValidContestStartTimes,
  expectWireValidGameStartTimes,
  gameCase,
  instantMs,
  listableContestCases,
  type ContestStartTimes,
  type GameStartTimes,
} from './fixtures/start-times.js';

/** One minute in ms — the nudge the negative controls use. */
const MINUTE = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

describe('the contest start-time matrix is wire-valid', () => {
  for (const { id, why, served } of CONTEST_START_TIME_MATRIX) {
    it(`${id}: ${why}`, () => {
      expectWireValidContestStartTimes(served, id);
      expectContestStartTimeInputsDistinct(served, id);
    });
  }

  it('covers every one of the five inputs as the driver of the minimum', () => {
    // The matrix's premise: a DIFFERENT input drives the bound in each row,
    // which is what stops any one (matchTime, input) pair from being shared
    // everywhere. Derived from the fixtures rather than written out, so a row
    // retuned until an input no longer drives anywhere reddens here.
    const drivers = new Set<string>();
    for (const { served } of CONTEST_START_TIME_MATRIX) {
      for (const field of CONTEST_START_TIME_FIELDS) {
        if (field === 'matchTime' || served[field] === '') continue;
        if (served[field] === served.matchTime) drivers.add(field);
      }
    }
    expect([...drivers].sort()).toEqual([
      'chainStartTime',
      'gameEarliestMatchTime',
      'gameMatchTime',
      'gameRundownMatchTime',
      'gameSportspageMatchTime',
    ]);
  });

  it('separates every orderable pair of start-time fields somewhere', () => {
    expectMatrixSeparatesEveryPair(
      CONTEST_START_TIME_MATRIX.map((c) => c.served),
      CONTEST_START_TIME_FIELDS,
      'contest matrix',
    );
  });

  it('the listable subset is the rows a real listing can return', () => {
    // `GET /v1/contests` carries `.not('start_time', 'is', null)`, so the
    // pre-verification row reaches detail/stream and never a listing.
    expect(listableContestCases().map((c) => c.id)).not.toContain('unverified-linked');
    expect(listableContestCases().length).toBe(CONTEST_START_TIME_MATRIX.length - 1);
  });

  it('the unlinked row carries the "" sentinel in every game-derived companion', () => {
    const { served } = contestCase('unlinked');
    expectUnlinkedGameStartTimes(served, 'unlinked');
    // And the consequence that makes the row legitimate rather than collapsed:
    // with the games side NULL the LEAST has one member left.
    expect(served.matchTime).toBe(served.chainStartTime);
    expect(served.chainStartTime).not.toBe('');
  });

  it('exercises a stale snapshot and a fresh one, in the same row', () => {
    const { served } = contestCase('stale-rundown-excluded');
    expectStaleSnapshotExcluded(served, 'gameRundownMatchTime', 'stale-rundown-excluded');
    expectFreshSnapshotDrivesMin(served, 'gameSportspageMatchTime', 'stale-rundown-excluded');
    expectFreshSnapshotDrivesMin(
      contestCase('fresh-rundown-drives').served,
      'gameRundownMatchTime',
      'fresh-rundown-drives',
    );
  });
});

describe('the games start-time matrix is wire-valid', () => {
  for (const { id, why, served } of GAME_START_TIME_MATRIX) {
    it(`${id}: ${why}`, () => {
      expectWireValidGameStartTimes(served, id);
      expectGameStartTimeInputsDistinct(served, id);
    });
  }

  it('separates every orderable pair of games start-time fields somewhere', () => {
    expectMatrixSeparatesEveryPair(
      GAME_START_TIME_MATRIX.map((c) => c.served),
      GAME_START_TIME_FIELDS,
      'games matrix',
    );
  });

  it('exercises a stale games-side snapshot', () => {
    expectStaleGameSnapshotExcluded(
      gameCase('stale-rundown-excluded').served,
      'rundownMatchTime',
      'games stale-rundown-excluded',
    );
  });

  it('serves null, not "", for an unheld games-side value', () => {
    // The sentinel asymmetry is the wire's: `/v1/games` passes the column
    // through while the contest projections coalesce it with `?? ''`.
    expect(gameCase('feed-value-drives-sportspage-absent').served.sportspageMatchTime).toBeNull();
    expect(gameCase('fresh-sportspage-drives-rundown-absent').served.rundownMatchTime).toBeNull();
  });
});

// ── negative controls: each guard must be able to refuse ───────────────────

describe('expectWireValidContestStartTimes refuses a body the view cannot serve', () => {
  const base = contestCase('retained-floor-drives').served;

  it('refuses a matchTime one minute below its minimum admitted input', () => {
    const bad: ContestStartTimes = {
      ...base,
      matchTime: iso(instantMs(base.matchTime, 'base') - MINUTE),
    };
    expect(() => expectWireValidContestStartTimes(bad, 'nudged')).toThrow(
      /not the bounded minimum/,
    );
  });

  it('refuses a matchTime one minute above its minimum admitted input', () => {
    // The other direction, because a guard written as `matchTime <= min`
    // would pass the case above and this one is what catches it.
    const bad: ContestStartTimes = {
      ...base,
      matchTime: iso(instantMs(base.matchTime, 'base') + MINUTE),
    };
    expect(() => expectWireValidContestStartTimes(bad, 'nudged')).toThrow(
      /not the bounded minimum/,
    );
  });

  it('refuses the contest fixture this change replaced, values unmodified', () => {
    // Reproduce before fixing: the row exactly as it stood, where giving all
    // six fields their own value put matchTime below every input. The floor
    // is the minimum at 23:30 and the fixture served 23:15.
    const asItStood: ContestStartTimes = {
      matchTime: '2026-05-02T23:15:00Z',
      chainStartTime: '2026-05-03T00:00:00Z',
      gameMatchTime: '2026-05-03T00:05:00Z',
      gameEarliestMatchTime: '2026-05-02T23:30:00Z',
      gameRundownMatchTime: '2026-05-03T00:10:00Z',
      gameSportspageMatchTime: '2026-05-03T00:20:00Z',
    };
    expect(() => expectWireValidContestStartTimes(asItStood, 'the replaced fixture')).toThrow(
      /not the bounded minimum/,
    );
  });

  it('refuses a populated matchTime beside an empty chainStartTime on an unlinked row', () => {
    // The exact shape the reviewer found: no games row, so the LEAST has no
    // members and `effective_start_time ?? ''` is "".
    const bad: ContestStartTimes = {
      matchTime: '2026-05-04T00:00:00Z',
      chainStartTime: '',
      gameMatchTime: '',
      gameEarliestMatchTime: '',
      gameRundownMatchTime: '',
      gameSportspageMatchTime: '',
    };
    expect(() => expectWireValidContestStartTimes(bad, 'unlinked-unverified')).toThrow(
      /effective_start_time is NULL/,
    );
  });

  it('accepts an unlinked row whose matchTime agrees with the chain start', () => {
    expect(() =>
      expectWireValidContestStartTimes(
        {
          matchTime: '2026-05-04T00:00:00Z',
          chainStartTime: '2026-05-04T00:00:00Z',
          gameMatchTime: '',
          gameEarliestMatchTime: '',
          gameRundownMatchTime: '',
          gameSportspageMatchTime: '',
        },
        'unlinked-verified',
      ),
    ).not.toThrow();
  });

  it('admits a snapshot exactly at the freshness edge and excludes one a second earlier', () => {
    // The window is `snapshot >= match_time - interval '1 hour'`, so the edge
    // itself is INSIDE. A fixture an hour and a minute below would satisfy a
    // `>` and a `>=` guard alike and could not tell them apart; these two sit
    // on either side of the exact boundary, which is the only place they
    // disagree.
    const feed = '2026-05-09T12:00:00Z';
    const edge = iso(instantMs(feed, 'feed') - SNAPSHOT_FRESHNESS_MS);
    const admitted: ContestStartTimes = {
      matchTime: edge,
      chainStartTime: '2026-05-09T12:30:00Z',
      gameMatchTime: feed,
      gameEarliestMatchTime: '2026-05-09T11:50:00Z',
      gameRundownMatchTime: edge,
      gameSportspageMatchTime: '2026-05-09T12:20:00Z',
    };
    expect(() => expectWireValidContestStartTimes(admitted, 'edge-admitted')).not.toThrow();

    // One second earlier the snapshot drops out, so the minimum becomes the
    // floor and the same served matchTime is no longer producible.
    const excluded: ContestStartTimes = {
      ...admitted,
      gameRundownMatchTime: iso(instantMs(edge, 'edge') - 1000),
    };
    expect(() => expectWireValidContestStartTimes(excluded, 'edge-excluded')).toThrow(
      /not the bounded minimum/,
    );
  });

  it('ignores a snapshot when there is no games row to measure freshness against', () => {
    // The CASE compares against a NULL `g.match_time` and yields NULL, so a
    // snapshot cannot enter the minimum on an unlinked row even if one were
    // somehow populated.
    expect(() =>
      expectWireValidContestStartTimes(
        {
          matchTime: '2026-05-09T14:00:00Z',
          chainStartTime: '2026-05-09T14:00:00Z',
          gameMatchTime: '',
          gameEarliestMatchTime: '',
          gameRundownMatchTime: '2026-05-09T13:00:00Z',
          gameSportspageMatchTime: '',
        },
        'snapshot-without-games-row',
      ),
    ).not.toThrow();
  });
});

describe('the fixture-hygiene guards refuse a collapsed matrix', () => {
  it('expectContestStartTimeInputsDistinct refuses two inputs sharing a literal', () => {
    const { served } = contestCase('chain-start-drives');
    expect(() =>
      expectContestStartTimeInputsDistinct(
        { ...served, gameMatchTime: served.gameRundownMatchTime },
        'shared',
      ),
    ).toThrow(/share the literal/);
  });

  it('expectContestStartTimeInputsDistinct tolerates repeated "" sentinels', () => {
    // Negative control for the control: sentinels are legitimately repeated
    // across fields and carry no positional information, so a guard that
    // flagged them would fail every unlinked row.
    expect(() =>
      expectContestStartTimeInputsDistinct(contestCase('unlinked').served, 'unlinked'),
    ).not.toThrow();
  });

  it('expectGameStartTimeInputsDistinct refuses two games-side inputs sharing a literal', () => {
    // The games surface's twin had no negative control at all — every call on
    // it asserted acceptance, so a guard broken to never refuse stayed green.
    // Its `null` skip needs no control of its own: the matrix carries rows
    // with two absent snapshots, so a guard that stopped skipping `null` would
    // redden on the per-row loop above.
    const { served } = gameCase('retained-floor-drives');
    expect(() =>
      expectGameStartTimeInputsDistinct(
        { ...served, rundownMatchTime: served.earliestMatchTime },
        'games-shared',
      ),
    ).toThrow(/share the literal/);
  });

  it('expectMatrixSeparatesEveryPair names a pair no row separates', () => {
    // Collapse gameSportspageMatchTime onto gameRundownMatchTime in every
    // row. Done to a copy, so the real matrix is untouched — the point is
    // that the guard sees the collapse, not that the matrix has one.
    const collapsed = CONTEST_START_TIME_MATRIX.map((c) => ({
      ...c.served,
      gameSportspageMatchTime: c.served.gameRundownMatchTime,
    }));
    expect(() =>
      expectMatrixSeparatesEveryPair(collapsed, CONTEST_START_TIME_FIELDS, 'collapsed'),
    ).toThrow(/gameRundownMatchTime \/ gameSportspageMatchTime/);
  });

  it('expectMatrixSeparatesEveryPair refuses a single row, which separates nothing involving matchTime', () => {
    // The reason the matrix exists, stated as an assertion: one wire-valid
    // fixture always ties matchTime to its driver, so a one-row "matrix"
    // leaves that pair unseparated no matter which row it is.
    for (const { id, served } of CONTEST_START_TIME_MATRIX) {
      expect(() =>
        expectMatrixSeparatesEveryPair([served], CONTEST_START_TIME_FIELDS, id),
      ).toThrow(/matchTime \//);
    }
  });

  it('expectUnlinkedGameStartTimes refuses a populated game-derived companion', () => {
    const { served } = contestCase('unlinked');
    expect(() =>
      expectUnlinkedGameStartTimes(
        { ...served, gameEarliestMatchTime: '2026-05-08T01:05:00Z' },
        'populated',
      ),
    ).toThrow(/gameEarliestMatchTime/);
  });
});

describe('the freshness guards refuse the wrong case', () => {
  const stale = contestCase('stale-rundown-excluded').served;

  it('expectStaleSnapshotExcluded refuses a snapshot inside the window', () => {
    expect(() =>
      expectStaleSnapshotExcluded(stale, 'gameSportspageMatchTime', 'fresh-not-stale'),
    ).toThrow(/it is FRESH/);
  });

  it('expectFreshSnapshotDrivesMin refuses a stale snapshot', () => {
    expect(() =>
      expectFreshSnapshotDrivesMin(stale, 'gameRundownMatchTime', 'stale-not-fresh'),
    ).toThrow(/is stale/);
  });

  it('expectFreshSnapshotDrivesMin refuses a fresh snapshot that is not the minimum', () => {
    expect(() =>
      expectFreshSnapshotDrivesMin(
        contestCase('chain-start-drives').served,
        'gameRundownMatchTime',
        'fresh-but-not-driving',
      ),
    ).toThrow(/does not equal the fresh/);
  });

  it('expectStaleSnapshotExcluded refuses a row whose matchTime sits AT the stale snapshot', () => {
    // The guard's second clause, which had no control of its own: a stale
    // snapshot proves nothing about exclusion unless matchTime is strictly
    // above it. Only matchTime moves here, so the snapshot is still stale and
    // the first clause still passes — the refusal can only come from the
    // second. The boundary value is the discriminating one: matchTime EQUAL to
    // the snapshot is refused by `<=` and accepted by `<`, while a matchTime
    // strictly below it is refused by both and cannot separate them.
    const bad: ContestStartTimes = { ...stale, matchTime: stale.gameRundownMatchTime };
    expect(() => expectStaleSnapshotExcluded(bad, 'gameRundownMatchTime', 'stale-tied')).toThrow(
      /at or below the stale/,
    );
  });

  it('expectStaleGameSnapshotExcluded refuses a games-side snapshot inside the window', () => {
    expect(() =>
      expectStaleGameSnapshotExcluded(
        gameCase('fresh-rundown-drives').served,
        'rundownMatchTime',
        'games-fresh-not-stale',
      ),
    ).toThrow(/it is FRESH/);
  });

  it('expectStaleGameSnapshotExcluded refuses a row whose matchTime sits AT the stale snapshot', () => {
    // The games-side twin of the control above, for the same reason and with
    // the same boundary choice.
    const base = gameCase('stale-rundown-excluded').served;
    const staleSnapshot = base.rundownMatchTime;
    // Narrowing that is also an assertion, deliberately not a `??` fallback:
    // if this row's snapshot ever became absent, falling back to `matchTime`
    // would tie the row to itself and the case would pass while exercising
    // nothing.
    if (staleSnapshot === null) {
      throw new Error('fixture regressed: the stale games row must hold a rundown snapshot');
    }
    const bad: GameStartTimes = { ...base, matchTime: staleSnapshot };
    expect(() =>
      expectStaleGameSnapshotExcluded(bad, 'rundownMatchTime', 'games-stale-tied'),
    ).toThrow(/at or below the stale/);
  });

  it('expectStaleGameSnapshotExcluded refuses an absent snapshot rather than ageing a null', () => {
    // Its third clause, also uncontrolled. Deleting it does not make the guard
    // silent — `instantMs` refuses the coerced null — so the assertion is on
    // the message, which is the only thing that tells the two refusals apart.
    expect(() =>
      expectStaleGameSnapshotExcluded(
        gameCase('fresh-sportspage-drives-rundown-absent').served,
        'rundownMatchTime',
        'games-null-snapshot',
      ),
    ).toThrow(/no snapshot to age/);
  });
});

describe('instantMs refuses a rendering it cannot order', () => {
  it.each([
    ['2026-05-03T00:00:00+00:00', 'an offset form'],
    ['2026-05-03T00:00:00.500Z', 'a sub-second value'],
    ['2026-05-03T00:00:00', 'no zone designator'],
    ['2026-02-30T00:00:00Z', 'a day that does not exist'],
  ])('refuses %s (%s)', (value) => {
    expect(() => instantMs(value, 'probe')).toThrow();
  });

  it('accepts the canonical form the matrices use', () => {
    expect(instantMs('2026-05-03T00:00:00Z', 'probe')).toBe(Date.parse('2026-05-03T00:00:00Z'));
  });
});

describe('expectWireValidGameStartTimes refuses a body /v1/games cannot serve', () => {
  const base = gameCase('retained-floor-drives').served;

  it('refuses a matchTime one minute below its minimum admitted input', () => {
    expect(() =>
      expectWireValidGameStartTimes(
        { ...base, matchTime: iso(instantMs(base.matchTime, 'base') - MINUTE) },
        'nudged',
      ),
    ).toThrow(/not the minimum/);
  });

  it('refuses a matchTime that ignores the floor', () => {
    // The reviewer's second instance, in the shape it had: the served
    // matchTime sat below every input rather than equalling the floor.
    expect(() =>
      expectWireValidGameStartTimes(
        {
          matchTime: '2026-05-08T00:10:00Z',
          gameMatchTime: '2026-05-08T02:00:00Z',
          earliestMatchTime: '2026-05-08T00:30:00Z',
          rundownMatchTime: '2026-05-08T02:20:00Z',
          sportspageMatchTime: '2026-05-08T02:40:00Z',
        },
        'below-every-input',
      ),
    ).toThrow(/not the minimum/);
  });

  it('treats null as absent rather than as a value to minimise over', () => {
    expect(() =>
      expectWireValidGameStartTimes(
        {
          matchTime: '2026-05-08T02:00:00Z',
          gameMatchTime: '2026-05-08T02:00:00Z',
          earliestMatchTime: null,
          rundownMatchTime: null,
          sportspageMatchTime: null,
        },
        'all-null',
      ),
    ).not.toThrow();
  });

  it('admits a games-side snapshot exactly at the freshness edge and excludes one below it', () => {
    // The pair the games surface was missing. `admittedGameInputs` compares
    // `snapshot >= gameMatchTime - SNAPSHOT_FRESHNESS_MS`, and the ONLY input
    // that separates that from a `>` is one sitting exactly on the boundary:
    // the edge is inside an inclusive window and outside an exclusive one.
    //
    // Why the obvious input does not discriminate: a snapshot far below the
    // feed value — the shape the case below this one uses, and the shape the
    // `stale-rundown-excluded` fixture carries — is refused by an inclusive
    // window AND by an exclusive one alike, so it cannot tell the two apart.
    // An extreme value fails every candidate rule; a boundary value fails
    // exactly one of them.
    //
    // Units. core-api applies this rule at microsecond resolution on the games
    // surface (`v >= m - 3_600_000_000n` in `src/v1/games.ts`) and as
    // `interval '1 hour'` in the contest view. These fixture literals are
    // canonical UTC to the second — `instantMs` refuses anything finer — so
    // one second is the smallest step below the edge this guard can express.
    // A microsecond nudge is unrepresentable here and would buy nothing: every
    // value strictly below the edge is on the same side of both windows. The
    // edge is derived from `SNAPSHOT_FRESHNESS_MS` rather than written out, so
    // moving the window moves the pair with it instead of un-discriminating it.
    const feed = '2026-05-09T18:00:00Z';
    const edge = iso(instantMs(feed, 'feed') - SNAPSHOT_FRESHNESS_MS);
    const belowEdge = iso(instantMs(edge, 'edge') - 1000);

    const admitted: GameStartTimes = {
      matchTime: edge,
      gameMatchTime: feed,
      earliestMatchTime: null,
      rundownMatchTime: edge,
      sportspageMatchTime: null,
    };
    const excluded: GameStartTimes = { ...admitted, rundownMatchTime: belowEdge };

    // Everything else is held, asserted rather than trusted: the freshness
    // comparison is the only thing that can give these two different verdicts.
    expect(GAME_START_TIME_FIELDS.filter((f) => admitted[f] !== excluded[f])).toEqual([
      'rundownMatchTime',
    ]);

    // Inclusive: the edge is admitted, so it drives the minimum and matchTime
    // equals it. This is the half that reddens if the comparison becomes `>`.
    expect(() => expectWireValidGameStartTimes(admitted, 'games-edge-admitted')).not.toThrow();
    // One second lower the snapshot drops out, the minimum becomes the feed
    // value, and the same served matchTime is no longer producible.
    expect(() => expectWireValidGameStartTimes(excluded, 'games-edge-excluded')).toThrow(
      /not the minimum/,
    );
  });

  it('excludes a stale games-side snapshot from the minimum', () => {
    // The far-below case. It proves the window is applied at all; it does NOT
    // separate `>=` from `>` — the test above it is what does that.
    const feed = '2026-05-09T20:00:00Z';
    const fresh = iso(instantMs(feed, 'feed') - 30 * MINUTE);
    const staleValue = iso(instantMs(feed, 'feed') - SNAPSHOT_FRESHNESS_MS - MINUTE);
    expect(() =>
      expectWireValidGameStartTimes(
        {
          matchTime: fresh,
          gameMatchTime: feed,
          earliestMatchTime: null,
          rundownMatchTime: fresh,
          sportspageMatchTime: null,
        },
        'games-fresh',
      ),
    ).not.toThrow();
    expect(() =>
      expectWireValidGameStartTimes(
        {
          matchTime: staleValue,
          gameMatchTime: feed,
          earliestMatchTime: null,
          rundownMatchTime: staleValue,
          sportspageMatchTime: null,
        },
        'games-stale',
      ),
    ).toThrow(/not the minimum/);
  });
});
