import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverAddress, type Hex } from 'viem';
import { signOrder, signStop } from '../src/v3/sign.js';
import type { TypedDataSigner } from '../src/v3/types.js';
import {
  fixtureAddress,
  fixtureSigner,
  orderCase,
  orders,
  parseType,
  refused,
  signatureCase,
  signatures,
  stopCase,
  stops,
  stubSigner,
  toOrder,
  type SignatureCase,
} from './vectors.js';

// The two signers, from the caller's side: what they hand a signer, and what they return. Each signature a stub
// returns is a frozen one, made by a reference signer the package does not use; the tests never sign to make an
// expected value.

const KEY_1 = 'ospex-rules fixture key 1';
const KEY_2 = 'ospex-rules fixture key 2';
const KEY_3 = 'ospex-rules fixture key 3';
/** Half the secp256k1 curve's order, written out. */
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Signs the order or the stop a frozen signature case names, with the given signer. */
function signFor(kind: 'order' | 'stop', label: string, signer: TypedDataSigner): Promise<Hex> {
  if (kind === 'order') {
    const o = orderCase(label);
    return signOrder(toOrder(o.order), o.chainId, o.matching, signer);
  }
  const s = stopCase(label);
  return signStop(s.account, s.orderHashes, s.chainId, s.relay, signer);
}

const targetOf = (c: SignatureCase): { kind: 'order' | 'stop'; label: string } => {
  const kind = c.kind === 'order' || c.kind === 'stop' ? c.kind : c.signsKind;
  assert.ok(kind && c.signs, `${c.label} names what it signs`);
  return { kind, label: c.signs };
};

const grantOf = (nonce: string): number => Number((BigInt(nonce) >> 96n) & 0xffffffffn);

// ── what the signer is handed ─────────────────────────────────────────────────────────────────────────────

test("signOrder hands the signer only the order's domain, primary type, types and fields, once; signStop only the stop's; each returns the signature", async () => {
  const orderSig = signatureCase(`base, signed by ${KEY_1}`);
  const o = orderCase('base');
  const orderStub = stubSigner(fixtureAddress(KEY_1), orderSig.signature);
  assert.equal(await signOrder(toOrder(o.order), o.chainId, o.matching, orderStub), orderSig.signature);
  assert.equal(orderStub.calls.length, 1);
  const orderArgs = orderStub.calls[0];
  assert.ok(orderArgs);
  assert.deepEqual(orderArgs.domain, { name: 'Ospex', version: '3', chainId: o.chainId, verifyingContract: o.matching });
  assert.equal(orderArgs.primaryType, 'OspexOrder');
  assert.deepEqual(orderArgs.types, { OspexOrder: parseType(orders.provenance.orderType).fields });
  assert.deepEqual(orderArgs.message, toOrder(o.order));

  const stopSig = signatureCase(`one hash, chain 137, signed by ${KEY_1}`);
  const s = stopCase('one hash, chain 137');
  const stopStub = stubSigner(fixtureAddress(KEY_1), stopSig.signature);
  assert.equal(await signStop(s.account, s.orderHashes, s.chainId, s.relay, stopStub), stopSig.signature);
  assert.equal(stopStub.calls.length, 1);
  const stopArgs = stopStub.calls[0];
  assert.ok(stopArgs);
  assert.deepEqual(stopArgs.domain, { name: 'Ospex Courier', version: '1', chainId: s.chainId, verifyingContract: s.relay });
  assert.equal(stopArgs.primaryType, 'OspexStop');
  assert.deepEqual(stopArgs.types, { OspexStop: parseType(stops.provenance.stopType).fields });
  assert.deepEqual(stopArgs.message, { account: s.account, orderHashes: s.orderHashes });
});

test("an order's signature read as a stop's, over a stop digest of the same account, recovers to another address, and signStop refuses it", async () => {
  const crossed = signatureCase(`base, signed by ${KEY_1}, read as a stop`);
  assert.ok(crossed.recovered && crossed.stop);
  assert.equal(await recoverAddress({ hash: crossed.digest, signature: crossed.signature }), crossed.recovered);
  assert.notEqual(crossed.recovered, fixtureAddress(KEY_1));
  const s = stopCase(crossed.stop);
  await assert.rejects(
    signStop(s.account, s.orderHashes, s.chainId, s.relay, stubSigner(fixtureAddress(KEY_1), crossed.signature)),
    refused('signStop', 'signature.recovered', crossed.recovered),
  );
});

// ── the signature's form ───────────────────────────────────────────────────────────────────────────────

/** Reference signatures with v 27 and with v 28, of an order and of a stop, each by the address it declares. */
const FORM_CASES = [
  signatureCase(`base, signed by ${KEY_1}`),
  signatureCase(`step account, signed by ${KEY_2}`),
  signatureCase(`one hash, chain 137, signed by ${KEY_1}`),
  signatureCase(`one hash, chain 137, signed by ${KEY_3}`),
];

