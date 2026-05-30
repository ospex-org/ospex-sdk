/**
 * EIP-712 hash + speculation-key cross-validation tests.
 *
 * The "hash vector" test pins the SDK's typed-data encoding against
 * the contract's COMMITMENT_TYPEHASH (verbatim from
 * MatchingModule.sol:43-56). If anyone reorders fields, renames a
 * field, or changes a type, the typehash diverges and these tests
 * catch it before a single bad commitment hits the wire.
 *
 * We also cross-check viem's hashTypedData against ethers'
 * TypedDataEncoder.hash for a concrete commitment — two independent
 * EIP-712 implementations agreeing on the same digest is a strong
 * signal we're encoding correctly.
 */

import { describe, expect, it } from 'vitest';
import { ethers, TypedDataEncoder } from 'ethers';
import { encodeAbiParameters, keccak256, toBytes } from 'viem';
import {
  buildDomain,
  buildStreamAuthDomain,
  CANCEL_COMMITMENT_TYPES,
  deriveSpeculationKey,
  hashCommitment,
  hashStreamChallenge,
  OSPEX_COMMITMENT_TYPES,
  OSPEX_STREAM_AUTH_DOMAIN_NAME,
  STREAM_AUTH_TYPES,
  type OspexCommitmentMessage,
  type StreamChallengeMessage,
} from '../src/chain/eip712.js';
import type { Hex } from '../src/types/signer.js';

// Verbatim from MatchingModule.sol:43-56. Any drift between this
// string and the contract's keccak256 input means the SDK and the
// contract disagree on what they're hashing.
const COMMITMENT_TYPEHASH_STRING =
  'OspexCommitment(' +
  'address maker,' +
  'uint256 contestId,' +
  'address scorer,' +
  'int32 lineTicks,' +
  'uint8 positionType,' +
  'uint16 oddsTick,' +
  'uint256 riskAmount,' +
  'uint256 nonce,' +
  'uint256 expiry' +
  ')';

const MATCHING_MODULE_AMOY = '0x36bc5693ee30cd65f8dce51bd48bc03815091a26' as Hex;

describe('chain/eip712 — typehash + hashCommitment', () => {
  it('SDK type declaration produces the contract typehash byte-for-byte', () => {
    const expected = keccak256(toBytes(COMMITMENT_TYPEHASH_STRING));
    // Reconstruct the typehash string from the SDK's typed-data
    // declaration the same way the EIP-712 spec does. If the SDK's
    // OSPEX_COMMITMENT_TYPES diverges from the contract, this string
    // diverges, and so does the hash.
    const sdkString =
      'OspexCommitment(' +
      OSPEX_COMMITMENT_TYPES.OspexCommitment.map((f) => `${f.type} ${f.name}`).join(',') +
      ')';
    expect(sdkString).toBe(COMMITMENT_TYPEHASH_STRING);
    expect(keccak256(toBytes(sdkString))).toBe(expected);
  });

  it('CancelCommitment typed-data matches the contract spec', () => {
    const sdkString =
      'CancelCommitment(' +
      CANCEL_COMMITMENT_TYPES.CancelCommitment.map((f) => `${f.type} ${f.name}`).join(',') +
      ')';
    expect(sdkString).toBe('CancelCommitment(bytes32 commitmentHash,uint256 expiry)');
  });

  it('hashCommitment matches an ethers cross-implementation', () => {
    const domain = buildDomain(80002, MATCHING_MODULE_AMOY);
    const message: OspexCommitmentMessage = {
      maker: '0x1111111111111111111111111111111111111111',
      contestId: 12345n,
      scorer: '0xd846B7FdbD8C9F67d1580B2C6a8Bd7Fdcb15390b',
      lineTicks: -35,
      positionType: 0,
      oddsTick: 191,
      riskAmount: 10_000_000n,
      nonce: 1_700_000_000n,
      expiry: 2_000_000_000n,
    };

    const sdkHash = hashCommitment(domain, message);

    // ethers cross-check. Note ethers.TypedDataEncoder.hash takes the
    // same domain, same field defs, same values; if it disagrees with
    // viem, one of them is encoding wrong (and ethers has been the
    // reference implementation for years).
    const ethersTypes = {
      OspexCommitment: OSPEX_COMMITMENT_TYPES.OspexCommitment.map((f) => ({
        name: f.name,
        type: f.type,
      })),
    };
    const ethersHash = TypedDataEncoder.hash(
      {
        name: 'Ospex',
        version: '1',
        chainId: 80002,
        verifyingContract: MATCHING_MODULE_AMOY,
      },
      ethersTypes,
      { ...message },
    );

    expect(sdkHash.toLowerCase()).toBe(ethersHash.toLowerCase());
  });

  it('hashCommitment changes when any single field changes', () => {
    const domain = buildDomain(137, MATCHING_MODULE_AMOY);
    const base: OspexCommitmentMessage = {
      maker: '0x1111111111111111111111111111111111111111',
      contestId: 1n,
      scorer: '0x2222222222222222222222222222222222222222',
      lineTicks: 0,
      positionType: 0,
      oddsTick: 200,
      riskAmount: 1_000n,
      nonce: 1n,
      expiry: 9_999_999_999n,
    };
    const baseHash = hashCommitment(domain, base);
    expect(hashCommitment(domain, { ...base, nonce: 2n })).not.toBe(baseHash);
    expect(hashCommitment(domain, { ...base, riskAmount: 1_100n })).not.toBe(baseHash);
    expect(hashCommitment(domain, { ...base, positionType: 1 })).not.toBe(baseHash);
    expect(hashCommitment(domain, { ...base, oddsTick: 201 })).not.toBe(baseHash);
  });
});

