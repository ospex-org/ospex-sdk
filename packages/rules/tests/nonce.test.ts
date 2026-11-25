import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packNonce, splitNonce } from '../src/v3/nonce.js';
import { orders, refused } from './vectors.js';

// The nonce's packing: the version (128 bits), the grant (32 bits) and the order number (96 bits), high to low.
// Expected nonces are the frozen orders' own, whose parts the courier's test support packed, and literals written
// out here.

const VERSION_MAX = 2n ** 128n - 1n;
const GRANT_MAX = 2 ** 32 - 1;
const ORDER_NUMBER_MAX = 2n ** 96n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

test("every frozen order's nonce is its three parts packed, and splits back into them", () => {
  const withParts = orders.cases.filter((c) => c.nonceParts);
  assert.equal(withParts.length, 29);
  for (const c of withParts) {
    const parts = c.nonceParts;
    assert.ok(parts);
    const expected = { version: BigInt(parts.version), grant: parts.grant, orderNumber: BigInt(parts.orderNumber) };
    assert.equal(packNonce(expected.version, expected.grant, expected.orderNumber), BigInt(c.order.nonce), c.label);
    assert.deepEqual(splitNonce(BigInt(c.order.nonce)), expected, c.label);
  }
});

test('packNonce, each part at its bounds: accepted at 0 and at its maximum, each in its own bits; one past, or negative, or of the wrong type, refused', () => {
  assert.equal(packNonce(0n, 0, 0n), 0n);
  assert.equal(packNonce(VERSION_MAX, 0, 0n), 0xffffffffffffffffffffffffffffffff00000000000000000000000000000000n);
  assert.equal(packNonce(0n, GRANT_MAX, 0n), 0x00000000000000000000000000000000ffffffff000000000000000000000000n);
  assert.equal(packNonce(0n, 0, ORDER_NUMBER_MAX), 0x0000000000000000000000000000000000000000ffffffffffffffffffffffffn);
  assert.equal(packNonce(VERSION_MAX, GRANT_MAX, ORDER_NUMBER_MAX), UINT256_MAX);

  assert.throws(() => packNonce(2n ** 128n, 0, 0n), refused('packNonce', 'version', (2n ** 128n).toString()));
  assert.throws(() => packNonce(-1n, 0, 0n), refused('packNonce', 'version', '-1'));
  assert.throws(() => packNonce(0 as unknown as bigint, 0, 0n), refused('packNonce', 'version', '0'));
  assert.throws(() => packNonce(0n, 2 ** 32, 0n), refused('packNonce', 'grant', '4294967296'), 'a grant of 2^32 would spill into the version');
  assert.throws(() => packNonce(0n, -1, 0n), refused('packNonce', 'grant', '-1'));
  assert.throws(() => packNonce(0n, 3n as unknown as number, 0n), refused('packNonce', 'grant', '3'));
  assert.throws(() => packNonce(0n, 1.5, 0n), refused('packNonce', 'grant', '1.5'));
  assert.throws(() => packNonce(0n, 0, 2n ** 96n), refused('packNonce', 'orderNumber', (2n ** 96n).toString()), 'an order number of 2^96 would spill into the grant');
  assert.throws(() => packNonce(0n, 0, -1n), refused('packNonce', 'orderNumber', '-1'));
  assert.throws(() => packNonce(0n, 0, 1 as unknown as bigint), refused('packNonce', 'orderNumber', '1'));
});

test('splitNonce: accepted at 0 and at 2^256 - 1; -1, 2^256 and a number refused', () => {
  assert.deepEqual(splitNonce(0n), { version: 0n, grant: 0, orderNumber: 0n });
  assert.deepEqual(splitNonce(UINT256_MAX), { version: VERSION_MAX, grant: GRANT_MAX, orderNumber: ORDER_NUMBER_MAX });
  assert.throws(() => splitNonce(-1n), refused('splitNonce', 'nonce', '-1'));
  assert.throws(() => splitNonce(2n ** 256n), refused('splitNonce', 'nonce', (2n ** 256n).toString()));
  assert.throws(() => splitNonce(1 as unknown as bigint), refused('splitNonce', 'nonce', '1'));
});