test('the reference signatures for the form cases carry v 27 and v 28, for an order and for a stop', () => {
  const vOf = (c: SignatureCase) => Number.parseInt(c.signature.slice(130), 16);
  assert.deepEqual(FORM_CASES.map(vOf), [27, 28, 27, 28]);
});

test('a signature with v 27 or 28 is kept, its bytes the reference\'s; with v 0 or 1 it is rewritten to 27 or 28, the reference\'s bytes', async () => {
  for (const c of FORM_CASES) {
    const { kind, label } = targetOf(c);
    assert.ok(c.signer);
    assert.equal(await signFor(kind, label, stubSigner(c.signer, c.signature)), c.signature, `${c.label}: kept`);
    const parity = Number.parseInt(c.signature.slice(130), 16) - 27;
    const low = `${c.signature.slice(0, 130)}0${parity}`;
    assert.equal(await signFor(kind, label, stubSigner(c.signer, low)), c.signature, `${c.label}: v ${parity} rewritten`);
  }
});

test('a signature with v 26, 29 or 35 is refused, naming signature.v and the v', async () => {
  for (const c of FORM_CASES) {
    const { kind, label } = targetOf(c);
    assert.ok(c.signer);
    for (const v of [26, 29, 35]) {
      const bad = `${c.signature.slice(0, 130)}${v.toString(16)}`;
      await assert.rejects(signFor(kind, label, stubSigner(c.signer, bad)), refused(kind === 'order' ? 'signOrder' : 'signStop', 'signature.v', String(v)), `${c.label}: v ${v}`);
    }
  }
});

test('a signature of 64 or 66 bytes, or with a character that is not hex, is refused, naming signature.length and its length in characters', async () => {
  for (const c of FORM_CASES) {
    const { kind, label } = targetOf(c);
    assert.ok(c.signer);
    const fn = kind === 'order' ? 'signOrder' : 'signStop';
    const short = c.signature.slice(0, 130);
    const long = `${c.signature}00`;
    const notHex = `${c.signature.slice(0, 20)}zz${c.signature.slice(22)}`;
    await assert.rejects(signFor(kind, label, stubSigner(c.signer, short)), refused(fn, 'signature.length', '130'));
    await assert.rejects(signFor(kind, label, stubSigner(c.signer, long)), refused(fn, 'signature.length', '134'));
    await assert.rejects(signFor(kind, label, stubSigner(c.signer, notHex)), refused(fn, 'signature.length', '132'));
  }
});

test("the high-s twin of a reference signature, which recovers to the declared signer, is refused, naming signature.s and the s", async () => {
  const twins = signatures.cases.filter((c) => c.purpose === 'a high-s twin');
  assert.equal(twins.length, 2);
  assert.deepEqual(twins.map((c) => c.signsKind).sort(), ['order', 'stop']);
  for (const c of twins) {
    const { kind, label } = targetOf(c);
    assert.ok(c.recovered && c.s);
    assert.ok(BigInt(c.s) > HALF_ORDER);
    assert.equal(await recoverAddress({ hash: c.digest, signature: c.signature }), c.recovered, `${c.label}: recovers to the signer`);
    await assert.rejects(signFor(kind, label, stubSigner(c.recovered, c.signature)), refused(kind === 'order' ? 'signOrder' : 'signStop', 'signature.s', c.s));
  }
});

test('at the boundary, on a nonzero-grant order and on a stop: s at exactly the half-order is accepted and returned unchanged; s one above is refused, naming signature.s', async () => {
  const at = signatures.cases.filter((c) => c.purpose === 's at the half-order');
  const above = signatures.cases.filter((c) => c.purpose === 's one above the half-order');
  assert.equal(at.length, 2);
  assert.equal(above.length, 2);
  for (const c of [...at, ...above]) {
    assert.equal(c.blocked, undefined, `${c.label} is not blocked`);
    assert.ok(c.recovered && c.s);
    const { kind, label } = targetOf(c);
    if (kind === 'order') assert.notEqual(grantOf(orderCase(label).order.nonce), 0, `${label} has a nonzero grant`);
    assert.equal(await recoverAddress({ hash: c.digest, signature: c.signature }), c.recovered);
    const stub = stubSigner(c.recovered, c.signature);
    if (c.purpose === 's at the half-order') {
      assert.equal(BigInt(c.s), HALF_ORDER);
      assert.equal(await signFor(kind, label, stub), c.signature, c.label);
    } else {
      assert.equal(BigInt(c.s), HALF_ORDER + 1n);
      await assert.rejects(signFor(kind, label, stub), refused(kind === 'order' ? 'signOrder' : 'signStop', 'signature.s', c.s), c.label);
    }
  }
});

