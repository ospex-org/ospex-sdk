import type { Hex } from './signer.js';

export type Network = 'polygon' | 'amoy';
export type ChainId = 137 | 80002;

export interface ProtocolContracts {
  matchingModule: string | null;
  scorers: { moneyline: string; spread: string; total: string } | null;
}

export interface ProtocolFees {
  platformFeePct: number;
  description: string;
}

export interface ProtocolInfo {
  name: 'Ospex';
  network: Network;
  chainId: ChainId;
  contracts: ProtocolContracts;
  supportedSports: string[];
  fees: ProtocolFees;
}

/**
 * EIP-712 domain payload returned by `client.protocol.authDomain()`.
 * Suitable for direct use as the `domain` argument to a Signer's
 * `signTypedData` call.
 */
export interface EIP712Domain {
  name: string;
  version: string;
  chainId: ChainId;
  verifyingContract: Hex;
}

/**
 * Subset of `/v1/config/public` the SDK actually uses. The full
 * endpoint includes future fields the SDK is free to ignore.
 */
export interface PublicConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  network: Network;
  chainId: ChainId;
}
