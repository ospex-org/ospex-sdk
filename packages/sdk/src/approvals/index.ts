/**
 * Approvals namespace — cross-cutting view of Ospex-relevant ERC-20
 * allowances for a configured wallet. Composes existing per-spender
 * allowance reads (USDC→PositionModule from commitments, USDC→
 * TreasuryModule shared with contests) into one snapshot so the CLI
 * doesn't have to.
 *
 * Read-only at M5; the `setup` orchestration (multi-tx approve flow)
 * lands in the next PR. Today this surface backs `ospex approvals show`
 * and the upcoming `ospex doctor`.
 */

import { read } from './read.js';
import type { ApprovalsContext } from './context.js';
import type { ApprovalsSnapshot, ReadApprovalsArgs } from './types.js';

export class Approvals {
  constructor(private readonly ctx: ApprovalsContext) {}

  /**
   * Read every Ospex-relevant allowance for `owner` (or the configured
   * signer's address when `owner` is omitted). Two on-chain reads run
   * in parallel via `Promise.all` so this is one network round trip
   * for the user's perspective.
   *
   * Passing an explicit `owner` keeps the call fully read-only and
   * skips any signer lookup — the path used by `ospex approvals show
   * --address <addr>` and the upcoming `ospex doctor` command.
   */
  read(args: ReadApprovalsArgs = {}): Promise<ApprovalsSnapshot> {
    return read(this.ctx, args);
  }
}

export type {
  AllowanceEntry,
  ApprovalSpender,
  ApprovalsSnapshot,
  ReadApprovalsArgs,
  UsdcAllowances,
} from './types.js';
