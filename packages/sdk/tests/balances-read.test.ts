/**
 * `client.balances.read()` — verify the snapshot composes the two
 * expected reads (native getBalance + USDC.balanceOf), uses the explicit
 * owner when passed, and falls back to the signer otherwise. Mirrors the
 * test structure of `approvals-read.test.ts`. (R5/CRE removed the LINK
 * balance dimension.)
 */

import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { read } from '../src/balances/read.js';
import type { BalancesContext } from '../src/balances/context.js';
import type { OspexAddresses } from '../src/contracts/addresses.js';
import type { Signer } from '../src/types/signer.js';

const OWNER_OVERRIDE = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;
const SIGNER_ADDR = '0x1111111111111111111111111111111111111111' as const;

const ADDRESSES: OspexAddresses = {
  matchingModule: '0x4040404040404040404040404040404040404040',
  positionModule: '0x2222222222222222222222222222222222222222',
  usdc: '0x3333333333333333333333333333333333333333',
  ospexCore: '0x5050505050505050505050505050505050505050',
  speculationModule: '0x6060606060606060606060606060606060606060',
  contestModule: '0x7070707070707070707070707070707070707070',
  leaderboardModule: '0x8080808080808080808080808080808080808080',
  rulesModule: '0x9090909090909090909090909090909090909090',
  treasuryModule: '0x5555555555555555555555555555555555555555',
  secondaryMarketModule: '0xaa00000000000000000000000000000000000000',
  creOracleReceiver: '0x6666666666666666666666666666666666666666',
  scorers: {
    moneyline: '0xbb00000000000000000000000000000000000000',
    spread: '0xcc00000000000000000000000000000000000000',
    total: '0xdd00000000000000000000000000000000000000',
  },
};

interface ReadCalls {
  getBalance: Array<{ address: string }>;
  readContract: Array<{ token: string; owner: string }>;
}

interface FakeOpts {
  native?: bigint;
  usdc?: bigint;
  signerThrows?: boolean;
}

function makeContext(opts: FakeOpts = {}): { ctx: BalancesContext; calls: ReadCalls } {
  const calls: ReadCalls = { getBalance: [], readContract: [] };

  const publicClient = {
    getBalance: async (params: { address: string }) => {
      calls.getBalance.push({ address: params.address });
      return opts.native ?? 0n;
    },
    readContract: async (params: {
      address: string;
      args: readonly [string];
    }) => {
      const [owner] = params.args;
      calls.readContract.push({ token: params.address, owner });
      if (params.address.toLowerCase() === ADDRESSES.usdc.toLowerCase()) {
        return opts.usdc ?? 0n;
      }
      return 0n;
    },
  } as unknown as PublicClient;

  const signer: Signer = {
    getAddress: async () => {
      if (opts.signerThrows) throw new Error('signer not available');
      return SIGNER_ADDR;
    },
    signTypedData: async () => '0xdead',
    signTransaction: async () => '0xfeed',
  };

  const ctx: BalancesContext = {
    requireSigner: () => signer,
    getChainId: () => 137,
    getAddresses: () => ADDRESSES,
    requireChainClient: () => publicClient,
  };
  return { ctx, calls };
}

describe('client.balances.read', () => {
  it('reads native + USDC in parallel when owner is passed', async () => {
    const { ctx, calls } = makeContext({
      native: 2n * 10n ** 18n,
      usdc: 42_120_000n,
    });

    const snap = await read(ctx, { owner: OWNER_OVERRIDE });

    expect(snap.owner).toBe(OWNER_OVERRIDE);
    expect(snap.chainId).toBe(137);
    expect(snap.native).toBe(2n * 10n ** 18n);
    expect(snap.usdc).toBe(42_120_000n);
    expect(snap.usdcAddress.toLowerCase()).toBe(ADDRESSES.usdc.toLowerCase());

    // One getBalance call against the owner; one readContract call (USDC),
    // scoped to the owner.
    expect(calls.getBalance).toHaveLength(1);
    expect(calls.getBalance[0]!.address.toLowerCase()).toBe(OWNER_OVERRIDE.toLowerCase());
    expect(calls.readContract).toHaveLength(1);
    expect(calls.readContract[0]!.owner.toLowerCase()).toBe(OWNER_OVERRIDE.toLowerCase());
    expect(calls.readContract[0]!.token.toLowerCase()).toBe(ADDRESSES.usdc.toLowerCase());
  });

  it('falls back to the configured signer when owner is omitted', async () => {
    const { ctx, calls } = makeContext({ native: 1n });
    const snap = await read(ctx);
    expect(snap.owner.toLowerCase()).toBe(SIGNER_ADDR.toLowerCase());
    expect(snap.native).toBe(1n);
    expect(calls.getBalance[0]!.address.toLowerCase()).toBe(SIGNER_ADDR.toLowerCase());
  });

  it('does not consult the signer when owner is passed (no passphrase prompt path)', async () => {
    const { ctx } = makeContext({ signerThrows: true });
    // Same contract as approvals.read({ owner }) — passing an explicit
    // owner skips signer.getAddress() entirely so a Foundry-keystore-
    // backed signer doesn't prompt for the passphrase.
    const snap = await read(ctx, { owner: OWNER_OVERRIDE });
    expect(snap.owner).toBe(OWNER_OVERRIDE);
  });

  it('returns zero balances cleanly when the wallet is empty', async () => {
    const { ctx } = makeContext();
    const snap = await read(ctx, { owner: OWNER_OVERRIDE });
    expect(snap.native).toBe(0n);
    expect(snap.usdc).toBe(0n);
  });
});
