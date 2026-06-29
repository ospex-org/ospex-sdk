/**
 * Balances namespace — wallet-centric POL / USDC reads. Pairs with
 * `client.approvals.read()` to give consumers a complete "what does
 * this wallet currently look like?" view in two parallel-runnable
 * SDK calls.
 *
 * Read-only. The `setup`-style write surface for funding (e.g. wrap
 * gas, swap to USDC) lives outside the SDK — funding is a personal
 * choice and Ospex's BYO posture means we don't introduce a swap
 * abstraction.
 */

import { read } from './read.js';
import type { BalancesContext } from './context.js';
import type { BalancesSnapshot, ReadBalancesArgs } from './types.js';

export class Balances {
  constructor(private readonly ctx: BalancesContext) {}

  /**
   * Read POL (native gas) and USDC balances for `owner` — or the
   * configured signer's address when `owner` is omitted. Two on-chain
   * reads run in parallel; passing `owner` keeps the call fully
   * read-only and skips any signer lookup.
   */
  read(args: ReadBalancesArgs = {}): Promise<BalancesSnapshot> {
    return read(this.ctx, args);
  }
}

export type { BalancesSnapshot, ReadBalancesArgs } from './types.js';
