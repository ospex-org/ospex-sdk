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
  });
});
