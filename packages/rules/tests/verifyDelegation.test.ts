import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSmartAccountsEnvironment, signDelegation } from '@metamask/smart-accounts-kit';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { TEST_DELEGATE, buildBetDelegation } from '../src/delegation.js';
import { recoverDelegationSigner } from '../src/verifyDelegation.js';

const environment = getSmartAccountsEnvironment(137);

// A key made at test time; it never touches a chain.
const ownerKey = generatePrivateKey();
const owner = privateKeyToAccount(ownerKey);
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const NOT_BEFORE = 1_790_000_137;

const delegation = buildBetDelegation({
  environment,
  from: ACCOUNT,
  to: TEST_DELEGATE,
  notBefore: NOT_BEFORE,
  notAfter: NOT_BEFORE + 600,
});

// The signature comes from the Kit's own signer, so this compares our typed
// data with what the Kit really signs rather than with our own code.
const signature = await signDelegation({
  privateKey: ownerKey,
  delegation,
  delegationManager: environment.DelegationManager,
  chainId: 137,
});

test('the signer recovered from a Kit signature is the key that signed', async () => {
  const recovered = await recoverDelegationSigner({
    delegation,
    signature,
    chainId: 137,
    delegationManager: environment.DelegationManager,
  });
  assert.equal(recovered, owner.address);
});

test('a different chain id recovers someone else, so the domain is really bound', async () => {
  const recovered = await recoverDelegationSigner({
    delegation,
    signature,
    chainId: 1,
    delegationManager: environment.DelegationManager,
  });
  assert.notEqual(recovered, owner.address);
});
