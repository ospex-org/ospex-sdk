import { recoverAddress, type Address, type Hex } from 'viem';
import { OrderRefused, type FunctionName } from './checks.js';
import { digestOf, orderTypedData, stopTypedData } from './hash.js';
import { splitNonce } from './nonce.js';
import type { OspexOrder, TypedDataArgs, TypedDataSigner } from './types.js';

/**
 * The two signers. Each checks its inputs, hands the signer the typed data
 * once, and returns a signature only in the form the matching contract and the
 * courier take: 65 bytes, `v` 27 or 28, `s` in the lower half of the curve's
 * order, recovering to the signer's address. Anything else is refused and not
 * returned.
 *
 * This package reads no key and builds no signer: the caller's signer signs.
 * It cannot stop a signer from signing what it is handed; it controls what it
 * hands over and what it gives back. Whether the signing address may sign for
 * the account (the account itself, or a live grant's agent) is live state,
 * which this package does not check, beyond the account binding of an order
 * signed under grant 0.
 */

/** Half the secp256k1 curve's order: the largest `s` the contract and the courier take. */
const HALF_CURVE_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * Signs an order under its own domain. The signature must recover to
 * `signer.address`; and for an order whose nonce has grant 0, `signer.address`
 * must also be the order's account. A nonzero grant is checked by the recovery
 * only.
 */
export async function signOrder(
  order: OspexOrder,
  chainId: number,
  matching: Address,
  signer: TypedDataSigner,
): Promise<Hex> {
  const args = orderTypedData('signOrder', order, chainId, matching);
  const digest = digestOf(args);
  const account = order.account;
  const { grant } = splitNonce(order.nonce);
  const declared: unknown = signer.address;
  const signature = await signChecked('signOrder', args, digest, declared, signer);
  if (grant === 0 && !sameAddress(declared, account)) throw new OrderRefused('signOrder', 'account', account);
  return signature;
}

/**
 * Signs a stop under the courier's domain, its hashes in the order given. The
 * signature must recover to `signer.address`.
 */
export async function signStop(
  account: Address,
  orderHashes: readonly Hex[],
  chainId: number,
  relay: Address,
  signer: TypedDataSigner,
): Promise<Hex> {
  const args = stopTypedData('signStop', account, orderHashes, chainId, relay);
  const digest = digestOf(args);
  const declared: unknown = signer.address;
  return signChecked('signStop', args, digest, declared, signer);
}

/**
 * One call to the signer, then the signature's form and its recovery. The
 * digest and the declared address are taken before the call, so nothing the
 * signer does to the arguments changes what is checked.
 */
async function signChecked(
  fn: FunctionName,
  args: TypedDataArgs,
  digest: Hex,
  declared: unknown,
  signer: TypedDataSigner,
): Promise<Hex> {
  const returned: unknown = await signer.signTypedData(args);
  const signature = checkForm(fn, returned);
  let recovered: Address | null = null;
  try {
    recovered = await recoverAddress({ hash: digest, signature });
  } catch {
    recovered = null;
  }
  if (recovered === null || !sameAddress(declared, recovered)) throw new OrderRefused(fn, 'signature.recovered', recovered);
  return signature;
}

/**
 * The form the contract takes: exactly 65 bytes; `v` 27 or 28 kept, 0 or 1
 * rewritten to 27 or 28, any other refused; `s` at most half the curve's order,
 * refused above it and never flipped.
 */
function checkForm(fn: FunctionName, value: unknown): Hex {
  if (typeof value !== 'string' || !SIGNATURE.test(value)) {
    throw new OrderRefused(fn, 'signature.length', typeof value === 'string' ? value.length : value);
  }
  const v = Number.parseInt(value.slice(130), 16);
  let signature = value;
  if (v === 0 || v === 1) signature = value.slice(0, 130) + (v + 27).toString(16);
  else if (v !== 27 && v !== 28) throw new OrderRefused(fn, 'signature.v', v);
  const s = BigInt(`0x${value.slice(66, 130)}`);
  if (s > HALF_CURVE_ORDER) throw new OrderRefused(fn, 'signature.s', s);
  return signature as Hex;
}

function sameAddress(declared: unknown, address: string): boolean {
  return typeof declared === 'string' && declared.toLowerCase() === address.toLowerCase();
}
