import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverAddress, type Address, type Hex } from 'viem';
import { orderHash, stopDigest } from '../src/v3/hash.js';
import { signOrder, signStop } from '../src/v3/sign.js';
import { orderDomain, stopDomain } from '../src/v3/typedData.js';
import type { OspexOrder, TypedDataSigner } from '../src/v3/types.js';
import { fixtureAddress, fixtureSigner, orderCase, refused, stopCase, toOrder } from './vectors.js';

// Every input of every public function, at its bounds: a legal base input with one field changed and every other
// predicate true. The accepted value at the bound, then the refused value one step past it, which names the function,
// the field and the value. An accepted order is checked against the contract's digest where one is frozen.

const KEY_1 = 'ospex-rules fixture key 1';
const UINT256_MAX = 2n ** 256n - 1n;
const LARGEST_LOT = 2n ** 256n - 36n;
const SAFE_MAX = Number.MAX_SAFE_INTEGER;

const base = orderCase('base');
const baseOrder = toOrder(base.order);
const withField = (field: string, value: unknown): OspexOrder => ({ ...baseOrder, [field]: value }) as unknown as OspexOrder;

/** A signer that counts its calls: an input refused before signing never reaches it. */
function countingSigner(): TypedDataSigner & { count: number } {
  const inner = fixtureSigner(KEY_1);
  const counter = {
    address: inner.address,
    count: 0,
    signTypedData: (args: Parameters<TypedDataSigner['signTypedData']>[0]) => {
      counter.count++;
      return inner.signTypedData(args);
    },
  };
  return counter;
}

/**
 * More refusals of an address field: 42 characters with one not hex, and two values that are not strings (the
 * address as a bigint, and none), each naming the value as the refusal gives it.
 */
const notAnAddress = (a: string): Array<[unknown, string]> => [
  [`${a.slice(0, 41)}g`, `${a.slice(0, 41)}g`],
  [BigInt(a), BigInt(a).toString()],
  [undefined, 'undefined'],
];

/** Text of an address in one case throughout, or with one letter's case flipped so its checksum fails. */
const lower = (a: string) => `0x${a.slice(2).toLowerCase()}`;
const upper = (a: string) => `0x${a.slice(2).toUpperCase()}`;
function badChecksum(a: string): string {
  const i = [...a].findIndex((ch, k) => k > 1 && /[a-fA-F]/.test(ch));
  const ch = a[i] as string;
  const flipped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
  const bad = a.slice(0, i) + flipped + a.slice(i + 1);
  const digits = bad.slice(2);
  assert.ok(digits !== digits.toLowerCase() && digits !== digits.toUpperCase(), 'still mixed case');
  return bad;
}

interface Row {
  field: string;
  /** accepted values, each with the label of the order case whose contract digest it must give */
  accepted: Array<[unknown, string]>;
  /** refused values, each with the text the refusal names */
  refusedValues: Array<[unknown, string]>;
}

const A = fixtureAddress(KEY_1);
const OTHER_MIXED = '0x38a95b8689e4a87FB9ceeBEdB159bcDFcdd343f3';