// ── the recovery, and the grant-zero account binding ─────────────────────────────────────────────────────────

test('the recovery alone: a signer that declares one fixture address and signs with another key is refused, naming signature.recovered and the address recovered', async () => {
  const variants: Array<[string, 'order' | 'stop', string, string]> = [
    ['a nonzero-grant order', 'order', "a grant's agent signs", KEY_3],
    ['a stop', 'stop', 'one hash, chain 137', KEY_1],
    ['a grant-0 order whose account is the declared address', 'order', 'base', KEY_1],
  ];
  for (const [name, kind, label, declared] of variants) {
    if (kind === 'order' && label === 'base') assert.equal(orderCase(label).order.account, fixtureAddress(declared));
    const other = signatureCase(`${label}, signed by ${KEY_2}`);
    assert.ok(other.signer);
    assert.notEqual(other.signer, fixtureAddress(declared));
    await assert.rejects(
      signFor(kind, label, stubSigner(fixtureAddress(declared), other.signature)),
      refused(kind === 'order' ? 'signOrder' : 'signStop', 'signature.recovered', other.signer),
      name,
    );
  }
});

test("the account binding alone: grant 0, an honest signer whose address is its own key's, and an order of another account, is refused, naming account, before the signer is called", async () => {
  const o = orderCase('base');
  assert.equal(grantOf(o.order.nonce), 0);
  const honest = signatureCase(`base, signed by ${KEY_2}`);
  assert.equal(honest.signer, fixtureAddress(KEY_2));
  assert.notEqual(o.order.account, fixtureAddress(KEY_2));
  const stub = stubSigner(fixtureAddress(KEY_2), honest.signature);
  await assert.rejects(signOrder(toOrder(o.order), o.chainId, o.matching, stub), refused('signOrder', 'account', o.order.account));
  assert.equal(stub.calls.length, 0, 'the signer was not called');
});

test("a nonzero grant, signed by the grant's fixture agent, is accepted by the recovery alone", async () => {
  for (const label of ["a grant's agent signs", 'nonce max']) {
    const o = orderCase(label);
    assert.notEqual(grantOf(o.order.nonce), 0);
    assert.notEqual(o.order.account, fixtureAddress(KEY_3));
    const c = signatureCase(`${label}, signed by ${KEY_3}`);
    assert.equal(await signOrder(toOrder(o.order), o.chainId, o.matching, stubSigner(fixtureAddress(KEY_3), c.signature)), c.signature, label);
  }
});

test('the controls: the right signer at grant 0 with its own account, and a stop by its right signer, are accepted with the frozen bytes', async () => {
  const order = signatureCase(`base, signed by ${KEY_1}`);
  const o = orderCase('base');
  assert.equal(await signOrder(toOrder(o.order), o.chainId, o.matching, stubSigner(fixtureAddress(KEY_1), order.signature)), order.signature);
  const stop = signatureCase(`one hash, chain 137, signed by ${KEY_1}`);
  const s = stopCase('one hash, chain 137');
  assert.equal(await signStop(s.account, s.orderHashes, s.chainId, s.relay, stubSigner(fixtureAddress(KEY_1), stop.signature)), stop.signature);
});

test("the courier's frozen signatures, made outside with another toolchain, are accepted from a signer declaring the frozen account", async () => {
  for (const label of ["the courier's frozen order, its signature", "the courier's frozen stop, its signature"]) {
    const c = signatureCase(label);
    const { kind, label: target } = targetOf(c);
    assert.ok(c.signer);
    assert.equal(await signFor(kind, target, stubSigner(c.signer, c.signature)), c.signature, label);
  }
});

// ── a real signer over a fixture key ─────────────────────────────────────────────────────────────────────────

test("signing with a fixture key gives the reference signer's bytes for every case it may sign, recovering to the expected signer", async () => {
  const cases = signatures.cases.filter((c) => c.source === 'reference' && (c.kind === 'order' || c.kind === 'stop'));
  assert.equal(cases.length, 17);
  let signed = 0;
  for (const c of cases) {
    assert.ok(c.keyLabel && c.signer && c.signs);
    if (c.kind === 'order') {
      const o = orderCase(c.signs);
      const bound = grantOf(o.order.nonce) === 0 && o.order.account.toLowerCase() !== c.signer.toLowerCase();
      if (bound) continue; // refused for its account: the binding's own test above
    }
    const signature = await signFor(c.kind as 'order' | 'stop', c.signs, fixtureSigner(c.keyLabel));
    assert.equal(signature, c.signature, c.label);
    assert.equal(await recoverAddress({ hash: c.digest, signature }), c.signer, c.label);
    signed++;
  }
  assert.equal(signed, 16);
});
