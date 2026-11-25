import type { Address } from 'viem';
import { checkAddress, checkChainId, type FunctionName } from './checks.js';
import type { TypedDataDomain, TypedDataField } from './types.js';

/** The order's type string, as the matching contract's ORDER_TYPEHASH hashes it. */
export const ORDER_TYPE =
  'OspexOrder(address account,uint256 gameId,address scorer,int32 lineTicks,uint8 positionType,uint16 oddsTick,uint256 riskAmount,uint256 nonce,uint256 expiry,uint256 minFill)';

const field = (name: string, type: string): TypedDataField => Object.freeze({ name, type });

/** The order's ten fields, as EIP-712 types: the same ten as ORDER_TYPE, in its order. */
export const ORDER_TYPES: { readonly OspexOrder: readonly TypedDataField[] } = Object.freeze({
  OspexOrder: Object.freeze([
    field('account', 'address'),
    field('gameId', 'uint256'),
    field('scorer', 'address'),
    field('lineTicks', 'int32'),
    field('positionType', 'uint8'),
    field('oddsTick', 'uint16'),
    field('riskAmount', 'uint256'),
    field('nonce', 'uint256'),
    field('expiry', 'uint256'),
    field('minFill', 'uint256'),
  ]),
});

/** The courier's stop: the account, then the order hashes in the order given. */
export const STOP_TYPES: { readonly OspexStop: readonly TypedDataField[] } = Object.freeze({
  OspexStop: Object.freeze([field('account', 'address'), field('orderHashes', 'bytes32[]')]),
});

/**
 * The order's domain: name "Ospex", version "3", the chain, and the matching
 * contract, its address checksummed. The matching contract, not the relay.
 */
export function orderDomain(chainId: number, matching: Address): TypedDataDomain {
  return checkedOrderDomain('orderDomain', chainId, matching);
}

/**
 * The stop's domain: name "Ospex Courier", version "1", the chain, and the
 * relay, its address checksummed. No nonce, no expiry.
 */
export function stopDomain(chainId: number, relay: Address): TypedDataDomain {
  return checkedStopDomain('stopDomain', chainId, relay);
}

/** The order's domain, its inputs checked in the name of the function that asked. */
export function checkedOrderDomain(fn: FunctionName, chainId: unknown, matching: unknown): TypedDataDomain {
  const id = checkChainId(fn, chainId);
  return { name: 'Ospex', version: '3', chainId: id, verifyingContract: checkAddress(fn, 'matching', matching) };
}

/** The stop's domain, its inputs checked in the name of the function that asked. */
export function checkedStopDomain(fn: FunctionName, chainId: unknown, relay: unknown): TypedDataDomain {
  const id = checkChainId(fn, chainId);
  return { name: 'Ospex Courier', version: '1', chainId: id, verifyingContract: checkAddress(fn, 'relay', relay) };
}
