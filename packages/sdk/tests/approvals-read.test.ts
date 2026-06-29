/**
 * `client.approvals.read()` — verify the snapshot composes the two
 * expected `allowance(owner, spender)` calls (USDC→PositionModule,
 * USDC→TreasuryModule), uses the explicit owner when passed, and falls
 * back to the signer otherwise. (R5/CRE removed the LINK→OracleModule
 * dimension.)
 */

import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { read } from '../src/approvals/read.js';
import type { ApprovalsContext } from '../src/approvals/context.js';
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

interface ReadCall {
  token: string;
  owner: string;
  spender: string;
}

interface FakeOpts {
  /** Map of `token:owner:spender` (lowercased) → allowance value. */
  allowances?: Map<string, bigint>;
  signerThrows?: boolean;
}

function makeContext(opts: FakeOpts = {}): { ctx: ApprovalsContext; calls: ReadCall[] } {
  const calls: ReadCall[] = [];
  const allowances = opts.allowances ?? new Map();

  const publicClient = {
    readContract: async (params: {
      address: string;
      args: readonly [string, string];
    }) => {
      const [owner, spender] = params.args;
      calls.push({ token: params.address, owner, spender });
      const k = `${params.address.toLowerCase()}:${owner.toLowerCase()}:${spender.toLowerCase()}`;
      return allowances.get(k) ?? 0n;
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

  const ctx: ApprovalsContext = {
    requireSigner: () => signer,
    getChainId: () => 137,
    getAddresses: () => ADDRESSES,
    requireChainClient: () => publicClient,
  };
  return { ctx, calls };
}

function key(token: string, owner: string, spender: string): string {
  return `${token.toLowerCase()}:${owner.toLowerCase()}:${spender.toLowerCase()}`;
}

describe('client.approvals.read', () => {
  it('reads the two relevant allowances when owner is passed', async () => {
    const allowances = new Map<string, bigint>([
      [key(ADDRESSES.usdc, OWNER_OVERRIDE, ADDRESSES.positionModule), 50_000_000n],
      [key(ADDRESSES.usdc, OWNER_OVERRIDE, ADDRESSES.treasuryModule), 5_000_000n],
    ]);
    const { ctx, calls } = makeContext({ allowances });

    const snap = await read(ctx, { owner: OWNER_OVERRIDE });

    expect(snap.owner).toBe(OWNER_OVERRIDE);
    expect(snap.chainId).toBe(137);
    expect(snap.usdc.allowances.positionModule.raw).toBe(50_000_000n);
    expect(snap.usdc.allowances.treasuryModule.raw).toBe(5_000_000n);
    expect(snap.usdc.allowances.positionModule.spenderModule).toBe('positionModule');
    expect(snap.usdc.allowances.treasuryModule.spenderModule).toBe('treasuryModule');

    // Two reads, exactly: (USDC, owner, positionModule), (USDC, owner,
    // treasuryModule). No incidental calls.
    expect(calls).toHaveLength(2);
    const lowered = calls.map((c) => ({
      token: c.token.toLowerCase(),
      owner: c.owner.toLowerCase(),
      spender: c.spender.toLowerCase(),
    }));
    expect(lowered).toContainEqual({
      token: ADDRESSES.usdc.toLowerCase(),
      owner: OWNER_OVERRIDE.toLowerCase(),
      spender: ADDRESSES.positionModule.toLowerCase(),
    });
    expect(lowered).toContainEqual({
      token: ADDRESSES.usdc.toLowerCase(),
      owner: OWNER_OVERRIDE.toLowerCase(),
      spender: ADDRESSES.treasuryModule.toLowerCase(),
    });
  });

  it('falls back to the configured signer when owner is omitted', async () => {
    const allowances = new Map<string, bigint>([
      [key(ADDRESSES.usdc, SIGNER_ADDR, ADDRESSES.positionModule), 1_000_000n],
    ]);
    const { ctx, calls } = makeContext({ allowances });

    const snap = await read(ctx);

    expect(snap.owner.toLowerCase()).toBe(SIGNER_ADDR.toLowerCase());
    expect(snap.usdc.allowances.positionModule.raw).toBe(1_000_000n);
    // Calls are made against the signer's address — verify by inspecting
    // one call's owner field.
    expect(calls[0]!.owner.toLowerCase()).toBe(SIGNER_ADDR.toLowerCase());
  });

  it('does not consult the signer when owner is passed (no passphrase prompt path)', async () => {
    const { ctx, calls } = makeContext({ signerThrows: true });
    // Even though the signer would throw on getAddress, passing an
    // explicit owner must skip that call entirely. This is the
    // contract that lets `ospex approvals show --address` and
    // `ospex doctor` run without a passphrase prompt.
    const snap = await read(ctx, { owner: OWNER_OVERRIDE });
    expect(snap.owner).toBe(OWNER_OVERRIDE);
    expect(calls).toHaveLength(2);
  });

  it('embeds the spender addresses from the configured chain', async () => {
    const { ctx } = makeContext();
    const snap = await read(ctx, { owner: OWNER_OVERRIDE });
    expect(snap.usdc.address.toLowerCase()).toBe(ADDRESSES.usdc.toLowerCase());
    expect(snap.usdc.allowances.positionModule.spender.toLowerCase()).toBe(
      ADDRESSES.positionModule.toLowerCase(),
    );
    expect(snap.usdc.allowances.treasuryModule.spender.toLowerCase()).toBe(
      ADDRESSES.treasuryModule.toLowerCase(),
    );
    expect(snap.usdc.decimals).toBe(6);
  });
});
