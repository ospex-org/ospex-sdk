import type { Address } from 'viem';
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

/** The order's domain: name "Ospex", version "3", the chain, and the matching contract. */
export function orderDomain(chainId: number, matching: Address): TypedDataDomain {
  return { name: 'Ospex', version: '3', chainId, verifyingContract: matching };
}

/** The stop's domain: name "Ospex Courier", version "1", the chain, and the relay. No nonce, no expiry. */
export function stopDomain(chainId: number, relay: Address): TypedDataDomain {
  return { name: 'Ospex Courier', version: '1', chainId, verifyingContract: relay };
}
