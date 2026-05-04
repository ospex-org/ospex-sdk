/**
 * Public types for the contests namespace.
 *
 * `Market` (from `./market.ts`) is what `client.contests.get / list`
 * return — the off-chain projected shape, identical to the markets
 * endpoint. No separate `Contest` type is exposed; the Market shape
 * carries every field the M4 surface needs.
 *
 * `ContestStatus` mirrors `OspexTypes.ContestStatus` (`unverified`,
 * `verified`, `scored`, `voided`) and matches the lowercase string in
 * `Market.status`.
 *
 * `ScriptApproval` / `ApprovedScripts` mirror what core-api returns
 * from `GET /v1/contests/scripts/approved` and what the SDK feeds into
 * `OracleModule.createContestFromOracle`'s `approvals` calldata struct.
 */

import type { Hex } from './signer.js';
import type { Network } from './protocol.js';

export type ContestStatus = 'unverified' | 'verified' | 'scored' | 'voided';

export interface ScriptApproval {
  scriptHash: Hex;
  /** 0 = VERIFY, 1 = MARKET_UPDATE, 2 = SCORE. */
  purpose: 0 | 1 | 2;
  /** 0 = Unknown / wildcard. */
  leagueId: number;
  version: number;
  /** Unix seconds. 0 = permanent. */
  validUntil: number;
  signature: Hex;
  sourceUrl: string;
}

export interface ApprovedScripts {
  network: Network;
  approvedSigner: Hex;
  verify: ScriptApproval;
  marketUpdate: ScriptApproval;
  score: ScriptApproval;
}
