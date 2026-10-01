import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUsdc } from '../src/usdc.js';

const CAP = 2_000_000n;

test('USDC amounts parse exactly: six decimals at most, above zero, at most the cap', () => {
  assert.equal(parseUsdc('1', CAP), 1_000_000n);
  assert.equal(parseUsdc('0.000001', CAP), 1n);
  assert.equal(parseUsdc('1.5', CAP), 1_500_000n);
  assert.equal(parseUsdc('2', CAP), 2_000_000n);
  assert.throws(() => parseUsdc('2.000001', CAP), /above the cap of 2 USDC/);
  assert.throws(() => parseUsdc('0', CAP), /more than zero/);
  assert.throws(() => parseUsdc('1.0000001', CAP), /not a USDC amount/);
  for (const bad of ['', '-1', 'abc', '1e6', '01', '1.', '.5', '1,5']) {
    assert.throws(() => parseUsdc(bad, CAP), /not a USDC amount/, bad);
  }
});

test('the cap is the caller\'s, and a missing one is refused rather than read as no cap', () => {
  // Two caps, so a parser that ignored the argument and kept a constant fails one of them.
  assert.equal(parseUsdc('100', 100_000_000n), 100_000_000n);
  assert.throws(() => parseUsdc('100.000001', 100_000_000n), /above the cap of 100 USDC/);
  assert.throws(() => parseUsdc('1', undefined as unknown as bigint), /cap must be a positive bigint/);
  assert.throws(() => parseUsdc('1', 0n), /cap must be a positive bigint/);
  assert.throws(() => parseUsdc('1', 100_000_000 as unknown as bigint), /cap must be a positive bigint/);
});
