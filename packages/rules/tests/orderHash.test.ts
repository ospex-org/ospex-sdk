import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, toBytes } from 'viem';
import { orderHash } from '../src/v3/hash.js';
import { ORDER_TYPE, ORDER_TYPES, orderDomain } from '../src/v3/typedData.js';
import { orderCase, orders, parseType, toOrder, type WireOrder } from './vectors.js';

// The order's hash, against digests the matching contract made with getOrderHash, the courier's own frozen order,
// and a reference library's digests under domains the contract cannot run.

const FIELDS = ['account', 'gameId', 'scorer', 'lineTicks', 'positionType', 'oddsTick', 'riskAmount', 'nonce', 'expiry', 'minFill'] as const;

test("every contract-made digest: orderHash gives the matching contract's getOrderHash for the same ten fields, chain and contract", () => {
  const cases = orders.cases.filter((c) => c.source === 'contract');
  assert.equal(cases.length, 29);
  for (const c of cases) assert.equal(orderHash(toOrder(c.order), c.chainId, c.matching), c.digest, c.label);
});

test("the courier's frozen chain-137 order: orderHash gives its frozen digest, and not the frozen nine-field digest without minFill", () => {
  const c = orderCase("the courier's frozen order");
  const hash = orderHash(toOrder(c.order), c.chainId, c.matching);
  assert.equal(hash, c.digest);
  assert.notEqual(hash, c.oldDigest);
});

test("each of the ten fields moved by one legal step, every check still passing, changes the digest to the contract's own for the moved order", () => {
  const base = orderCase('base');
  assert.equal(orderHash(toOrder(base.order), base.chainId, base.matching), base.digest);
  for (const field of FIELDS) {
    const c = orderCase(`step ${field}`);
    const moved = FIELDS.filter((f) => String(c.order[f as keyof WireOrder]) !== String(base.order[f as keyof WireOrder]));
    assert.deepEqual(moved, [field], `the vector for ${field} moves that field alone`);
    const hash = orderHash(toOrder(c.order), c.chainId, c.matching);
    assert.notEqual(hash, base.digest, `${field} is in the hash`);
    assert.equal(hash, c.digest, `${field}: the contract's digest`);
  }
});

test("the type string's keccak256 is the contract's type hash, as frozen in the courier's vector and as the contract returns it", () => {
  const typeHash = keccak256(toBytes(ORDER_TYPE));
  assert.equal(typeHash, orderCase("the courier's frozen order").typeHash);
  assert.equal(typeHash, orders.provenance.orderTypeHash);
});

test('orderDomain gives exactly the name "Ospex", the version "3", the chain and the matching contract', () => {
  for (const c of [orderCase('base'), orderCase("the courier's frozen order"), orderCase('base, chain 137')]) {
    assert.deepEqual(orderDomain(c.chainId, c.matching), { name: 'Ospex', version: '3', chainId: c.chainId, verifyingContract: c.matching }, c.label);
  }
});

test("ORDER_TYPES, read as its ten name and type pairs in order, is the contract's type string as frozen in the vectors", () => {
  const parsed = parseType(orders.provenance.orderType);
  assert.equal(parsed.name, 'OspexOrder');
  assert.deepEqual(Object.keys(ORDER_TYPES), ['OspexOrder']);
  assert.deepEqual(
    ORDER_TYPES.OspexOrder.map((f) => [f.name, f.type]),
    parsed.fields.map((f) => [f.name, f.type]),
  );
  assert.equal(ORDER_TYPE, orders.provenance.orderType);
});

test("another chain, or a relay in the matching contract's place, gives the reference library's digest for that domain; a domain of another name or version is never the order's hash", () => {
  const base = orderCase('base');
  const own = orderHash(toOrder(base.order), base.chainId, base.matching);
  for (const label of ['base, chain 137', 'base, the relay as verifying contract']) {
    const c = orderCase(label);
    const hash = orderHash(toOrder(c.order), c.chainId, c.matching);
    assert.equal(hash, c.digest, label);
    assert.notEqual(hash, own, label);
  }
  const others = orders.cases.filter((c) => c.notTheOrdersDomain);
  assert.equal(others.length, 2);
  for (const c of others) assert.notEqual(own, c.digest, c.label);
});
