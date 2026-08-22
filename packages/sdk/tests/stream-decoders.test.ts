import { describe, expect, it } from 'vitest';
import {
  contestToUpdate,
  decodeContestUpdate,
  decodeFill,
  decodePositionDelta,
} from '../src/realtime/decoders.js';
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