describe('chain/eip712 — OspexStreamAuth', () => {
  // Verbatim from `ospex-core-api/src/lib/eip712.ts:122-135`. The two halves
  // — SDK signer + core-api verifier — MUST agree byte-for-byte on the
  // typed-data layout for the EIP-712 hash to match across implementations.
  const STREAM_AUTH_TYPEHASH_STRING =
    'OspexStreamAuth(' +
    'address address,' +
    'string resource,' +
    'string scope,' +
    'StreamAuthNetwork network,' +
    'string audience,' +
    'string challengeId,' +
    'uint256 issuedAt,' +
    'uint256 expiresAt' +
    ')' +
    'StreamAuthNetwork(uint256 chainId)';

  it('SDK typed-data declaration produces the core-api typehash byte-for-byte', () => {
    const sdkOuter = STREAM_AUTH_TYPES.OspexStreamAuth.map(
      (f) => `${f.type} ${f.name}`,
    ).join(',');
    const sdkInner = STREAM_AUTH_TYPES.StreamAuthNetwork.map(
      (f) => `${f.type} ${f.name}`,
    ).join(',');
    const sdkString =
      `OspexStreamAuth(${sdkOuter})StreamAuthNetwork(${sdkInner})`;
    expect(sdkString).toBe(STREAM_AUTH_TYPEHASH_STRING);
    expect(keccak256(toBytes(sdkString))).toBe(
      keccak256(toBytes(STREAM_AUTH_TYPEHASH_STRING)),
    );
  });

  it('hashStreamChallenge matches an ethers cross-implementation', () => {
    const domain = buildStreamAuthDomain(80002, MATCHING_MODULE_AMOY);
    const message: StreamChallengeMessage = {
      address: '0x1111111111111111111111111111111111111111',
      resource: 'own-state',
      scope: 'read:own-state',
      network: { chainId: 80002n },
      audience: 'api.ospex.test',
      challengeId: 'GcM1Lkpb7CL6wFCgC5_eIA',
      issuedAt: 1_790_000_000n,
      expiresAt: 1_790_000_180n,
    };

    const sdkHash = hashStreamChallenge(domain, message);

    // Pass the full nested-types graph to ethers, mirroring viem's `STREAM_AUTH_TYPES`.
    const ethersTypes = {
      OspexStreamAuth: STREAM_AUTH_TYPES.OspexStreamAuth.map((f) => ({
        name: f.name,
        type: f.type,
      })),
      StreamAuthNetwork: STREAM_AUTH_TYPES.StreamAuthNetwork.map((f) => ({
        name: f.name,
        type: f.type,
      })),
    };
    const ethersHash = TypedDataEncoder.hash(
      {
        name: OSPEX_STREAM_AUTH_DOMAIN_NAME,
        version: '1',
        chainId: 80002,
        verifyingContract: MATCHING_MODULE_AMOY,
      },
      ethersTypes,
      { ...message },
    );

    expect(sdkHash.toLowerCase()).toBe(ethersHash.toLowerCase());
  });

  it('stream-auth domain separator differs from OspexCommitment — replay refusal', () => {
    // If the two domain separators collided, an OspexCommitment signature
    // could be re-presented as an OspexStreamAuth signature (or vice-versa),
    // letting a maker accidentally hand out token-mint authority by signing
    // a commitment. The differing `name` field (`Ospex` vs `OspexStreamAuth`)
    // is what guarantees separation.
    const commitmentDomain = buildDomain(137, MATCHING_MODULE_AMOY);
    const streamDomain = buildStreamAuthDomain(137, MATCHING_MODULE_AMOY);
    expect(streamDomain.name).toBe(OSPEX_STREAM_AUTH_DOMAIN_NAME);
    expect(commitmentDomain.name).not.toBe(streamDomain.name);
  });

  it('hash changes when any single field changes', () => {
    const domain = buildStreamAuthDomain(137, MATCHING_MODULE_AMOY);
    const base: StreamChallengeMessage = {
      address: '0x1111111111111111111111111111111111111111',
      resource: 'own-state',
      scope: 'read:own-state',
      network: { chainId: 137n },
      audience: 'api.ospex.org',
      challengeId: 'aaaa',
      issuedAt: 1_790_000_000n,
      expiresAt: 1_790_000_180n,
    };
    const baseHash = hashStreamChallenge(domain, base);
    expect(
      hashStreamChallenge(domain, {
        ...base,
        address: '0x2222222222222222222222222222222222222222',
      }),
    ).not.toBe(baseHash);
    expect(
      hashStreamChallenge(domain, { ...base, challengeId: 'bbbb' }),
    ).not.toBe(baseHash);
    expect(
      hashStreamChallenge(domain, { ...base, issuedAt: base.issuedAt + 1n }),
    ).not.toBe(baseHash);
    expect(
      hashStreamChallenge(domain, { ...base, expiresAt: base.expiresAt + 1n }),
    ).not.toBe(baseHash);
    expect(
      hashStreamChallenge(domain, {
        ...base,
        network: { chainId: 80002n },
      }),
    ).not.toBe(baseHash);
  });
});

