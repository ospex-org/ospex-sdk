# @ospex/rules

Builds and checks the two permissions an Ospex smart account signs so that a worker can place bets for it: a **top-up rule** and a **bet rule**. Both are [MetaMask Smart Accounts Kit](https://github.com/MetaMask/smart-accounts-kit) delegations on Polygon (chain 137), each to one named worker address. The package builds them, signs them through the account you pass in, and checks them. It never sends a transaction.

## What each rule permits

### Top-up rule

**Allows**

- One call by the named worker, with no native value: `USDC.approve(PositionModule, amount)`, with exactly the calldata the account signed.
- That call **sets** the account's USDC allowance to PositionModule to `amount`. It does not add to an existing allowance, and it is not a transfer: no USDC moves.
- `amount` is positive, at most the cap the signing application passes (`capUnits`), and, checked separately by `verifyRule`, at most the worker's cap.

**Does not allow**

- Approving any spender other than PositionModule, or any amount other than the one signed.
- Approving zero, so it cannot revoke an allowance.
- Transferring USDC, placing a bet, or any other call.
- A second call.

**Timing:** the one hour is how long the worker has to deliver it (`signTopUpRule` signs a window from one minute before the signing time to one hour after). The allowance it sets does not expire with it: it stays, less what bets spend, until another approval replaces it.

### Bet rule

**Allows**

- Calls by the named worker to `MatchingModule.matchCommitment`, with no native value, as many as it likes while the rule is valid. Each call takes a maker's quote for the account, and the rule does not pin which quote or how large.
- No per-bet or per-day limit. What bounds spending is the account's remaining allowance to PositionModule and its USDC balance.

**Does not allow**

- Calling any other contract or method, or sending native value.
- Raising the allowance or approving any spender.
- Moving USDC any other way, including claiming positions or withdrawing.

**Timing:** `signBetRule` signs a window from one minute before the signing time to 30 days after it. `buildBetDelegation` and `verifyRule` accept any signed window of up to 90 days in total.

## The same code on both sides

The page that asks the account to sign uses `signTopUpRule` and `signBetRule`. The worker that redeems uses `verifyRule`, which rebuilds each rule with the same builder and refuses it unless the caveats match byte for byte. A rule that grants more than the builder would make (another target, a larger top-up, a missing expiry) is therefore refused even when the owner signed it. **The page and the worker must pin the same version of this package.**

## Install

From the GitHub release (the package is not on npm):

```sh
yarn add https://github.com/ospex-org/ospex-sdk/releases/download/rules-v0.1.0/ospex-rules-0.1.0.tgz
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
- `owner` is the login signer that owns the account. Signing refuses a signature that does not recover to it.
- `worker` is the only address that may redeem the rule.
- Amounts are USDC base units (6 decimals). `capUnits` has no default, and a missing or non-positive cap is refused.

## Checking

```ts
import { parseRule, verifyRule } from '@ospex/rules';

const verified = await verifyRule(parseRule(text), {
  kind: 'top-up', worker, environment, nowSeconds, accountFor, capUnits: 100_000_000n,
});
```

`parseRule` checks the text's shape. `verifyRule` throws `RuleRefused` unless the rule is in the `ospex-rule/1` format, is the expected kind, is for chain 137, is delegated to `worker`, is a root delegation, comes from the account `accountFor(owner)` derives, is signed by `owner`, has caveats identical to what the builder makes for the same parameters (so a top-up above `capUnits` is refused), and `nowSeconds` falls inside its window.

## Also exported

The builders (`buildTopUpDelegation`, `buildBetDelegation`, `topUpCalldata`, `ruleWindow`), `recoverDelegationSigner`, `parseUsdc`, and the protocol constants the rules are built from: the Polygon addresses of USDC, MatchingModule, PositionModule and TreasuryModule, the `matchCommitment` and `approve` selectors, the commitment's EIP-712 domain and types, and the revert errors a redemption can raise. `TEST_DELEGATE` is a test fixture.

## Notes

- The rule's text format is `ospex-rule/1`, plain JSON. `chainId` is a JSON number; the owner, and every address, byte string and number inside the delegation, are hex strings.
- Importing the package tries to turn off the Kit's analytics, which otherwise reports each `createDelegation` / `toMetaMaskSmartAccount` call to MetaMask. It sets `process.env.DO_NOT_TRACK = '1'` for the whole Node process, and `window.doNotTrack = '1'` in a browser unless that property is read-only. This is best-effort: the Kit decides once, at its first reported call, so a Kit call reported before this package is imported keeps analytics on. The browser path is untested.
- Direct dependencies are pinned exactly: `@metamask/smart-accounts-kit` 2.0.0 and `viem` 2.55.10. Their own dependencies are not. An app that installs this package resolves them in its own lockfile, including `@metamask/delegation-deployments`, which supplies the DelegationManager and enforcer addresses, under the Kit's `^2.0.0`.
- The package does not depend on `@ospex/sdk`.

## License

MIT
