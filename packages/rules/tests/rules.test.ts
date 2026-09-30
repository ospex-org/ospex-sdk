import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CaveatType,
  Implementation,
  ScopeType,
  createDelegation,
  getSmartAccountsEnvironment,
  signDelegation,
  toMetaMaskSmartAccount,
  type Delegation,
} from '@metamask/smart-accounts-kit';
import { createPublicClient, encodeFunctionData, erc20Abi, http, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import {
  BET_EXPIRY_SECONDS,
  CLOCK_SKEW_SECONDS,
  MAX_TOP_UP_WINDOW_SECONDS,
  topUpCalldata,
} from '../src/delegation.js';
import {
  APPROVE_SELECTOR,
  MATCHING_MODULE,
  MATCH_COMMITMENT_SELECTOR,
  TREASURY_MODULE,
  USDC,
} from '../src/protocol.js';
import { parseRule, serializeRule, signBetRule, signTopUpRule, type SignedRule } from '../src/rules.js';
import { RuleRefused, verifyRule, type VerifyRuleContext } from '../src/verifyRule.js';

// Keys made at test time; nothing here touches a chain. The client only gives
// the Kit a chain id: deriving a counterfactual address makes no RPC call.
const client = createPublicClient({ chain: polygon, transport: http('http://127.0.0.1:9') });
const environment = getSmartAccountsEnvironment(137);
const ownerKey = generatePrivateKey();
const owner = privateKeyToAccount(ownerKey);
const worker = privateKeyToAccount(generatePrivateKey()).address;
const stranger = privateKeyToAccount(generatePrivateKey());

const derive = async (o: Address) =>
  (await toMetaMaskSmartAccount({ client, implementation: Implementation.Hybrid, deployParams: [o, [], [], []], deploySalt: '0x' }))
    .address;
const account = await toMetaMaskSmartAccount({
  client,
  implementation: Implementation.Hybrid,
  deployParams: [owner.address, [], [], []],
  deploySalt: '0x',
  signer: { account: owner },
});

const NOW = 1_790_000_137;
const AMOUNT = 1_750_003n;
const CAP = 2_000_000n;
const topUp = await signTopUpRule({ account, owner: owner.address, worker, amountUnits: AMOUNT, capUnits: CAP, nowSeconds: NOW });
const bet = await signBetRule({ account, owner: owner.address, worker, nowSeconds: NOW });

function ctx(over: Partial<VerifyRuleContext> = {}): VerifyRuleContext {
  return { kind: 'top-up', worker, environment, nowSeconds: NOW + 30, accountFor: derive, capUnits: CAP, ...over };
}

/** A delegation the OWNER really signed, built outside the page's builder. */
async function ownerSigned(kind: 'top-up' | 'bet', delegation: Omit<Delegation, 'signature'>): Promise<SignedRule> {
  const signature = await account.signDelegation({ delegation, chainId: 137 });
  return { format: 'ospex-rule/1', kind, chainId: 137, owner: owner.address, delegation: { ...delegation, signature } };
}
const timeWindow = { type: CaveatType.Timestamp, afterThreshold: NOW - CLOCK_SKEW_SECONDS, beforeThreshold: NOW + 3_600 } as const;

async function refused(rule: SignedRule, c: VerifyRuleContext, pattern: RegExp) {
  await assert.rejects(verifyRule(rule, c), (err: unknown) => err instanceof RuleRefused && pattern.test(err.message));
}

test('the rules the page signs verify for their worker, through the same text the Copy button carries', async () => {
  const t = await verifyRule(parseRule(serializeRule(topUp)), ctx());
  assert.equal(t.account, account.address);
  assert.equal(t.amountUnits, AMOUNT);
  assert.equal(t.notAfter - t.notBefore, MAX_TOP_UP_WINDOW_SECONDS);

  const b = await verifyRule(parseRule(serializeRule(bet)), ctx({ kind: 'bet' }));
  assert.equal(b.account, account.address);
  assert.equal(b.amountUnits, undefined);
  assert.equal(b.notAfter - b.notBefore, BET_EXPIRY_SECONDS + CLOCK_SKEW_SECONDS);
});

test('the text round trip is lossless', () => {
  assert.deepEqual(parseRule(serializeRule(topUp)), topUp);
  assert.deepEqual(parseRule(serializeRule(bet)), bet);
});

test('a rule is refused for the wrong command, another worker, or another chain', async () => {
  await refused(topUp, ctx({ kind: 'bet' }), /needs a bet rule/);
  await refused(bet, ctx({ kind: 'top-up' }), /needs a top-up rule/);
  await refused(topUp, ctx({ worker: stranger.address }), /not this worker/);
  await refused({ ...topUp, chainId: 1 }, ctx(), /chain 1/);
});

test('a rule is refused when its account is not the one its owner derives', async () => {
  await refused({ ...topUp, owner: stranger.address }, ctx(), /is not the account/);
});

test('a rule is refused when someone other than the owner signed it', async () => {
  const { signature: _drop, ...unsigned } = topUp.delegation;
  const signature = await signDelegation({
    privateKey: generatePrivateKey(),
    delegation: unsigned,
    delegationManager: environment.DelegationManager,
    chainId: 137,
  });
  await refused({ ...topUp, delegation: { ...unsigned, signature } }, ctx(), /signed by .*not the owner/);
});

test('a rule edited after signing is refused: raising the top-up breaks the signature', async () => {
  const caveats = topUp.delegation.caveats.map((c) =>
    c.terms.toLowerCase() === topUpCalldata(AMOUNT).toLowerCase() ? { ...c, terms: topUpCalldata(2_000_000n) } : c,
  );
  assert.notDeepEqual(caveats, topUp.delegation.caveats);
  await refused({ ...topUp, delegation: { ...topUp.delegation, caveats } }, ctx(), /signed by .*not the owner/);
});

test('the window is enforced at both ends, each a second away from an acceptance', async () => {
  const t = await verifyRule(topUp, ctx());
  await refused(topUp, ctx({ nowSeconds: t.notAfter }), /expired/);
  await assert.doesNotReject(verifyRule(topUp, ctx({ nowSeconds: t.notAfter - 1 })));
  await refused(topUp, ctx({ nowSeconds: t.notBefore }), /not valid until/);
  await assert.doesNotReject(verifyRule(topUp, ctx({ nowSeconds: t.notBefore + 1 })));
});

// The owner signs whatever the page asks, so these are the cases a signature
// cannot catch: the rule is genuine but grants more than the builder would.
test('an owner-signed top-up above the cap is refused', async () => {
  const d = createDelegation({
    environment, from: account.address, to: worker,
    scope: { type: ScopeType.FunctionCall, targets: [USDC], selectors: [APPROVE_SELECTOR], exactCalldata: { calldata: topUpCalldata(2_000_001n) } },
    caveats: [{ type: CaveatType.LimitedCalls, limit: 1 }, timeWindow],
  });
  await refused(await ownerSigned('top-up', d), ctx(), /builder would not make this rule.*exceeds the cap/);
});

test('an owner-signed top-up that approves TreasuryModule is refused', async () => {
  const calldata = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TREASURY_MODULE, 1_000_000n] });
  const d = createDelegation({
    environment, from: account.address, to: worker,
    scope: { type: ScopeType.FunctionCall, targets: [USDC], selectors: [APPROVE_SELECTOR], exactCalldata: { calldata } },
    caveats: [{ type: CaveatType.LimitedCalls, limit: 1 }, timeWindow],
  });
  await refused(await ownerSigned('top-up', d), ctx(), /approves .* not PositionModule/);
});

