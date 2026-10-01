import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { type Address, type Hex } from 'viem';
import {
  ANY_DELEGATE,
  BET_EXPIRY_SECONDS,
  CLOCK_SKEW_SECONDS,
  MAX_DELEGATION_SECONDS,
  buildBetDelegation,
  ruleWindow,
  type BetDelegationArgs,
} from '../src/delegation.js';
import { MATCHING_MODULE, MATCH_COMMITMENT_SELECTOR } from '../src/protocol.js';

const environment = getSmartAccountsEnvironment(137);

// Two arbitrary, distinct addresses. Not keys, not wallets.
const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const WORKER: Address = '0x2222222222222222222222222222222222222222';
// A round number is the wrong fixture for a boundary test, so pick odd ones.
const NOT_BEFORE = 1_790_000_137;
const NOT_AFTER = NOT_BEFORE + 86_400 + 41;

function args(over: Partial<BetDelegationArgs> = {}): BetDelegationArgs {
  return { environment, from: ACCOUNT, to: WORKER, notBefore: NOT_BEFORE, notAfter: NOT_AFTER, ...over };
}

function enforcer(name: string): Hex {
  const address = environment.caveatEnforcers[name];
  assert.ok(address, `environment has no ${name}`);
  return address;
}

// Terms layouts are read from the enforcer contracts themselves, not from the
// Kit's encoder: targets are packed 20-byte addresses, methods packed 4-byte
// selectors, valueLte one uint256, timestamp is (uint128 after, uint128 before).
const strip = (hex: Hex): string => hex.slice(2).toLowerCase();

function caveatFor(delegation: ReturnType<typeof buildBetDelegation>, name: string) {
  const matches = delegation.caveats.filter((c) => c.enforcer.toLowerCase() === enforcer(name).toLowerCase());
  assert.equal(matches.length, 1, `expected exactly one ${name} caveat, got ${matches.length}`);
  const [only] = matches;
  assert.ok(only);
  return only;
}

test('the delegation permits MatchingModule.matchCommitment for the worker, from the account', () => {
  const d = buildBetDelegation(args());
  assert.equal(d.delegator.toLowerCase(), ACCOUNT);
  assert.equal(d.delegate.toLowerCase(), WORKER);
  // A root delegation (no parent) carries the all-ones authority.
  assert.equal(d.authority, `0x${'f'.repeat(64)}`);
  // Unsigned: signing is a separate, deliberate step.
  assert.equal(d.signature, '0x');

  assert.equal(strip(caveatFor(d, 'AllowedTargetsEnforcer').terms), strip(MATCHING_MODULE));
  assert.equal(strip(caveatFor(d, 'AllowedMethodsEnforcer').terms), strip(MATCH_COMMITMENT_SELECTOR));
  assert.equal(strip(caveatFor(d, 'ValueLteEnforcer').terms), '0'.repeat(64));
});

test('the expiry lands in the timestamp caveat as (after, before) and nothing widens it', () => {
  const d = buildBetDelegation(args());
  const terms = strip(caveatFor(d, 'TimestampEnforcer').terms);
  assert.equal(terms.length, 64);
  assert.equal(BigInt(`0x${terms.slice(0, 32)}`), BigInt(NOT_BEFORE));
  assert.equal(BigInt(`0x${terms.slice(32)}`), BigInt(NOT_AFTER));
});

test('the caveat set is exactly the four enforcers, so nothing else was granted', () => {
  const d = buildBetDelegation(args());
  const got = d.caveats.map((c) => c.enforcer.toLowerCase()).sort();
  const want = ['AllowedTargetsEnforcer', 'AllowedMethodsEnforcer', 'ValueLteEnforcer', 'TimestampEnforcer']
    .map((n) => enforcer(n).toLowerCase())
    .sort();
  assert.deepEqual(got, want);
});

// Each refusal is paired with an acceptance a hair away, so a builder that
// refuses everything cannot pass.
test('a window of exactly ninety days is accepted; one second more is refused', () => {
  assert.equal(MAX_DELEGATION_SECONDS, 90 * 86_400);
  assert.doesNotThrow(() => buildBetDelegation(args({ notAfter: NOT_BEFORE + MAX_DELEGATION_SECONDS })));
  assert.throws(
    () => buildBetDelegation(args({ notAfter: NOT_BEFORE + MAX_DELEGATION_SECONDS + 1 })),
    /window exceeds/,
  );
});

test('the bet permission the page signs lasts thirty days, inside the ceiling', () => {
  assert.equal(BET_EXPIRY_SECONDS, 30 * 86_400);
  const w = ruleWindow(NOT_BEFORE, BET_EXPIRY_SECONDS);
  assert.equal(w.notAfter - w.notBefore, 30 * 86_400 + CLOCK_SKEW_SECONDS);
  assert.doesNotThrow(() => buildBetDelegation(args(w)));
});

test('a zero or missing expiry is refused, because the enforcer reads zero as "never expires"', () => {
  assert.throws(() => buildBetDelegation(args({ notAfter: 0 })), /positive unix seconds/);
  assert.throws(() => buildBetDelegation(args({ notBefore: 0 })), /positive unix seconds/);
  assert.throws(() => buildBetDelegation(args({ notAfter: Number.NaN })), /positive unix seconds/);
  assert.throws(() => buildBetDelegation(args({ notAfter: NOT_AFTER + 0.5 })), /positive unix seconds/);
  assert.throws(() => buildBetDelegation(args({ notBefore: Number.NaN })), /positive unix seconds/);
  assert.throws(() => buildBetDelegation(args({ notBefore: NOT_BEFORE + 0.5 })), /positive unix seconds/);
  assert.doesNotThrow(() => buildBetDelegation(args({ notAfter: NOT_BEFORE + 1 })));
});

test('an inverted window is refused; the smallest valid window is accepted', () => {
  assert.throws(() => buildBetDelegation(args({ notAfter: NOT_BEFORE })), /after notBefore/);
  assert.throws(() => buildBetDelegation(args({ notAfter: NOT_BEFORE - 1 })), /after notBefore/);
  assert.doesNotThrow(() => buildBetDelegation(args({ notAfter: NOT_BEFORE + 1 })));
});

test('an open delegation and a self-delegation are refused; a distinct delegate is accepted', () => {
  assert.throws(() => buildBetDelegation(args({ to: ANY_DELEGATE })), /open delegation/);
  assert.throws(() => buildBetDelegation(args({ to: ACCOUNT })), /must not be the granting account/);
  assert.doesNotThrow(() => buildBetDelegation(args()));
});