const ORDER_ROWS: Row[] = [
  { field: 'gameId', accepted: [[0n, 'gameId 0'], [UINT256_MAX, 'gameId max']], refusedValues: [[-1n, '-1'], [2n ** 256n, (2n ** 256n).toString()]] },
  { field: 'expiry', accepted: [[0n, 'expiry 0'], [UINT256_MAX, 'expiry max']], refusedValues: [[-1n, '-1'], [2n ** 256n, (2n ** 256n).toString()]] },
  { field: 'nonce', accepted: [[0n, 'nonce 0'], [UINT256_MAX, 'nonce max']], refusedValues: [[-1n, '-1'], [2n ** 256n, (2n ** 256n).toString()]] },
  {
    field: 'riskAmount',
    accepted: [[100n, 'riskAmount 100'], [LARGEST_LOT, 'riskAmount largest lot']],
    refusedValues: [
      [0n, '0'], [150n, '150'], [-100n, '-100'], [LARGEST_LOT + 100n, (LARGEST_LOT + 100n).toString()],
      [99n, '99'], [101n, '101'],
      [LARGEST_LOT + 1n, (LARGEST_LOT + 1n).toString()], [UINT256_MAX, UINT256_MAX.toString()], [2n ** 256n, (2n ** 256n).toString()],
    ],
  },
  { field: 'minFill', accepted: [[0n, 'base'], [25_000n, 'minFill equal to riskAmount']], refusedValues: [[25_001n, '25001'], [-1n, '-1']] },
  {
    field: 'lineTicks',
    accepted: [[-1_000_000, 'lineTicks -1000000'], [0, 'lineTicks 0'], [1_000_000, 'lineTicks 1000000']],
    refusedValues: [[-1_000_001, '-1000001'], [1_000_001, '1000001'], [0.5, '0.5']],
  },
  { field: 'positionType', accepted: [[0, 'base'], [1, 'step positionType']], refusedValues: [[-1, '-1'], [2, '2']] },
  { field: 'oddsTick', accepted: [[101, 'oddsTick 101'], [10_100, 'oddsTick 10100']], refusedValues: [[100, '100'], [10_101, '10101']] },
  {
    field: 'account',
    accepted: [[lower(A), 'base'], [A, 'base'], [upper(A), 'base']],
    refusedValues: [[badChecksum(A), badChecksum(A)], [A.slice(0, 41), A.slice(0, 41)], [`${A}0`, `${A}0`], [A.slice(2), A.slice(2)], ...notAnAddress(A)],
  },
  {
    field: 'scorer',
    accepted: [[lower(baseOrder.scorer), 'base'], [baseOrder.scorer, 'base'], [upper(baseOrder.scorer), 'base']],
    refusedValues: [[badChecksum(OTHER_MIXED), badChecksum(OTHER_MIXED)], [baseOrder.scorer.slice(0, 41), baseOrder.scorer.slice(0, 41)], [`${baseOrder.scorer}0`, `${baseOrder.scorer}0`], [baseOrder.scorer.slice(2), baseOrder.scorer.slice(2)], ...notAnAddress(baseOrder.scorer)],
  },
  // the types: a number where a bigint is due, a bigint where a number is due, never coerced
  { field: 'gameId', accepted: [[7n, 'base']], refusedValues: [[7, '7']] },
  { field: 'riskAmount', accepted: [[25_000n, 'base']], refusedValues: [[25_000, '25000']] },
  { field: 'nonce', accepted: [[1n, 'base']], refusedValues: [[1, '1']] },
  { field: 'expiry', accepted: [[1_900_000_000n, 'base']], refusedValues: [[1_900_000_000, '1900000000']] },
  { field: 'minFill', accepted: [[0n, 'base']], refusedValues: [[0, '0']] },
  { field: 'lineTicks', accepted: [[-35, 'base']], refusedValues: [[-35n, '-35']] },
  { field: 'positionType', accepted: [[0, 'base']], refusedValues: [[0n, '0']] },
  { field: 'oddsTick', accepted: [[191, 'base']], refusedValues: [[191n, '191']] },
];

test('orderHash, every order field at its bounds: the accepted value gives the contract\'s digest; one step past is refused, naming orderHash, the field and the value', () => {
  for (const row of ORDER_ROWS) {
    for (const [value, label] of row.accepted) {
      const c = orderCase(label);
      assert.equal(orderHash(withField(row.field, value), base.chainId, base.matching), c.digest, `${row.field} ${String(value)}`);
    }
    for (const [value, text] of row.refusedValues) {
      assert.throws(() => orderHash(withField(row.field, value), base.chainId, base.matching), refused('orderHash', row.field, text), `${row.field} ${String(value)}`);
    }
  }
});

test('signOrder, every order field at its bounds: the accepted value is signed and recovers over the contract\'s digest; one step past is refused before the signer is called', async () => {
  for (const row of ORDER_ROWS) {
    for (const [value, label] of row.accepted) {
      const c = orderCase(label);
      const signature = await signOrder(withField(row.field, value), base.chainId, base.matching, fixtureSigner(KEY_1));
      assert.equal(await recoverAddress({ hash: c.digest, signature }), A, `${row.field} ${String(value)}`);
    }
    for (const [value, text] of row.refusedValues) {
      const signer = countingSigner();
      await assert.rejects(signOrder(withField(row.field, value), base.chainId, base.matching, signer), refused('signOrder', row.field, text), `${row.field} ${String(value)}`);
      assert.equal(signer.count, 0, `${row.field} ${String(value)}: the signer was not called`);
    }
  }
});

