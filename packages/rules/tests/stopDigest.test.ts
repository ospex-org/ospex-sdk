import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopDigest } from '../src/v3/hash.js';
import { STOP_TYPES, stopDomain } from '../src/v3/typedData.js';
import { parseType, stopCase, stops } from './vectors.js';

// The stop's digest, against digests the courier made with its own stopHash, and the courier's own frozen stop.

test("every courier-made digest: stopDigest gives the courier's stopHash for the same account, hashes, chain and relay, at 137 and at 31337", () => {
  const cases = stops.cases.filter((c) => c.source === 'courier');
  assert.equal(cases.length, 12);
  assert.deepEqual([...new Set(cases.map((c) => c.chainId))].sort(), [137, 31337]);
  for (const c of cases) assert.equal(stopDigest(c.account, c.orderHashes, c.chainId, c.relay), c.digest, c.label);
  assert.equal(stopCase('one hash, chain 137').orderHashes.length, 1);
  assert.equal(stopCase('a hundred hashes, chain 137').orderHashes.length, 100);
});

test("the courier's frozen stop: its digest, its digest on chain 31337, and its digest with one hash changed", () => {
  for (const label of ["the courier's frozen stop", "the courier's frozen stop, chain 31337", "the courier's frozen stop, a hash changed"]) {
    const c = stopCase(label);
    assert.equal(stopDigest(c.account, c.orderHashes, c.chainId, c.relay), c.digest, label);
  }
});

test("two orders of the same hashes give two digests, each the courier's own for that order", () => {
  for (const chainId of [137, 31337]) {
    const a = stopCase(`three hashes, chain ${chainId}`);
    const b = stopCase(`the same three, reordered, chain ${chainId}`);
    assert.deepEqual([...a.orderHashes].sort(), [...b.orderHashes].sort());
    assert.notDeepEqual(a.orderHashes, b.orderHashes);
    const digestA = stopDigest(a.account, a.orderHashes, a.chainId, a.relay);
    const digestB = stopDigest(b.account, b.orderHashes, b.chainId, b.relay);
    assert.equal(digestA, a.digest, a.label);
    assert.equal(digestB, b.digest, b.label);
    assert.notEqual(digestA, digestB);
  }
});

test('stopDomain gives exactly the name "Ospex Courier", the version "1", the chain and the relay', () => {
  for (const c of [stopCase('one hash, chain 137'), stopCase('another relay, chain 31337'), stopCase("the courier's frozen stop")]) {
    assert.deepEqual(stopDomain(c.chainId, c.relay), { name: 'Ospex Courier', version: '1', chainId: c.chainId, verifyingContract: c.relay }, c.label);
  }
});

test("STOP_TYPES is the courier's stop type: the account, then the order hashes", () => {
  const parsed = parseType(stops.provenance.stopType);
  assert.equal(parsed.name, 'OspexStop');
  assert.deepEqual(Object.keys(STOP_TYPES), ['OspexStop']);
  assert.deepEqual(
    STOP_TYPES.OspexStop.map((f) => [f.name, f.type]),
    parsed.fields.map((f) => [f.name, f.type]),
  );
});

test("the stop's two fields under the order's domain are not the stop's digest", () => {
  const frozen = stopCase("the courier's frozen stop");
  const underTheOrders = stops.cases.find((c) => c.notTheStopsDomain);
  assert.ok(underTheOrders);
  assert.notEqual(stopDigest(frozen.account, frozen.orderHashes, frozen.chainId, frozen.relay), underTheOrders.digest);
});