test('an owner-signed top-up with no call limit is refused', async () => {
  const d = createDelegation({
    environment, from: account.address, to: worker,
    scope: { type: ScopeType.FunctionCall, targets: [USDC], selectors: [APPROVE_SELECTOR], exactCalldata: { calldata: topUpCalldata(AMOUNT) } },
    caveats: [timeWindow],
  });
  await refused(await ownerSigned('top-up', d), ctx(), /caveats differ/);
});

test('an owner-signed bet permission with no expiry, a second target, or a long window is refused', async () => {
  const scope = { type: ScopeType.FunctionCall as const, targets: [MATCHING_MODULE], selectors: [MATCH_COMMITMENT_SELECTOR] };
  const noExpiry = createDelegation({ environment, from: account.address, to: worker, scope });
  await refused(await ownerSigned('bet', noExpiry), ctx({ kind: 'bet' }), /exactly one timestamp caveat, found 0/);

  const wider = createDelegation({
    environment, from: account.address, to: worker,
    scope: { ...scope, targets: [MATCHING_MODULE, USDC] },
    caveats: [timeWindow],
  });
  await refused(await ownerSigned('bet', wider), ctx({ kind: 'bet' }), /caveats differ/);

  const long = createDelegation({
    environment, from: account.address, to: worker, scope,
    caveats: [{ type: CaveatType.Timestamp, afterThreshold: NOW - 60, beforeThreshold: NOW + 91 * 86_400 }],
  });
  await refused(await ownerSigned('bet', long), ctx({ kind: 'bet' }), /builder would not make this rule.*window exceeds/);

  const same = createDelegation({ environment, from: account.address, to: worker, scope, caveats: [timeWindow] });
  await assert.doesNotReject(verifyRule(await ownerSigned('bet', same), ctx({ kind: 'bet' })));
});

test('the page refuses to hand over a rule that does not recover to the login signer', async () => {
  await assert.rejects(
    signBetRule({ account, owner: stranger.address, worker, nowSeconds: NOW }),
    /not the login signer/,
  );
});

test('parseRule refuses text that is not a rule', () => {
  assert.throws(() => parseRule('not json'), /not valid JSON/);
  assert.throws(() => parseRule('[]'), /unknown format/);
  assert.throws(() => parseRule(JSON.stringify({ ...topUp, format: 'other' })), /unknown format/);
  assert.throws(() => parseRule(JSON.stringify({ ...topUp, kind: 'withdraw' })), /kind must be/);
  assert.throws(() => parseRule(JSON.stringify({ ...topUp, owner: '0x12' })), /owner must be an address/);
  const noSig = { ...topUp, delegation: { ...topUp.delegation, signature: 42 } };
  assert.throws(() => parseRule(JSON.stringify(noSig)), /must be hex/);
  assert.doesNotThrow(() => parseRule(JSON.stringify(topUp)));
});
