import { describe, expect, it } from 'vitest';
import {
  contestToUpdate,
  decodeContestUpdate,
  decodeFill,
  decodePositionDelta,
} from '../src/realtime/decoders.js';
import type { Contest } from '../src/types/contest.js';

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
  });

  it('copies the start-time companion fields verbatim when the stream body carries them', () => {
    const out = decodeContestUpdate({
      contestId: '1',
      awayTeam: 'A',
      homeTeam: 'H',
      sport: 'nba',
      sportId: 1,
      matchTime: '2026-05-02T23:30:00Z',
      chainStartTime: '2026-05-03T00:00:00Z',
      gameMatchTime: '2026-05-03T00:00:00Z',
      gameEarliestMatchTime: '2026-05-02T23:30:00Z',
      status: 'verified',
      awayScore: null,
      homeScore: null,
      verifiedAt: 'v',
      scoredAt: null,
      voidedAt: null,
      contestCreatedAt: 'c',
    });
    expect(out.chainStartTime).toBe('2026-05-03T00:00:00Z');
    expect(out.gameMatchTime).toBe('2026-05-03T00:00:00Z');
    expect(out.gameEarliestMatchTime).toBe('2026-05-02T23:30:00Z');
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
  });

  it('carries the start-time companion fields through the projection when present', () => {
    const contest: Contest = {
      contestId: '1',
      awayTeam: 'A',
      homeTeam: 'H',
      sport: 'nba',
      sportId: 1,
      matchTime: '2026-05-02T23:30:00Z',
      chainStartTime: '2026-05-03T00:00:00Z',
      gameMatchTime: '2026-05-03T00:00:00Z',
      gameEarliestMatchTime: '2026-05-02T23:30:00Z',
      status: 'verified',
      speculations: [],
    };
    const out = contestToUpdate(contest);
    expect(out.chainStartTime).toBe('2026-05-03T00:00:00Z');
    expect(out.gameMatchTime).toBe('2026-05-03T00:00:00Z');
    expect(out.gameEarliestMatchTime).toBe('2026-05-02T23:30:00Z');
  });
});
