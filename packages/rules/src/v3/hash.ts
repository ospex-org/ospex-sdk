import { hashTypedData, type Address, type Hex } from 'viem';
import { checkAddress, checkOrder, checkStopHashes, type FunctionName } from './checks.js';
import { checkedOrderDomain, checkedStopDomain, ORDER_TYPES, STOP_TYPES } from './typedData.js';
import type { OspexOrder, TypedDataArgs } from './types.js';

/**
 * The order's hash, as the matching contract's getOrderHash computes it: the
 * EIP-712 digest of the ten fields under the order's domain (name "Ospex",
 * version "3", the chain, the matching contract). Every input is checked first.
 */
export function orderHash(order: OspexOrder, chainId: number, matching: Address): Hex {
  return digestOf(orderTypedData('orderHash', order, chainId, matching));
}

/**
 * The stop's digest, as the courier computes it: the EIP-712 digest of the
 * account and the order hashes, in the order given, under the courier's domain
 * (name "Ospex Courier", version "1", the chain, the relay). Every input is
 * checked first. The same hashes in another order are another digest.
 */
export function stopDigest(account: Address, orderHashes: readonly Hex[], chainId: number, relay: Address): Hex {
  return digestOf(stopTypedData('stopDigest', account, orderHashes, chainId, relay));
}

/** An order's typed data, its inputs checked in the name of the function that asked. */
export function orderTypedData(fn: FunctionName, order: unknown, chainId: unknown, matching: unknown): TypedDataArgs {
  const message = checkOrder(fn, order);
  const domain = checkedOrderDomain(fn, chainId, matching);
  return { domain, types: ORDER_TYPES, primaryType: 'OspexOrder', message: { ...message } };
}

/** A stop's typed data, its inputs checked in the name of the function that asked. */
export function stopTypedData(
  fn: FunctionName,
  account: unknown,
  orderHashes: unknown,
  chainId: unknown,
  relay: unknown,
): TypedDataArgs {
  const checkedAccount = checkAddress(fn, 'account', account);
  const hashes = checkStopHashes(fn, orderHashes);
  const domain = checkedStopDomain(fn, chainId, relay);
  return { domain, types: STOP_TYPES, primaryType: 'OspexStop', message: { account: checkedAccount, orderHashes: hashes } };
}

/** The EIP-712 digest of typed data that has passed its checks. */
export function digestOf(args: TypedDataArgs): Hex {
  return hashTypedData({ domain: args.domain, types: args.types, primaryType: args.primaryType, message: args.message });
}
