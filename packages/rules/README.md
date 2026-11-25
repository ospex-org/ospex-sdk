# @ospex/rules

Builds and checks the two permissions an Ospex smart account signs so that a worker can place bets for it: a **top-up rule** and a **bet rule**. Both are [MetaMask Smart Accounts Kit](https://github.com/MetaMask/smart-accounts-kit) delegations on Polygon (chain 137), each to one named worker address. The package builds them, signs them through the account you pass in, and checks them. It never sends a transaction. It also hashes and signs the v3 order and the courier's stop (below).

## What each rule permits

Each rule names one worker as its delegate. The worker can pass a rule on through its own delegations, which keep every restriction below (see `worker` under Signing).

### Top-up rule

**Allows**

- One call by the named worker, with no native value: `USDC.approve(PositionModule, amount)`, with exactly the calldata the account signed.
- That call **sets** the account's USDC allowance to PositionModule to `amount`. It does not add to an existing allowance, and it is not a transfer: no USDC moves.
- `amount` is positive, at most the cap the signing application passes (`capUnits`), and, checked separately by `verifyRule`, at most the cap passed to it.

**Does not allow**

- Approving any spender other than PositionModule, or any amount other than the one signed.
- Approving zero, so it cannot revoke an allowance.
- Transferring USDC, placing a bet, or any other call.
- A second call.

**Timing:** the one hour is how long the worker has to deliver it (`signTopUpRule` signs a window from one minute before the signing time to one hour after). The allowance it sets does not expire with it: it stays, less the stakes bets draw from it, until another approval replaces it.

### Bet rule

**Allows**

- Calls by the named worker to `MatchingModule.matchCommitment`, with no native value, as many as it likes while the rule is valid. Each call takes a maker's quote for the account, and the rule does not pin which quote or how large.
- No per-bet or per-day limit. What bounds stakes is the account's remaining allowance to PositionModule and its USDC balance. Separately, when the protocol's speculation-creation fee is above zero, a match that is the first fill of a new market also charges the taker's share of it (half, rounded up) through TreasuryModule. That share can only be collected from an account that has approved TreasuryModule for at least that amount; otherwise the match reverts. No rule in this package builds that approval.

**Does not allow**

- Calling any other contract or method, or sending native value.
- Raising the allowance or approving any spender.
- Moving USDC any other way, including claiming positions or withdrawing.

**Timing:** `signBetRule` signs a window from one minute before the signing time to 30 days after it. `buildBetDelegation` and `verifyRule` accept any signed window of up to 90 days in total.

## The same code on both sides

The app that asks the account to sign uses `signTopUpRule` and `signBetRule`. The worker that redeems uses `verifyRule`, which rebuilds each rule with the same builder and refuses it unless the caveats match byte for byte. A rule that grants more than the builder would make (another target, a larger top-up, a missing expiry) is therefore refused even when the owner signed it. **The signing app and the worker must pin the same version of this package.**

## Install

From the GitHub release (the package is not on npm):

```sh
yarn add https://github.com/ospex-org/ospex-sdk/releases/download/rules-v0.2.0/ospex-rules-0.2.0.tgz
```

## Signing

```ts
import { serializeRule, signBetRule, signTopUpRule } from '@ospex/rules';

const nowSeconds = Math.floor(Date.now() / 1000);
const topUp = await signTopUpRule({ account, owner, worker, amountUnits: 25_000_000n, capUnits: 100_000_000n, nowSeconds });
const bet = await signBetRule({ account, owner, worker, nowSeconds });
const text = serializeRule(topUp);
```

- `account` is a Kit smart account, or anything with its `address`, `environment` and `signDelegation`.
- `owner` is the EOA that owns the account. Signing refuses a signature that does not recover to it.
- `worker` is the delegate the rule names. The rule can be redeemed by that address, or by an address the worker delegates it to, directly or through further delegations; if the worker signs an open delegation (`ANY_DELEGATE`), by any address. A downstream delegation carries every restriction of the rule and cannot widen it.
- Amounts are USDC base units (6 decimals). `capUnits` has no default, and a missing or non-positive cap is refused.

## Checking

```ts
import { parseRule, verifyRule } from '@ospex/rules';

const verified = await verifyRule(parseRule(text), {
  kind: 'top-up', worker, environment, nowSeconds, accountFor, capUnits: 100_000_000n,
});
```

`parseRule` checks the text's shape. `verifyRule` throws `RuleRefused` unless the rule is in the `ospex-rule/1` format, is the expected kind, is for chain 137, is delegated to `worker`, is a root delegation, comes from the account `accountFor(owner)` derives, is signed by `owner`, has caveats identical to what the builder makes for the same parameters (so a top-up above `capUnits` is refused), and `nowSeconds` falls inside its window.

## The v3 order and the courier's stop

The package also hashes and signs an order for the matching contract, and a stop for the courier. It decides no price or size, reads no chain, and signs no transaction.

```ts
import { orderHash, packNonce, signOrder, signStop, type OspexOrder } from '@ospex/rules';

const order: OspexOrder = {
  account, gameId, scorer, lineTicks: -35, positionType: 0, oddsTick: 191,
  riskAmount: 25_000_000n, nonce: packNonce(version, 0, orderNumber), expiry, minFill: 0n,
};
const hash = orderHash(order, 137, matching);
const signature = await signOrder(order, 137, matching, signer);
const stop = await signStop(account, [hash], 137, relay, signer);
```

- `signer` is any `TypedDataSigner`: an `address`, and a `signTypedData(args)` that signs the EIP-712 typed data it is handed. The package reads no key and builds no signer.
- **The order:** ten fields, as the matching contract hashes them, under the domain "Ospex", version "3", the chain and the matching contract. `orderHash` equals the contract's `getOrderHash`.
- **The stop:** the account and the order hashes, in the order given, under the domain "Ospex Courier", version "1", the chain and the relay. The same hashes in another order are another digest.
- **The nonce:** `packNonce(version, grant, orderNumber)` packs the account's version (128 bits), the grant (32 bits; 0 when the account signs for itself) and an order number (96 bits). `splitNonce` is its inverse.
- **The signature:** `signOrder` and `signStop` call the signer once, and return only a 65-byte signature that recovers to `signer.address`, with `v` 27 or 28 (a `v` of 0 or 1 is rewritten) and `s` in the lower half of the curve's order (a higher `s` is refused, never flipped). For an order whose grant is 0, `signer.address` must also be the order's `account`, and that is checked before the signer is called. A nonzero grant is checked by the recovery only.
- **The checks:** every order, stop, nonce and domain field is checked for shape and range before it is hashed or signed. The uint256 fields are bigints from 0 to 2^256 - 1; `riskAmount` is a positive multiple of 100, and `minFill` at most `riskAmount`; `lineTicks` is within 1,000,000 either side of 0, `positionType` 0 or 1, and `oddsTick` from 101 to 10,100; a chain id is a safe integer above 0; an address is in one case, or has a valid checksum; a stop names 1 to 100 hashes, none twice. A value of the wrong type is refused, never coerced. Every field or signature refusal raised by this package is an `OrderRefused`, with `functionName`, `field` and `value`.
- The signer must implement `TypedDataSigner`; a missing `signTypedData` method throws `TypeError`, and exceptions from that method propagate.
- **Not checked:** live state. Whether the nonce's version is the account's current one, whether a grant is live, the line's floor, the account's registration, its balance, and whether the expiry is still ahead are for the caller to read.

### Test vectors

The package ships the vectors its own tests read, so a consumer can test against the same bytes:

```ts
import orders from '@ospex/rules/vectors/orders.json' with { type: 'json' }; // Node 20.10 and later
// or: createRequire(import.meta.url)('@ospex/rules/vectors/orders.json')
```

- `orders.json`: order digests made by the matching contract's `getOrderHash`, a reference library's digests under other domains, and the courier's own frozen order.
- `stops.json`: stop digests made by the courier's own `stopHash`, and the courier's frozen stop.
- `signatures.json`: signatures made by a reference signer (ethers 6) with public fixture keys, and the cases built from them: high-`s` twins, and `s` at the half-order and one above.
- Each file is `{ "provenance": { … }, "cases": [ … ] }`, and every uint256 in it is a decimal string. The provenance names the commits and tools each case came from. Each fixture key is keccak256 of a public label: it holds nothing, and anyone can sign with it.

## Also exported

The builders (`buildTopUpDelegation`, `buildBetDelegation`, `topUpCalldata`, `ruleWindow`), `recoverDelegationSigner`, `parseUsdc`, and the protocol constants the rules are built from: the Polygon addresses of USDC, MatchingModule, PositionModule and TreasuryModule, the `matchCommitment` and `approve` selectors, the commitment's EIP-712 domain and types, and the revert errors a redemption can raise. `TEST_DELEGATE` is a test fixture.

## Notes

- The rule's text format is `ospex-rule/1`, plain JSON. `chainId` is a JSON number; the owner, and every address, byte string and number inside the delegation, are hex strings.
- Importing the package tries to turn off the Kit's analytics, which otherwise reports each `createDelegation` / `toMetaMaskSmartAccount` call to MetaMask. It sets `process.env.DO_NOT_TRACK = '1'` for the whole Node process, and `window.doNotTrack = '1'` in a browser unless that property is read-only. This is best-effort: the Kit decides once, at its first reported call, so a Kit call reported before this package is imported keeps analytics on. The browser path is untested.
- Direct dependencies are pinned exactly: `@metamask/smart-accounts-kit` 2.0.0 and `viem` 2.55.10. Their own dependencies are not. An app that installs this package resolves them in its own lockfile, including `@metamask/delegation-deployments`, which supplies the DelegationManager and enforcer addresses, under the Kit's `^2.0.0`.
- The package does not depend on `@ospex/sdk`.

## License

MIT
