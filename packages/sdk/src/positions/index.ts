/**
 * Positions namespace — composes the M1 read methods (`byAddress`,
 * `status`) with the M3 read (`claimParams`, `byTx`, `claimResult`)
 * and write (`settleSpeculation`, `claim`, `claimAll`) methods on a
 * single `client.positions` object.
 *
 * Reads work without `rpcUrl` or `signer`. Write methods throw
 * `OspexConfigError` if either is missing — they look up their
 * dependencies through the `PositionsContext` lazily so the parent
 * `OspexClient` doesn't have to construct a chain client until a
 * write actually fires.
 */

import { OspexValidationError } from '../errors.js';
import type { PositionsContext } from './context.js';
import type {
  ClaimParams,
  Position,
  PositionStatus,
} from '../types/position.js';
import type { Hex } from '../types/signer.js';
import type {
  ClaimResultResponseBody,
  PositionByTxResponseBody,
} from '../api/types.js';
import { claim, type ClaimArgs, type ClaimResult } from './claim.js';
import { claimAll, type ClaimAllArgs, type ClaimAllResult } from './claimAll.js';
import { claimParams as claimParamsImpl } from './claimParams.js';
import { settleSpeculation, type SettleArgs, type SettleResult } from './settle.js';

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export interface ClaimResultBody {
  txHash: string;
  blockNumber: number;
  speculationId: string;
  user: string;
  positionType: 0 | 1;
  payoutUSDC: number;
  payoutWei6: string;
}

export interface PositionByTxFilledEntry {
  positionId: string;
  speculationId: string;
  user: string;
  positionType: 0 | 1;
  role: 'maker' | 'taker';
  riskAmount: string;
  riskAmountUSDC: number;
  counterparty: string;
}

export interface PositionByTxBody {
  txHash: string;
  blockNumber: number;
  positions: PositionByTxFilledEntry[];
}

export class Positions {
  constructor(private readonly ctx: PositionsContext) {}

  // ── Reads (M1 carry-over + M3 reads) ──────────────────────────────

  byAddress(address: string): Promise<Position[]> {
    return this.ctx.positionsApi.byAddress(address);
  }

  status(address: string): Promise<PositionStatus> {
    return this.ctx.positionsApi.status(address);
  }

  claimParams(address: string): Promise<ClaimParams> {
    return claimParamsImpl(this.ctx, address);
  }

  /** Parses `PositionFilled` events from a transaction receipt
   * (server-side via core-api). Returns the maker + taker positions
   * created in that tx. Useful right after `commitments.match` for
   * deriving the exact positions established. */
  async byTx(args: { txHash: Hex }): Promise<PositionByTxBody> {
    if (!TX_HASH_PATTERN.test(args.txHash)) {
      throw new OspexValidationError(
        'txHash must be a 0x-prefixed 32-byte hex string.',
        { field: 'txHash' },
      );
    }
    return this.ctx.api.request<PositionByTxResponseBody>(
      `/v1/positions/by-tx/${args.txHash.toLowerCase()}`,
    );
  }

  /** Parses the `PositionClaimed` event from a transaction receipt
   * (server-side via core-api). Useful for surfacing the on-chain
   * payout after a claim has confirmed. */
  async claimResult(args: { txHash: Hex }): Promise<ClaimResultBody> {
    if (!TX_HASH_PATTERN.test(args.txHash)) {
      throw new OspexValidationError(
        'txHash must be a 0x-prefixed 32-byte hex string.',
        { field: 'txHash' },
      );
    }
    return this.ctx.api.request<ClaimResultResponseBody>(
      `/v1/positions/claim-result/${args.txHash.toLowerCase()}`,
    );
  }

  // ── Writes (M3) ───────────────────────────────────────────────────

  settleSpeculation(args: SettleArgs): Promise<SettleResult> {
    return settleSpeculation(this.ctx, args);
  }

  claim(args: ClaimArgs): Promise<ClaimResult> {
    return claim(this.ctx, args);
  }

  claimAll(args: ClaimAllArgs = {}): Promise<ClaimAllResult> {
    return claimAll(this.ctx, args);
  }
}

export type { ClaimArgs, ClaimResult } from './claim.js';
export type { SettleArgs, SettleResult } from './settle.js';
export type { ClaimAllArgs, ClaimAllOptions, ClaimAllResult, ClaimAllEntryResult } from './claimAll.js';
