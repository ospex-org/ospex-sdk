/**
 * Outer-tx gas wiring on `contests.create` / `contests.score` (R5/CRE):
 *
 *   1. `create()` forwards the hardcoded outer-tx gas
 *      `OSPEX_CREATE_CONTEST_TX_GAS = 2_000_000n` to buildSignAndSend.
 *   2. `score()` forwards the hardcoded outer-tx gas
 *      `OSPEX_SCORE_CONTEST_TX_GAS = 1_000_000n` to buildSignAndSend.
 *
 * Both wiring tests mock `buildSignAndSend` so the test stops after
 * calldata build but before chain submit. The full pipeline (real RPC +
 * CRE oracle report) is exercised in `docs/MANUAL_INTEGRATION_TESTING.md`.
 * There is no `--gas-limit` / Chainlink Functions callback gas under CRE —
 * the request entrypoints are permissionless and the gas budget is the
 * hardcoded outer-tx ceiling only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/commitments/sendTx.js', () => ({
  buildSignAndSend: vi.fn(),
}));

import { create } from '../src/contests/create.js';
import { score } from '../src/contests/score.js';
import { buildSignAndSend } from '../src/commitments/sendTx.js';
import {
  OSPEX_CREATE_CONTEST_TX_GAS,
  OSPEX_SCORE_CONTEST_TX_GAS,
} from '../src/contracts/constants.js';
import type { ContestsContext } from '../src/contests/context.js';
import type { Game } from '../src/types/game.js';
import type { GamesApi } from '../src/api/games.js';
import type { Signer } from '../src/types/signer.js';
import type { PublicClient } from 'viem';
import type { OspexAddresses } from '../src/contracts/addresses.js';

const ADDRS = {
  matchingModule: '0x1B93579B044f0eE3c4C8a9F479A323DeF7770712',
  positionModule: '0x0DCd42f8609cd7884ddBa3481b03a78dfc88366c',
  usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  ospexCore: '0xECD12Af197FBF4C9F706B5Eb11a19c40Cfd643db',
  speculationModule: '0xd757387893E779AC35451CeA639a408A537b9a1B',
  contestModule: '0x1Eb0048650380369C6F4239dE070114463626102',
  leaderboardModule: '0x63f76D5796296FFB94132C6f70d3ff9c3c5a0DEF',
  rulesModule: '0x05aF3d55F44CfaFA59c3B152A1547b5219d90f93',
  treasuryModule: '0xCB56CD2c509301e888965DD3A2E5C486Fe03a56e',
  secondaryMarketModule: '0xaD2B4437296B46a1b107Bb2dB7AC4082182b6059',
  creOracleReceiver: '0x06e3470012039797119Ae30e1236169304F9220C',
  scorers: {
    moneyline: '0xd846B7FdbD8C9F67d1580B2C6a8Bd7Fdcb15390b',
    spread: '0x99c5fF5131F269cA178e2Ea78f2a2A222a3a7d5e',
    total: '0xC141679f09413EDe38E3Cd36a3e4aDE423827972',
  },
} as unknown as OspexAddresses;

function buildGame(): Game {
  return {
    gameId: 'abc',
    slug: 'aaa-bbb-2026-05-05',
    sport: 'mlb',
    matchTime: '2026-05-05T23:00:00+00:00',
    status: 'upcoming',
    homeTeam: { name: 'Home', abbreviation: 'HM' },
    awayTeam: { name: 'Away', abbreviation: 'AW' },
    hasOdds: true,
    contestCreated: false,
    contestId: null,
    canCreateContest: true,
    externalIds: { jsonodds: 'abc', sportspage: 'sp1', rundown: 'rd1' },
  };
}

function makePublicClient(): PublicClient {
  // readContract handles the create() pre-flight:
  //   - TreasuryModule.s_feeRates(0)  → 1 USDC (1_000_000n)
  //   - ERC20.balanceOf / allowance   → 10e12 USDC (way more than required)
  const big = 10_000_000_000_000n;
  return {
    readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 's_feeRates') return 1_000_000n;
      return big;
    }),
  } as unknown as PublicClient;
}

function makeSigner(): Signer {
  return {
    getAddress: vi.fn().mockResolvedValue('0xeDf57Fc01028f4e5Ee9852eedebe5CD875130967'),
    signTransaction: vi.fn(),
  } as unknown as Signer;
}

function makeCtx(game: Game = buildGame()): ContestsContext {
  const gamesApi = { get: async () => game } as unknown as GamesApi;
  const publicClient = makePublicClient();
  const signer = makeSigner();
  return {
    gamesApi,
    getChainId: () => 137 as const,
    getAddresses: () => ADDRS,
    requireSigner: () => signer,
    requireChainClient: () => publicClient,
  } as unknown as ContestsContext;
}

afterEach(() => {
  vi.mocked(buildSignAndSend).mockReset();
});

describe('contests gas — outer-tx gas wiring', () => {
  it('create() forwards gas: 2_000_000n to buildSignAndSend (no estimateGas)', async () => {
    vi.mocked(buildSignAndSend).mockResolvedValue({
      txHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
      receipt: { status: 'success', logs: [] },
    } as unknown as Awaited<ReturnType<typeof buildSignAndSend>>);
    const ctx = makeCtx();

    // create() throws after buildSignAndSend (parseContestIdFromReceipt has
    // no ContestCreated event in the empty `logs`), but the relevant
    // assertion fires before that point.
    await expect(create(ctx, { gameId: 'abc' })).rejects.toThrow();

    expect(buildSignAndSend).toHaveBeenCalledTimes(1);
    expect(buildSignAndSend).toHaveBeenCalledWith(
      expect.objectContaining({ gas: OSPEX_CREATE_CONTEST_TX_GAS }),
    );
    expect(OSPEX_CREATE_CONTEST_TX_GAS).toBe(2_000_000n);
  });

  it('score() forwards gas: 1_000_000n to buildSignAndSend (no estimateGas)', async () => {
    vi.mocked(buildSignAndSend).mockResolvedValue({
      txHash: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
      receipt: { status: 'success', logs: [] },
    } as unknown as Awaited<ReturnType<typeof buildSignAndSend>>);
    const ctx = makeCtx();

    await score(ctx, { contestId: 1n });

    expect(buildSignAndSend).toHaveBeenCalledTimes(1);
    expect(buildSignAndSend).toHaveBeenCalledWith(
      expect.objectContaining({ gas: OSPEX_SCORE_CONTEST_TX_GAS }),
    );
    expect(OSPEX_SCORE_CONTEST_TX_GAS).toBe(1_000_000n);
  });
});
