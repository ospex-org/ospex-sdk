import { recoverTypedDataAddress, type Address, type Hex } from 'viem';

/**
 * The EIP-712 shape DelegationManager verifies. Written here from the
 * framework's struct, not imported from the Kit, so that a test can check the
 * two against each other.
 */
const DELEGATION_TYPES = {
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
  ],
  Delegation: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
  ],
} as const;

export interface DelegationLike {
  delegate: Hex;
  delegator: Hex;
  authority: Hex;
  caveats: ReadonlyArray<{ enforcer: Hex; terms: Hex }>;
  salt: Hex;
}

/** Who actually signed this delegation, as recovered from the signature. */
export function recoverDelegationSigner(args: {
  delegation: DelegationLike;
  signature: Hex;
  chainId: number;
  delegationManager: Address;
}): Promise<Address> {
  const { delegation, signature, chainId, delegationManager } = args;
  return recoverTypedDataAddress({
    domain: { name: 'DelegationManager', version: '1', chainId, verifyingContract: delegationManager },
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: {
      delegate: delegation.delegate,
      delegator: delegation.delegator,
      authority: delegation.authority,
      caveats: delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })),
      // The Kit reads an empty salt as zero; so does this.
      salt: delegation.salt === '0x' ? 0n : BigInt(delegation.salt),
    },
    signature,
  });
}
