import { describe, expect, it } from 'vitest';
import {
  contestToUpdate,
  decodeContestUpdate,
  decodeFill,
  decodePositionDelta,
} from '../src/realtime/decoders.js';
import type { Contest } from '../src/types/contest.js';

/**
 * A start-time fixture for a contest WITH a linked games row: every value
 * independent, so every value distinct. Otherwise a swap between two
 * same-typed fields in a decoder is invisible. Measured before this existed:
 * `chainStartTime` and `gameMatchTime` shared one literal here, and swapping
 * those two assignments in `decodeContestUpdate` — and, separately, in
 * `contestToUpdate` — left this file green.
 */
const STREAM_START_TIMES = {
  matchTime: '2026-05-02T23:15:00Z',
  chainStartTime: '2026-05-03T00:00:00Z',
  gameMatchTime: '2026-05-03T00:05:00Z',
  gameEarliestMatchTime: '2026-05-02T23:30:00Z',
  gameRundownMatchTime: '2026-05-03T00:10:00Z',
  gameSportspageMatchTime: '2026-05-03T00:20:00Z',
} as const;

/** The same family for a contest with NO linked games row. */
const UNLINKED_STREAM_START_TIMES = {
  matchTime: '2026-05-03T00:00:00Z',
  chainStartTime: '2026-05-03T00:00:00Z',
  gameMatchTime: '',
  gameEarliestMatchTime: '',
  gameRundownMatchTime: '',
  gameSportspageMatchTime: '',
} as const;

/**
 * The no-games-row fixtures cannot satisfy that rule, and should not be
 * edited until they do: with no linkage, core-api's served bound is a
 * `LEAST(...)` over a NULL join side, so `matchTime` and `chainStartTime` come
 * out equal there, and forcing them apart would buy distinctness with a body
 * that view does not produce. `expectUnlinkedGameStartTimes` pins the shape
 * that makes the exemption legitimate instead — every game-derived companion
 * is the `""` sentinel, leaving no independent pair to discriminate.
 *
 * Bound worth stating: both are call sites, not a structural property of the
 * file. Re-sharing a literal inside a guarded fixture reddens (measured);
 * deleting the CALL along with the literal does not.
 */
function expectDistinctStartTimes(values: readonly string[]): void {
  expect(new Set(values).size).toBe(values.length);
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
    expect(out).not.toHaveProperty('chainStartTime');
    expect(out).not.toHaveProperty('gameMatchTime');
    expect(out).not.toHaveProperty('gameEarliestMatchTime');
    expect(out).not.toHaveProperty('gameRundownMatchTime');
    expect(out).not.toHaveProperty('gameSportspageMatchTime');
  });

  it('copies the start-time companion fields verbatim when the stream body carries them', () => {
    expectDistinctStartTimes(Object.values(STREAM_START_TIMES));
    const out = decodeContestUpdate({
      contestId: '1',
      awayTeam: 'A',
      homeTeam: 'H',
      sport: 'nba',
      sportId: 1,
      ...STREAM_START_TIMES,
      status: 'verified',
      awayScore: null,
      homeScore: null,
      verifiedAt: 'v',
      scoredAt: null,
      voidedAt: null,
      contestCreatedAt: 'c',
    });
    expect(out.matchTime).toBe(STREAM_START_TIMES.matchTime);
    expect(out.chainStartTime).toBe(STREAM_START_TIMES.chainStartTime);
    expect(out.gameMatchTime).toBe(STREAM_START_TIMES.gameMatchTime);
    expect(out.gameEarliestMatchTime).toBe(STREAM_START_TIMES.gameEarliestMatchTime);
    expect(out.gameRundownMatchTime).toBe(STREAM_START_TIMES.gameRundownMatchTime);
    expect(out.gameSportspageMatchTime).toBe(STREAM_START_TIMES.gameSportspageMatchTime);
  });

  it('copies "" provider-snapshot sentinels on a stream body with no games row', () => {
    // Paired with the test above: a decoder broken to always emit "" fails
    // there, one broken to drop "" fails here.
    expectUnlinkedGameStartTimes(UNLINKED_STREAM_START_TIMES);
    const out = decodeContestUpdate({
      contestId: '1',
      awayTeam: 'A',
      homeTeam: 'H',
      sport: 'nba',
      sportId: 1,
      ...UNLINKED_STREAM_START_TIMES,
      status: 'verified',
      awayScore: null,
      homeScore: null,
      verifiedAt: 'v',
      scoredAt: null,
      voidedAt: null,
      contestCreatedAt: 'c',
    });
    expect(out.gameRundownMatchTime).toBe('');
    expect(out.gameSportspageMatchTime).toBe('');
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
    // fields, so the snapshot row matches a same-build stream body.
    expect(out).not.toHaveProperty('chainStartTime');
    expect(out).not.toHaveProperty('gameMatchTime');
    expect(out).not.toHaveProperty('gameEarliestMatchTime');
    expect(out).not.toHaveProperty('gameRundownMatchTime');
    expect(out).not.toHaveProperty('gameSportspageMatchTime');
  });

  it('carries the start-time companion fields through the projection when present', () => {
    expectDistinctStartTimes(Object.values(STREAM_START_TIMES));
    const contest: Contest = {
      contestId: '1',
      awayTeam: 'A',
      homeTeam: 'H',
      sport: 'nba',
      sportId: 1,
      ...STREAM_START_TIMES,
      status: 'verified',
      speculations: [],
    };
    const out = contestToUpdate(contest);
    expect(out.matchTime).toBe(STREAM_START_TIMES.matchTime);
    expect(out.chainStartTime).toBe(STREAM_START_TIMES.chainStartTime);
    expect(out.gameMatchTime).toBe(STREAM_START_TIMES.gameMatchTime);
    expect(out.gameEarliestMatchTime).toBe(STREAM_START_TIMES.gameEarliestMatchTime);
    expect(out.gameRundownMatchTime).toBe(STREAM_START_TIMES.gameRundownMatchTime);
    expect(out.gameSportspageMatchTime).toBe(STREAM_START_TIMES.gameSportspageMatchTime);
  });

  it('carries "" provider-snapshot sentinels through the projection', () => {
    // Paired with the test above, so neither direction passes on a
    // projection broken to always emit one shape.
    expectUnlinkedGameStartTimes(UNLINKED_STREAM_START_TIMES);
    const contest: Contest = {
      contestId: '1',
      awayTeam: 'A',
      homeTeam: 'H',
      sport: 'nba',
      sportId: 1,
      ...UNLINKED_STREAM_START_TIMES,
      status: 'verified',
      speculations: [],
    };
    const out = contestToUpdate(contest);
    expect(out.gameRundownMatchTime).toBe('');
    expect(out.gameSportspageMatchTime).toBe('');
  });
});
