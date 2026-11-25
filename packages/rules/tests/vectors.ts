import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type LocalAccount } from 'viem/accounts';
import { OrderRefused } from '../src/v3/checks.js';
import type { OspexOrder, TypedDataArgs, TypedDataSigner } from '../src/v3/types.js';

// The frozen vectors, read from the files the package ships. Every expected value in the v3 tests comes from here,
// made once outside this package (by the matching contract, the courier, or a reference signer), never by the code
// under test.

export interface WireOrder {
  account: string;
  gameId: string;
  scorer: string;
  lineTicks: number;
  positionType: number;
  oddsTick: number;
  riskAmount: string;
  nonce: string;
  expiry: string;
  minFill: string;
}

export interface OrderCase {
  label: string;
  source: 'contract' | 'reference' | 'courier-frozen';
  chainId: number;
  matching: Address;
  order: WireOrder;
  nonceParts?: { version: string; grant: number; orderNumber: string };
  digest: Hex;
  notTheOrdersDomain?: boolean;
  typeHash?: Hex;
  oldDigest?: Hex;
}

export interface StopCase {
  label: string;
  source: 'courier' | 'courier-frozen';
  chainId: number;
  relay: Address;
  account: Address;
  orderHashes: Hex[];
  digest: Hex;
  notTheStopsDomain?: boolean;
}

export interface SignatureCase {
  label: string;
  source: 'reference' | 'courier-frozen';
  kind: 'order' | 'stop' | 'stub' | 'crossed';
  purpose: string;
  signs?: string;
  signsKind?: 'order' | 'stop';
  of?: string;
  stop?: string;
  keyLabel?: string | null;
  signer?: Address;
  digest: Hex;
  signature: Hex;
  s?: string;
  v?: number;
  recovered?: Address | null;
  blocked?: string;
}

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../vectors/${name}.json`, import.meta.url), 'utf8')) as T;

export const orders = read<{ provenance: { orderType: string; orderTypeHash: Hex }; cases: OrderCase[] }>('orders');
export const stops = read<{ provenance: { stopType: string }; cases: StopCase[] }>('stops');
export const signatures = read<{ provenance: { fixtureKeys: Array<{ label: string; address: Address }>; halfOrder: Hex }; cases: SignatureCase[] }>('signatures');

const find = <T extends { label: string }>(cases: T[], label: string, kind: string): T => {
  const found = cases.find((c) => c.label === label);
  assert.ok(found, `no ${kind} vector labelled ${label}`);
  return found;
};
export const orderCase = (label: string): OrderCase => find(orders.cases, label, 'order');
export const stopCase = (label: string): StopCase => find(stops.cases, label, 'stop');
export const signatureCase = (label: string): SignatureCase => find(signatures.cases, label, 'signature');

/** A frozen order, its uint256 fields as bigints, as a caller passes it. */
export function toOrder(w: WireOrder): OspexOrder {
  return {
    account: w.account as Address,
    gameId: BigInt(w.gameId),
    scorer: w.scorer as Address,
    lineTicks: w.lineTicks,
    positionType: w.positionType as 0 | 1,
    oddsTick: w.oddsTick,
    riskAmount: BigInt(w.riskAmount),
    nonce: BigInt(w.nonce),
    expiry: BigInt(w.expiry),
    minFill: BigInt(w.minFill),
  };
}

/** An EIP-712 type string read by the test itself: its primary type, and its fields as name and type, in order. */
export function parseType(typeString: string): { name: string; fields: Array<{ name: string; type: string }> } {
  const m = /^(\w+)\((.*)\)$/.exec(typeString);
  assert.ok(m, `not a type string: ${typeString}`);
  const fields = (m[2] as string).split(',').map((f) => {
    const [type, name] = f.split(' ');
    return { name: name as string, type: type as string };
  });
  return { name: m[1] as string, fields };
}

/** The address of a fixture key, as frozen. */
export function fixtureAddress(label: string): Address {
  return find(signatures.provenance.fixtureKeys, label, 'fixture key').address;
}

/**
 * A signer over a public fixture key: keccak256 of the label's UTF-8 bytes, held in memory, never written. It is a
 * fixture, used nowhere else, and holds nothing. It signs with viem's own local account.
 */
export function fixtureSigner(label: string): TypedDataSigner {
  const account: LocalAccount = privateKeyToAccount(keccak256(toBytes(label)));
  return {
    address: account.address,
    signTypedData: (args) => account.signTypedData(args as Parameters<LocalAccount['signTypedData']>[0]),
  };
}

/** A stub signer: it declares an address, returns the given bytes, and records what each call hands it. */
export function stubSigner(address: string, returns: string): TypedDataSigner & { calls: TypedDataArgs[] } {
  const calls: TypedDataArgs[] = [];
  return {
    address: address as Address,
    calls,
    signTypedData: async (args) => {
      calls.push(args);
      return returns as Hex;
    },
  };
}

/** For assert.throws and assert.rejects: the error is an OrderRefused naming this function, field and value. */
export function refused(functionName: string, field: string, value: string): (error: unknown) => true {
  return (error) => {
    assert.ok(error instanceof OrderRefused, `expected an OrderRefused, got ${String(error)}`);
    assert.equal(error.name, 'OrderRefused');
    assert.equal(error.functionName, functionName);
    assert.equal(error.field, field);
    assert.equal(error.value, value);
    assert.equal(error.message, `${functionName}: ${field} refused: ${value}`);
    return true;
  };
}
