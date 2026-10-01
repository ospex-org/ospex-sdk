import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Implementation,
  getSmartAccountsEnvironment,
  toMetaMaskSmartAccount,
  type Delegation,
} from '@metamask/smart-accounts-kit';
import { createPublicClient, http, type Address } from 'viem';
import { polygon } from 'viem/chains';
import { CLOCK_SKEW_SECONDS, TOP_UP_EXPIRY_SECONDS, buildTopUpDelegation } from '../src/delegation.js';
import type { SignedRule } from '../src/rules.js';
import { recoverDelegationSigner } from '../src/verifyDelegation.js';
import { RuleRefused, verifyRule } from '../src/verifyRule.js';

// A top-up rule redeemed on Polygon mainnet: tx
// 0x4335f9875860be0686b01f07e54108d543de972d0adf5b4ab5ade30baaa1790b, block
// 94720871, status success. It is DelegationManager.redeemDelegations, sent by
// the worker, with one root delegation and one execution:
// USDC.approve(PositionModule, 2 USDC). Every value below was decoded from that
// transaction's input, or read from chain, and is frozen here as a literal.
// None of it is produced by this package.

const environment = getSmartAccountsEnvironment(137);

/** The transaction's `to`. */
const DELEGATION_MANAGER: Address = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
/** The delegator: the smart account that granted the rule. */
const ACCOUNT: Address = '0x5d9c7be2391c5C8681a771770126C7Edf0B4D01E';
/** The delegate, and the transaction's sender. */
const WORKER: Address = '0xA91d3B695d7a0EeDcA9640f7cF17dC7BE983DacF';
/** The account's `owner()`, read from chain (latest block; the public node keeps no history). */
const OWNER: Address = '0xA527D5a59cE2EB0C5F85bC20181B3f31AFEC71C8';
/** The redemption block's timestamp. */
const REDEEMED_AT = 1_790_786_447;

// The rule's parameters, written in decimal so the caveat bytes below check the
// encoding rather than repeat it.
const NOT_BEFORE = 1_790_785_956;
const NOT_AFTER = 1_790_789_616;
const AMOUNT = 2_000_000n;
/** The cap the page and the worker pass: $100. */
const CAP = 100_000_000n;

const REDEEMED: Delegation = {
  delegate: WORKER,
  delegator: ACCOUNT,
  authority: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  caveats: [
    { enforcer: '0x7F20f61b1f09b08D970938F6fa563634d65c4EeB', terms: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', args: '0x00' },
    { enforcer: '0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5', terms: '0x095ea7b3', args: '0x00' },
    {
      enforcer: '0x92Bf12322527cAA612fd31a0e810472BBB106A8F',
      terms: '0x0000000000000000000000000000000000000000000000000000000000000000',
      args: '0x00',
    },
    {
      enforcer: '0x99F2e9bF15ce5eC84685604836F71aB835DBBdED',
      terms:
        '0x095ea7b30000000000000000000000003c71fdb8abf41487a512440e5ce6490158c26e5600000000000000000000000000000000000000000000000000000000001e8480',
      args: '0x00',
    },
    {
      enforcer: '0x04658B29F6b82ed55274221a06Fc97D318E25416',
      terms: '0x0000000000000000000000000000000000000000000000000000000000000001',
      args: '0x00',
    },
    {
      enforcer: '0x1046bb45C8d673d4ea75321280DB34899413c069',
      terms: '0x0000000000000000000000006abd39a40000000000000000000000006abd47f0',
      args: '0x00',
    },
  ],
  // uint256 0 on chain.
  salt: '0x00',
  signature:
    '0x7c097dab23865d88e1f21fa1584c8216897f0672960f0e9db8b9620f2ec557f31beac49bc70a52cd0f41c075151bd9013fbaa7a47bbf9ca650f50d63b71806f71c',
};

// Hex case is not part of the bytes, so compare lowercase.
const bytes = (caveats: Delegation['caveats']) =>
  caveats.map((c) => ({ enforcer: c.enforcer.toLowerCase(), terms: c.terms.toLowerCase(), args: c.args.toLowerCase() }));

test('the builder makes the caveats of the top-up redeemed on mainnet, byte for byte', () => {
  const built = buildTopUpDelegation({
    environment,
    from: ACCOUNT,
    to: WORKER,
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
    amountUnits: AMOUNT,
    capUnits: CAP,
  });
  assert.deepEqual(bytes(built.caveats), bytes(REDEEMED.caveats));

  assert.equal(built.delegate.toLowerCase(), REDEEMED.delegate.toLowerCase());
  assert.equal(built.delegator.toLowerCase(), REDEEMED.delegator.toLowerCase());
  assert.equal(built.authority.toLowerCase(), REDEEMED.authority.toLowerCase());
  assert.equal(BigInt(built.salt), BigInt(REDEEMED.salt));
});

test('the redeemed window is the one the package still makes, and the Kit names the same DelegationManager', () => {
  assert.equal(NOT_AFTER - NOT_BEFORE, 3_660);
  assert.equal(TOP_UP_EXPIRY_SECONDS + CLOCK_SKEW_SECONDS, 3_660);
  assert.ok(REDEEMED_AT > NOT_BEFORE && REDEEMED_AT < NOT_AFTER);
  assert.equal(environment.DelegationManager.toLowerCase(), DELEGATION_MANAGER.toLowerCase());
});

test('the redeemed signature recovers to the account\'s on-chain owner', async () => {
  const recovered = await recoverDelegationSigner({
    delegation: REDEEMED,
    signature: REDEEMED.signature,
    chainId: 137,
    delegationManager: DELEGATION_MANAGER,
  });
  assert.equal(recovered, OWNER);
});

test('the verifier accepts the redeemed rule for its worker at the block it was redeemed in, and refuses it under a lower cap', async () => {
  // The client only gives the Kit a chain id: deriving a counterfactual address makes no RPC call.
  const client = createPublicClient({ chain: polygon, transport: http('http://127.0.0.1:9') });
  const accountFor = async (o: Address) =>
    (await toMetaMaskSmartAccount({ client, implementation: Implementation.Hybrid, deployParams: [o, [], [], []], deploySalt: '0x' }))
      .address;
  const rule: SignedRule = { format: 'ospex-rule/1', kind: 'top-up', chainId: 137, owner: OWNER, delegation: REDEEMED };
  const ctx = { kind: 'top-up' as const, worker: WORKER, environment, nowSeconds: REDEEMED_AT, accountFor, capUnits: CAP };

  const v = await verifyRule(rule, ctx);
  assert.equal(v.account, ACCOUNT);
  assert.equal(v.amountUnits, AMOUNT);
  assert.equal(v.notBefore, NOT_BEFORE);
  assert.equal(v.notAfter, NOT_AFTER);

  await assert.rejects(
    verifyRule(rule, { ...ctx, capUnits: 1_999_999n }),
    (err: unknown) => err instanceof RuleRefused && /exceeds the cap/.test(err.message),
  );
});
