import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MATCH_COMMITMENT_SELECTOR } from '../src/protocol.js';

// Frozen from two sources that do not share code with src/protocol.ts:
// the contracts repo's forge build artifact (`methodIdentifiers` for
// matchCommitment((address,uint256,address,int32,uint8,uint16,uint256,uint256,uint256),bytes,uint256))
// and `cast sig` on the same signature. Both gave 8ae4b105.
const GOLDEN_MATCH_COMMITMENT_SELECTOR = '0x8ae4b105';

test('the delegation selector is the one the deployed contract dispatches on', () => {
  assert.equal(MATCH_COMMITMENT_SELECTOR, GOLDEN_MATCH_COMMITMENT_SELECTOR);
});