describe('chain/eip712 — deriveSpeculationKey', () => {
  it('matches a viem-direct implementation byte-for-byte', () => {
    const contestId = 9999n;
    const scorer = '0xd846B7FdbD8C9F67d1580B2C6a8Bd7Fdcb15390b' as Hex;
    const lineTicks = -50;

    const sdkKey = deriveSpeculationKey(contestId, scorer, lineTicks);

    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }],
        [contestId, scorer, lineTicks],
      ),
    );
    expect(sdkKey).toBe(expected);
  });

  it('derivation differs when any input differs', () => {
    const a = deriveSpeculationKey(1n, '0x' + '11'.repeat(20) as Hex, 0);
    const b = deriveSpeculationKey(2n, '0x' + '11'.repeat(20) as Hex, 0);
    const c = deriveSpeculationKey(1n, '0x' + '22'.repeat(20) as Hex, 0);
    const d = deriveSpeculationKey(1n, '0x' + '11'.repeat(20) as Hex, 1);
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('matches an ethers cross-implementation', () => {
    const sdkKey = deriveSpeculationKey(
      42n,
      '0xd846B7FdbD8C9F67d1580B2C6a8Bd7Fdcb15390b',
      -7,
    );
    const ethersKey = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'address', 'int32'],
        [42n, '0xd846B7FdbD8C9F67d1580B2C6a8Bd7Fdcb15390b', -7],
      ),
    );
    expect(sdkKey.toLowerCase()).toBe(ethersKey.toLowerCase());
  });
});
