# Changelog

All notable changes to `@ospex/rules` are recorded here. It is versioned and released on its own tag (`rules-v<ver>`), separately from `@ospex/sdk` and `@ospex/cli`.

## 0.2.0

Adds the v3 order and the courier's stop. The top-up and bet rules do not change.

- The order: its ten fields (`OspexOrder`), its EIP-712 type (`ORDER_TYPE`, `ORDER_TYPES`) and domain (`orderDomain`: "Ospex", version "3", the chain and the matching contract), and `orderHash`, which equals the matching contract's `getOrderHash`.
- The courier's stop: `STOP_TYPES`, `stopDomain` ("Ospex Courier", version "1", the chain and the relay) and `stopDigest`, over the account and the order hashes in the order given.
- `packNonce` and `splitNonce`: the nonce's version (128 bits), grant (32 bits) and order number (96 bits).
- `signOrder` and `signStop` hand the caller's signer (`TypedDataSigner`) the typed data once, and return only a 65-byte signature with `v` 27 or 28 and `s` in the lower half of the curve's order, that recovers to the signer's address. An order whose nonce has grant 0 must be signed by its own account; that is checked before the signer is called.
- Every order, stop, nonce and domain field is checked for shape and range before it is hashed or signed, and every field or signature refusal raised by this package throws `OrderRefused`, naming the function, the field and the value. Live state (the account's version, a grant, the floor, the balance, an expiry still ahead) is not checked.
- The signer must implement `TypedDataSigner`; a missing `signTypedData` method throws `TypeError`, and exceptions from that method propagate.
- Frozen test vectors ship in the package, as `@ospex/rules/vectors/orders.json`, `stops.json` and `signatures.json`: order digests from the matching contract, stop digests from the courier, and signatures from a reference signer, each with its provenance.

## 0.1.0

First release.

- `signTopUpRule` builds and signs the top-up rule: one call, which the worker has an hour to make, setting the account's USDC allowance to PositionModule to `amount`, at most a caller-supplied cap. It sets the allowance rather than adding to it, and the allowance does not expire with the rule.
- `signBetRule` builds and signs the bet rule: repeated calls to `MatchingModule.matchCommitment` with no native value and no per-bet or per-day limit, for 30 days. The builder and `verifyRule` accept windows of up to 90 days.
- `verifyRule` refuses a rule unless it is in the `ospex-rule/1` format, its caveats match what the builder makes for the same parameters, it is signed by the account's owner, delegated to the given worker, and inside its window.
- `serializeRule` / `parseRule` carry a rule as text in the `ospex-rule/1` format.
