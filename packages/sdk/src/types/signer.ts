/**
 * Wallet abstraction. Every signer implementation conforms to this
 * interface — the SDK never touches a private key directly. Concrete
 * signers live in subpaths or sibling packages (e.g. KeystoreSigner
 * in @ospex/sdk/signers/keystore).
 */

export type Hex = `0x${string}`;

export interface TypedDataField {
  name: string;
  type: string;
}

export interface SignTypedDataArgs {
  domain: {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContract?: Hex;
    salt?: Hex;
  };
  /**
   * Accepted as `readonly TypedDataField[]` so callers can pass an
   * `as const` literal without a cast (viem requires `as const` for
   * type inference). Mutable arrays still satisfy this constraint.
   */
  types: Record<string, readonly TypedDataField[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Minimal transaction shape. We accept the common viem-style fields
 * (most signers will support 1559 — type 2 — txs); a signer is free
 * to widen this in its own implementation.
 */
export interface SignTransactionArgs {
  to?: Hex;
  data?: Hex;
  value?: bigint;
  gas?: bigint;
  nonce?: number;
  chainId: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  type?: 'legacy' | 'eip1559' | 'eip2930';
}

export interface Signer {
  getAddress(): Promise<Hex>;
  signTypedData(args: SignTypedDataArgs): Promise<Hex>;
  signTransaction(tx: SignTransactionArgs): Promise<Hex>;
}
