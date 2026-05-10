/**
 * EIP-712 typed-data definitions and helpers for Ospex commitments.
 *
 * Source of truth for the schema is the contract typehash on
 * `MatchingModule`. The OspexCommitment has nine fields; any 10-field
 * schema (with `contributionAmount`) is a legacy layout and will fail
 * verification on chain.
 *
 * The `verifyingContract` for the domain is the MatchingModule, NOT
 * OspexCore. This is the single most common new-integrator bug —
 * keep it pinned here.
 */

import { encodeAbiParameters, hashTypedData, keccak256 } from 'viem';
import type { ChainId, EIP712Domain } from '../types/protocol.js';
import type { Hex } from '../types/signer.js';

export const OSPEX_DOMAIN_NAME = 'Ospex';
export const OSPEX_DOMAIN_VERSION = '1';

export const OSPEX_COMMITMENT_TYPES = {
  OspexCommitment: [
    { name: 'maker', type: 'address' },
    { name: 'contestId', type: 'uint256' },
    { name: 'scorer', type: 'address' },
    { name: 'lineTicks', type: 'int32' },
    { name: 'positionType', type: 'uint8' },
    { name: 'oddsTick', type: 'uint16' },
    { name: 'riskAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const;

export const CANCEL_COMMITMENT_TYPES = {
  CancelCommitment: [
    { name: 'commitmentHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const;

export interface OspexCommitmentMessage {
  maker: Hex;
  contestId: bigint;
  scorer: Hex;
  lineTicks: number;
  positionType: 0 | 1;
  oddsTick: number;
  riskAmount: bigint;
  nonce: bigint;
  expiry: bigint;
}

export interface CancelCommitmentMessage {
  commitmentHash: Hex;
  expiry: bigint;
}

export function buildDomain(chainId: ChainId, matchingModule: Hex): EIP712Domain {
  return {
    name: OSPEX_DOMAIN_NAME,
    version: OSPEX_DOMAIN_VERSION,
    chainId,
    verifyingContract: matchingModule,
  };
}

/**
 * Compute the EIP-712 hash of a commitment locally — the same value
 * the on-chain `MatchingModule.getCommitmentHash` returns. The SDK
 * computes this independently of the server so it can be used as the
 * idempotency key without trusting the server's echo.
 */
export function hashCommitment(domain: EIP712Domain, message: OspexCommitmentMessage): Hex {
  return hashTypedData({
    domain: { ...domain },
    types: OSPEX_COMMITMENT_TYPES,
    primaryType: 'OspexCommitment',
    message,
  });
}

/**
 * Derive the contract's per-speculation key:
 *   keccak256(abi.encode(uint256 contestId, address scorer, int32 lineTicks))
 *
 * This is the lookup key for `s_minNonces[maker][speculationKey]` and
 * matches the Supabase `speculation_key` column. Mirrors the contract
 * derivation at MatchingModule.sol:477-483.
 */
export function deriveSpeculationKey(
  contestId: bigint,
  scorer: Hex,
  lineTicks: number,
): Hex {
  const encoded = encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'address' },
      { type: 'int32' },
    ],
    [contestId, scorer, lineTicks],
  );
  return keccak256(encoded);
}
