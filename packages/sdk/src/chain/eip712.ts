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

export const OSPEX_STREAM_AUTH_DOMAIN_NAME = 'OspexStreamAuth';
export const OSPEX_STREAM_AUTH_DOMAIN_VERSION = '1';

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

// ────────────────────────────────────────────────────────────────────
// OspexStreamAuth — owner-auth stream-token challenge (own-state SSE
// plan §3.2). Signed by the maker to trade for a short-lived bearer
// token on `/v1/auth/stream-{challenge,token}`; the token gates the
// owner-auth own-state surfaces (`/v1/own-state/snapshot`,
// `/v1/stream/own-state`).
//
// Separate `domainSeparator` from the OspexCommitment domain — the
// `name` field differs, so an `OspexCommitment` signature can never
// be replayed as an `OspexStreamAuth` and vice-versa. The
// `verifyingContract` reuses the MatchingModule address only to keep
// the domain shape identical to the existing idiom; nothing on chain
// reads stream-auth domains.
//
// Nested struct: `network` is a `StreamAuthNetwork` (one `uint256
// chainId` field) so future network metadata (`network.name`, etc.)
// doesn't require a breaking schema change. Both struct sets must be
// passed to viem / ethers as the `types` argument for EIP-712
// encoding.
// ────────────────────────────────────────────────────────────────────

export const STREAM_AUTH_TYPES = {
  OspexStreamAuth: [
    { name: 'address', type: 'address' },
    { name: 'resource', type: 'string' },
    { name: 'scope', type: 'string' },
    { name: 'network', type: 'StreamAuthNetwork' },
    { name: 'audience', type: 'string' },
    { name: 'challengeId', type: 'string' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
  StreamAuthNetwork: [
    { name: 'chainId', type: 'uint256' },
  ],
} as const;

/**
 * EIP-712 message for the stream-auth challenge. The wire body (a
 * `StreamChallenge` returned by `POST /v1/auth/stream-challenge`)
 * carries `chainId` / `issuedAt` / `expiresAt` as `number`; this
 * type is the BigInt-coerced shape ready for viem's `hashTypedData`
 * / `signTypedData`. `mintStreamToken` (`ownState/auth.ts`) does the
 * coercion before signing.
 */
export interface StreamChallengeMessage {
  address: Hex;
  resource: 'own-state';
  scope: 'read:own-state';
  network: { chainId: bigint };
  audience: string;
  challengeId: string;
  issuedAt: bigint;
  expiresAt: bigint;
}

export function buildStreamAuthDomain(chainId: ChainId, matchingModule: Hex): EIP712Domain {
  return {
    name: OSPEX_STREAM_AUTH_DOMAIN_NAME,
    version: OSPEX_STREAM_AUTH_DOMAIN_VERSION,
    chainId,
    verifyingContract: matchingModule,
  };
}

/**
 * Compute the EIP-712 hash of a stream-auth challenge locally — the
 * same digest the server's verifier reconstructs in
 * `POST /v1/auth/stream-token`. Used by the round-trip test and
 * available to callers that want to log the challenge fingerprint
 * without revealing the signature.
 */
export function hashStreamChallenge(
  domain: EIP712Domain,
  message: StreamChallengeMessage,
): Hex {
  return hashTypedData({
    domain: { ...domain },
    types: STREAM_AUTH_TYPES,
    primaryType: 'OspexStreamAuth',
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
