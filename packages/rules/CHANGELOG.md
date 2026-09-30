# Changelog

All notable changes to `@ospex/rules` are recorded here. It is versioned and released on its own tag (`rules-v<ver>`), separately from `@ospex/sdk` and `@ospex/cli`.

## 0.1.0

First release.

- `signTopUpRule` and `signBetRule` build and sign the two delegations an Ospex smart account grants a worker: a one-shot `USDC.approve(PositionModule, amount)` within an hour, with `amount` at most a caller-supplied cap, and `MatchingModule.matchCommitment` only, with no native value, for 30 days (the builder refuses windows over 90 days).
- `verifyRule` refuses a rule unless its caveats match what the builder makes for the same parameters, it is signed by the account's owner, delegated to the given worker and inside its window.
- `serializeRule` / `parseRule` carry a rule as text in the `ospex-rule/1` format.