test('an order that is not an object is refused before hashing, at its first field', () => {
  assert.throws(() => orderHash(null as unknown as OspexOrder, base.chainId, base.matching), refused('orderHash', 'account', 'undefined'));
});

test('signOrder: an order that is not an object is refused at its first field, before the signer is called', async () => {
  const signer = countingSigner();
  await assert.rejects(signOrder(null as unknown as OspexOrder, base.chainId, base.matching, signer), refused('signOrder', 'account', 'undefined'));
  assert.equal(signer.count, 0);
});

/** The chain id and the contract's address, for the four functions that take them. */
const CHAIN_IDS: { accepted: number[]; refusedValues: Array<[unknown, string]> } = {
  accepted: [1, SAFE_MAX],
  refusedValues: [[0, '0'], [-1, '-1'], [2 ** 53, '9007199254740992'], [137n, '137'], [1.5, '1.5']],
};
const contractForms = (a: string) => ({
  accepted: [lower(a), a, upper(a)],
  refusedValues: [[badChecksum(OTHER_MIXED), badChecksum(OTHER_MIXED)], [a.slice(0, 41), a.slice(0, 41)], [`${a}0`, `${a}0`], [a.slice(2), a.slice(2)], ...notAnAddress(a)] as Array<[unknown, string]>,
});

test('orderHash and signOrder, the chain id and the matching contract at their bounds', async () => {
  const signedAt = async (chainId: unknown, matching: unknown) => signOrder(baseOrder, chainId as number, matching as Address, fixtureSigner(KEY_1));
  for (const chainId of CHAIN_IDS.accepted) {
    assert.match(orderHash(baseOrder, chainId, base.matching), /^0x[0-9a-f]{64}$/);
    assert.match(await signedAt(chainId, base.matching), /^0x[0-9a-f]{128}(1b|1c)$/);
  }
  for (const [chainId, text] of CHAIN_IDS.refusedValues) {
    assert.throws(() => orderHash(baseOrder, chainId as number, base.matching), refused('orderHash', 'chainId', text));
    const signer = countingSigner();
    await assert.rejects(signOrder(baseOrder, chainId as number, base.matching, signer), refused('signOrder', 'chainId', text));
    assert.equal(signer.count, 0);
  }
  const forms = contractForms(base.matching);
  for (const matching of forms.accepted) {
    assert.equal(orderHash(baseOrder, base.chainId, matching as Address), base.digest, matching);
    assert.equal(await recoverAddress({ hash: base.digest, signature: await signedAt(base.chainId, matching) }), A, matching);
  }
  for (const [matching, text] of forms.refusedValues) {
    assert.throws(() => orderHash(baseOrder, base.chainId, matching as Address), refused('orderHash', 'matching', text));
    const signer = countingSigner();
    await assert.rejects(signOrder(baseOrder, base.chainId, matching as Address, signer), refused('signOrder', 'matching', text));
    assert.equal(signer.count, 0);
  }
});

test('orderDomain and stopDomain, the chain id and the contract at their bounds', () => {
  const one = stopCase('one hash, chain 137');
  for (const chainId of CHAIN_IDS.accepted) {
    assert.equal(orderDomain(chainId, base.matching).chainId, chainId);
    assert.equal(stopDomain(chainId, one.relay).chainId, chainId);
  }
  for (const [chainId, text] of CHAIN_IDS.refusedValues) {
    assert.throws(() => orderDomain(chainId as number, base.matching), refused('orderDomain', 'chainId', text));
    assert.throws(() => stopDomain(chainId as number, one.relay), refused('stopDomain', 'chainId', text));
  }
  for (const [fn, contract, field] of [['orderDomain', base.matching, 'matching'], ['stopDomain', one.relay, 'relay']] as const) {
    const forms = contractForms(contract);
    const call = (a: unknown) => (fn === 'orderDomain' ? orderDomain(1, a as Address) : stopDomain(1, a as Address));
    for (const a of forms.accepted) assert.equal(call(a).verifyingContract, contract, `${fn} ${a}`);
    for (const [a, text] of forms.refusedValues) assert.throws(() => call(a), refused(fn, field, text), `${fn} ${a}`);
  }
});

// ── the stop ────────────────────────────────────────────────────────────────────────────────────────────────

