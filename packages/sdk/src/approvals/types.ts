/**
 * Types for the approvals snapshot — the cross-cutting view of
 * relevant ERC-20 allowances for an Ospex user wallet.
 *
 * Two spenders matter on Ospex (both USDC):
 *
 *   - **USDC → PositionModule**  — pulled at match time as the
 *     maker/taker risk. Required for every commitment match.
 *   - **USDC → TreasuryModule**  — pulled at first match of a lazy
 *     speculation (maker/taker creation-fee split) AND at contest
 *     creation. One allowance covers both purposes.
 *
 * (R5/CRE removed the LINK → OracleModule dimension — contest
 * verify/score are permissionless and funded off-chain by the
 * workflow owner.)
 *
 * The snapshot exposes raw bigint allowances so consumers can build
 * their own thresholds (the CLI `approvals show`, `doctor`, future
 * market-maker readiness checks). Display formatting is the consumer's
 * job — see `formatUnits(value, 6)` etc.
 */

import type { Hex } from '../types/signer.js';

export type ApprovalSpender =
  | 'positionModule'
  | 'treasuryModule';

export interface AllowanceEntry {
  /** The spender contract address. */
  spender: Hex;
  /** Which Ospex module the spender is. */
  spenderModule: ApprovalSpender;
  /**
   * The current `allowance(owner, spender)` reading from the token
   * contract. Always in the token's native units (6 decimals for
   * USDC). `0n` means no approval.
   */
  raw: bigint;
}

export interface UsdcAllowances {
  address: Hex;
  decimals: 6;
  allowances: {
    /** Pulled at match time (taker / maker risk). */
    positionModule: AllowanceEntry;
    /** Pulled for contest creation fees AND lazy speculation creation fees. */
    treasuryModule: AllowanceEntry;
  };
}

export interface ApprovalsSnapshot {
  /** The wallet whose allowances were read. */
  owner: Hex;
  /** Chain id the snapshot was taken on. */
  chainId: number;
  usdc: UsdcAllowances;
}

export interface ReadApprovalsArgs {
  /**
   * Wallet address to read allowances for. Defaults to the configured
   * signer's address — passing `owner` explicitly skips the signer
   * lookup, which avoids a Foundry-keystore passphrase prompt for
   * read-only flows like `ospex approvals show --address`.
   */
  owner?: Hex;
}
