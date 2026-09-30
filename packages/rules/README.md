# @ospex/rules

Builds and checks the two permissions an Ospex smart account signs so that a worker can place bets for it:

- **The top-up rule.** The worker may call `USDC.approve(PositionModule, amount)` with exactly that calldata, once, within one hour. `amount` is at most a cap the caller passes. Redeeming it sets the account's USDC allowance to PositionModule, and that allowance is the most any bet can spend.
- **The bet rule.** The worker may call `MatchingModule.matchCommitment` with no native value, and nothing else, for 30 days. The builder refuses a window longer than 90 days.

Both are [MetaMask Smart Accounts Kit](https://github.com/MetaMask/smart-accounts-kit) delegations on Polygon (chain 137), each delegated to one worker address. The package builds them, signs them through the account you pass in, and checks them. It never sends a transaction.

The same code runs on both sides. The page that asks the account to sign uses the builders. The worker that redeems uses `verifyRule`, which rebuilds each rule with the same builder and refuses it unless the caveats match byte for byte. A rule that grants more than the builder would make (another target, a larger top-up, a missing expiry) is therefore refused even when the owner signed it. **The page and the worker must pin the same version of this package.**

## Install

From the GitHub release (the package is not on npm):

```sh
yarn add https://github.com/ospex-org/ospex-sdk/releases/download/rules-v0.1.0/ospex-rules-0.1.0.tgz
```

## Signing (the page)

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

## Checking (the worker)

```ts
import { parseRule, verifyRule } from '@ospex/rules';

const verified = await verifyRule(parseRule(text), {
  kind: 'top-up', worker, environment, nowSeconds, accountFor, capUnits: 100_000_000n,
});
```

`parseRule` checks the text's shape only. `verifyRule` throws `RuleRefused` unless the rule is the expected kind, is for chain 137, is delegated to `worker`, is a root delegation, comes from the account `accountFor(owner)` derives, is signed by `owner`, has caveats identical to what the builder makes for the same parameters (so a top-up above `capUnits` is refused), and `nowSeconds` falls inside its window.

## Also exported

The builders (`buildTopUpDelegation`, `buildBetDelegation`, `topUpCalldata`, `ruleWindow`), `recoverDelegationSigner`, `parseUsdc`, and the protocol constants the rules are built from: the Polygon addresses of USDC, MatchingModule, PositionModule and TreasuryModule, the `matchCommitment` and `approve` selectors, the commitment's EIP-712 domain and types, and the revert errors a redemption can raise.

## Notes

- The rule's text format is `ospex-rule/1`: JSON with every number as a hex string.
- Importing the package sets `process.env.DO_NOT_TRACK` (Node) and `window.doNotTrack` (browser) to `'1'`. Without it the Kit reports each `createDelegation` / `toMetaMaskSmartAccount` call to MetaMask's analytics endpoint.
- Dependencies are exact: `@metamask/smart-accounts-kit` 2.0.0 and `viem` 2.55.10. The package does not depend on `@ospex/sdk`.

## License

MIT
