import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as rules from '../src/index.js';
import * as bounds from '../src/v3/bounds.js';
import * as checks from '../src/v3/checks.js';
import * as hash from '../src/v3/hash.js';
import * as nonce from '../src/v3/nonce.js';
import * as sign from '../src/v3/sign.js';
import * as typedData from '../src/v3/typedData.js';

// The package's own entry, as a consumer imports it: the v3 names it exports, and the ones it keeps inside.

/** The twelve v3 runtime names the entry exports, each with the module's own value. */
const EXPORTED: Record<string, unknown> = {
  ORDER_TYPE: typedData.ORDER_TYPE,
  ORDER_TYPES: typedData.ORDER_TYPES,
  STOP_TYPES: typedData.STOP_TYPES,
  orderDomain: typedData.orderDomain,
  stopDomain: typedData.stopDomain,
  packNonce: nonce.packNonce,
  splitNonce: nonce.splitNonce,
  orderHash: hash.orderHash,
  stopDigest: hash.stopDigest,
  signOrder: sign.signOrder,
  signStop: sign.signStop,
  OrderRefused: checks.OrderRefused,
};

/** Every other runtime name of the v3 modules: the bounds, the checks and the typed-data builders. */
const INTERNAL = [
  'GRANT_BITS', 'GRANT_SHIFT', 'LOT', 'MAX_LINE_TICKS', 'MAX_ODDS_TICK', 'MAX_STOP_HASHES', 'MIN_ODDS_TICK',
  'ORDER_NUMBER_BITS', 'UINT256_LIMIT', 'VERSION_BITS', 'VERSION_SHIFT',
  'checkAddress', 'checkChainId', 'checkInteger', 'checkOrder', 'checkStopHashes', 'checkUint256', 'checkUnsigned',
  'checkedOrderDomain', 'checkedStopDomain', 'digestOf', 'orderTypedData', 'stopTypedData',
].sort();

test("the package's entry exports the twelve v3 runtime names, each the module's own, and none of the v3 modules' other names", () => {
  const entry: Record<string, unknown> = { ...rules };
  assert.equal(Object.keys(EXPORTED).length, 12);
  for (const [name, value] of Object.entries(EXPORTED)) {
    assert.ok(name in entry, `${name} is exported`);
    assert.equal(entry[name], value, `${name} is the module's own`);
  }
  const modules = [bounds, checks, hash, nonce, sign, typedData];
  const others = [...new Set(modules.flatMap((m) => Object.keys(m)))].filter((name) => !(name in EXPORTED)).sort();
  assert.deepEqual(others, INTERNAL);
  for (const name of others) assert.equal(name in entry, false, `${name} is not exported`);
});
