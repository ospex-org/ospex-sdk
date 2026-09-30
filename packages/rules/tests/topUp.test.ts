import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { type Address, type Hex } from 'viem';
import {
  ANY_DELEGATE,
  MAX_TOP_UP_WINDOW_SECONDS,
  TOP_UP_EXPIRY_SECONDS,
  buildTopUpDelegation,
  ruleWindow,
  topUpCalldata,
  type TopUpDelegationArgs,
} from '../src/delegation.js';
import { POSITION_MODULE, TREASURY_MODULE, USDC } from '../src/protocol.js';

const environment = getSmartAccountsEnvironment(137);

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const WORKER: Address = '0x2222222222222222222222222222222222222222';
const NOT_BEFORE = 1_790_000_137;
const NOT_AFTER = NOT_BEFORE + 3_600 + 41;
// An odd amount, so a decimals or units slip cannot pass unnoticed.
const AMOUNT = 1_234_567n;
// The cap the page and the worker pass: $100.
const CAP = 100_000_000n;

const strip = (hex: string): string => hex.replace(/^0x/, '').toLowerCase();
const word = (hex: string): string => strip(hex).padStart(64, '0');

// Written out by hand, not with an encoder: `cast sig "approve(address,uint256)"`
// is 0x095ea7b3, then the spender word, then the amount word.
const HAND_CALLDATA = `0x095ea7b3${word(POSITION_MODULE)}${word(AMOUNT.toString(16))}`;

function args(over: Partial<TopUpDelegationArgs> = {}): TopUpDelegationArgs {
  return { environment, from: ACCOUNT, to: WORKER, notBefore: NOT_BEFORE, notAfter: NOT_AFTER, amountUnits: AMOUNT, capUnits: CAP, ...over };
}

function enforcer(name: string): Hex {
  const address = environment.caveatEnforcers[name];
  assert.ok(address, `environment has no ${name}`);
  return address;
}

function caveatFor(delegation: ReturnType<typeof buildTopUpDelegation>, name: string) {
  const matches = delegation.caveats.filter((c) => c.enforcer.toLowerCase() === enforcer(name).toLowerCase());
  assert.equal(matches.length, 1, `expected exactly one ${name} caveat, got ${matches.length}`);
  return matches[0]!;
}

test('the pinned calldata is approve(PositionModule, amount), byte for byte, and never names TreasuryModule', () => {
  assert.equal(topUpCalldata(AMOUNT), HAND_CALLDATA);
  assert.ok(!topUpCalldata(AMOUNT).toLowerCase().includes(strip(TREASURY_MODULE)));
});

test('the top-up rule: USDC, approve, value 0, exact calldata, one call, the window', () => {
  const d = buildTopUpDelegation(args());
  assert.equal(d.delegator.toLowerCase(), ACCOUNT);
  assert.equal(d.delegate.toLowerCase(), WORKER);
  assert.equal(d.signature, '0x');

  assert.equal(strip(caveatFor(d, 'AllowedTargetsEnforcer').terms), strip(USDC));
  assert.equal(strip(caveatFor(d, 'AllowedMethodsEnforcer').terms), '095ea7b3');
  assert.equal(strip(caveatFor(d, 'ValueLteEnforcer').terms), '0'.repeat(64));
  assert.equal(caveatFor(d, 'ExactCalldataEnforcer').terms.toLowerCase(), HAND_CALLDATA.toLowerCase());
  const limit = caveatFor(d, 'LimitedCallsEnforcer').terms;
  assert.equal(strip(limit).length, 64);
  assert.equal(BigInt(limit), 1n);
  const window = strip(caveatFor(d, 'TimestampEnforcer').terms);
  assert.equal(BigInt(`0x${window.slice(0, 32)}`), BigInt(NOT_BEFORE));
  assert.equal(BigInt(`0x${window.slice(32)}`), BigInt(NOT_AFTER));
});

test('the caveat set is exactly those six enforcers', () => {
  const got = buildTopUpDelegation(args()).caveats.map((c) => c.enforcer.toLowerCase()).sort();
  const want = [
    'AllowedTargetsEnforcer',
    'AllowedMethodsEnforcer',
    'ValueLteEnforcer',
    'ExactCalldataEnforcer',
    'LimitedCallsEnforcer',
    'TimestampEnforcer',
  ]
    .map((n) => enforcer(n).toLowerCase())
    .sort();
  assert.deepEqual(got, want);
});

test('the cap is the caller\'s: exactly the cap is accepted, one unit more is refused', () => {
  // Two caps, so a builder that ignored the argument and kept a constant fails one of them.
  for (const cap of [2_000_000n, 100_000_000n]) {
    assert.doesNotThrow(() => buildTopUpDelegation(args({ capUnits: cap, amountUnits: cap })));
    assert.throws(() => buildTopUpDelegation(args({ capUnits: cap, amountUnits: cap + 1n })), /exceeds the cap/);
  }
});

test('a missing, zero, negative or non-bigint cap is refused, never read as no cap', () => {
  assert.throws(() => buildTopUpDelegation(args({ capUnits: undefined as unknown as bigint })), /cap must be a positive bigint/);
  assert.throws(() => buildTopUpDelegation(args({ capUnits: 0n })), /cap must be a positive bigint/);
  assert.throws(() => buildTopUpDelegation(args({ capUnits: -1n })), /cap must be a positive bigint/);
  assert.throws(() => buildTopUpDelegation(args({ capUnits: 100_000_000 as unknown as bigint })), /cap must be a positive bigint/);
  assert.doesNotThrow(() => buildTopUpDelegation(args({ capUnits: AMOUNT })));
});

test('zero, negative and non-bigint amounts are refused; one unit is accepted', () => {
  assert.throws(() => buildTopUpDelegation(args({ amountUnits: 0n })), /positive bigint/);
  assert.throws(() => buildTopUpDelegation(args({ amountUnits: -1n })), /positive bigint/);
  assert.throws(() => buildTopUpDelegation(args({ amountUnits: 1 as unknown as bigint })), /positive bigint/);
  assert.doesNotThrow(() => buildTopUpDelegation(args({ amountUnits: 1n })));
});

test('the window: the page\'s 60-minute rule fits exactly; one second longer is refused', () => {
  const w = ruleWindow(NOT_BEFORE, TOP_UP_EXPIRY_SECONDS);
  assert.equal(w.notAfter - w.notBefore, MAX_TOP_UP_WINDOW_SECONDS);
  assert.doesNotThrow(() => buildTopUpDelegation(args(w)));
  assert.throws(() => buildTopUpDelegation(args({ ...w, notAfter: w.notAfter + 1 })), /window exceeds/);
  assert.throws(() => buildTopUpDelegation(args({ notAfter: 0 })), /positive unix seconds/);
  assert.throws(() => buildTopUpDelegation(args({ notAfter: NOT_BEFORE })), /after notBefore/);
});

test('an open delegation and a self-delegation are refused for the top-up too', () => {
  assert.throws(() => buildTopUpDelegation(args({ to: ANY_DELEGATE })), /open delegation/);
  assert.throws(() => buildTopUpDelegation(args({ to: ACCOUNT })), /must not be the granting account/);
  assert.doesNotThrow(() => buildTopUpDelegation(args()));
});
