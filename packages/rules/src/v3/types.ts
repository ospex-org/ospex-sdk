import type { Address, Hex } from 'viem';

/**
 * What this package hands a signer, and what it signs: the v3 order and the
 * courier's stop. These shapes are defined here, since this package never
 * imports `@ospex/sdk`; they are the shape of that SDK's `SignTypedDataArgs`,
 * so its keystore signer can be wrapped as a `TypedDataSigner`.
 */

/** One field of an EIP-712 struct type: its name and its Solidity type. */
export interface TypedDataField { readonly name: string; readonly type: string }

/** An EIP-712 domain. The order's and the stop's domains each set name, version, chainId and verifyingContract. */
export interface TypedDataDomain {
  name?: string; version?: string; chainId?: number; verifyingContract?: Hex; salt?: Hex;
}

/** The typed data a signer receives: one domain, the struct types, the primary type and the message. */
export interface TypedDataArgs {
  domain: TypedDataDomain;
  types: Record<string, readonly TypedDataField[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * A signer of typed data: the address it says it signs for, and the one
 * method this package calls. Nothing here can sign a transaction.
 */
export interface TypedDataSigner { readonly address: Address; signTypedData(args: TypedDataArgs): Promise<Hex> }

/** The ten fields of a v3 order, in the matching contract's order and types. */
export interface OspexOrder {
  account: Address; gameId: bigint; scorer: Address; lineTicks: number;  // int32
  positionType: 0 | 1; oddsTick: number;                                 // uint8, uint16
  riskAmount: bigint; nonce: bigint; expiry: bigint; minFill: bigint;    // uint256
}