const one = stopCase('one hash, chain 137');
const hundred = stopCase('a hundred hashes, chain 137');
const hash = one.orderHashes[0] as Hex;
const hundredAndOne = [...hundred.orderHashes, hash];
const upperHash = `0x${hash.slice(2).toUpperCase()}`;

interface StopRow {
  field: 'account' | 'orderHashes' | 'chainId' | 'relay';
  accepted: Array<[unknown, string]>;
  refusedValues: Array<[unknown, string]>;
}
const STOP_ROWS: StopRow[] = [
  {
    field: 'account',
    accepted: [[lower(one.account), 'one hash, chain 137'], [one.account, 'one hash, chain 137'], [upper(one.account), 'one hash, chain 137']],
    refusedValues: [[badChecksum(one.account), badChecksum(one.account)], [one.account.slice(0, 41), one.account.slice(0, 41)], [`${one.account}0`, `${one.account}0`], [one.account.slice(2), one.account.slice(2)], ...notAnAddress(one.account)],
  },
  {
    field: 'orderHashes',
    accepted: [[one.orderHashes, 'one hash, chain 137'], [hundred.orderHashes, 'a hundred hashes, chain 137'], [[upperHash], 'one hash, chain 137']],
    refusedValues: [
      [[], '0'], [hundredAndOne, '101'], [[hash, hash], hash], [[hash, upperHash], upperHash], [[hash.slice(0, 65)], hash.slice(0, 65)], [hash, hash],
      [[`${hash}0`], `${hash}0`], [[hash.slice(2)], hash.slice(2)], [[`0x${'z'.repeat(64)}`], `0x${'z'.repeat(64)}`], [[123], '123'],
    ],
  },
  { field: 'chainId', accepted: [[137, 'one hash, chain 137'], [31337, 'one hash, chain 31337']], refusedValues: CHAIN_IDS.refusedValues },
  {
    field: 'relay',
    accepted: [[lower(one.relay), 'one hash, chain 137'], [one.relay, 'one hash, chain 137'], [upper(one.relay), 'one hash, chain 137']],
    refusedValues: contractForms(one.relay).refusedValues,
  },
];

function stopArgs(field: StopRow['field'], value: unknown): [Address, Hex[], number, Address] {
  const args: Record<string, unknown> = { account: one.account, orderHashes: one.orderHashes, chainId: one.chainId, relay: one.relay, [field]: value };
  if (field === 'orderHashes' && value === hundred.orderHashes) args['account'] = hundred.account;
  return [args['account'] as Address, args['orderHashes'] as Hex[], args['chainId'] as number, args['relay'] as Address];
}

test("stopDigest, every input at its bounds: the accepted value gives the courier's digest; one step past is refused, naming stopDigest, the field and the value", () => {
  for (const row of STOP_ROWS) {
    for (const [value, label] of row.accepted) assert.equal(stopDigest(...stopArgs(row.field, value)), stopCase(label).digest, `${row.field} ${String(value).slice(0, 70)}`);
    for (const [value, text] of row.refusedValues) assert.throws(() => stopDigest(...stopArgs(row.field, value)), refused('stopDigest', row.field, text), `${row.field} ${String(value).slice(0, 70)}`);
  }
  for (const chainId of CHAIN_IDS.accepted) assert.match(stopDigest(one.account, one.orderHashes, chainId, one.relay), /^0x[0-9a-f]{64}$/);
});

test("signStop, every input at its bounds: the accepted value is signed and recovers over the courier's digest; one step past is refused before the signer is called", async () => {
  for (const row of STOP_ROWS) {
    for (const [value, label] of row.accepted) {
      const signature = await signStop(...stopArgs(row.field, value), fixtureSigner(KEY_1));
      assert.equal(await recoverAddress({ hash: stopCase(label).digest, signature }), A, `${row.field} ${String(value).slice(0, 70)}`);
    }
    for (const [value, text] of row.refusedValues) {
      const signer = countingSigner();
      await assert.rejects(signStop(...stopArgs(row.field, value), signer), refused('signStop', row.field, text), `${row.field} ${String(value).slice(0, 70)}`);
      assert.equal(signer.count, 0);
    }
  }
  for (const chainId of CHAIN_IDS.accepted) {
    assert.match(await signStop(one.account, one.orderHashes, chainId, one.relay, fixtureSigner(KEY_1)), /^0x[0-9a-f]{128}(1b|1c)$/);
  }
});
