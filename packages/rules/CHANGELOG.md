# Changelog

All notable changes to `@ospex/rules` are recorded here. It is versioned and released on its own tag (`rules-v<ver>`), separately from `@ospex/sdk` and `@ospex/cli`.

## 0.1.0

First release.

- `signTopUpRule` builds and signs the top-up rule: one call, which the worker has an hour to make, setting the account's USDC allowance to PositionModule to `amount`, at most a caller-supplied cap. It sets the allowance rather than adding to it, and the allowance does not expire with the rule.
- `signBetRule` builds and signs the bet rule: repeated calls to `MatchingModule.matchCommitment` with no native value and no per-bet or per-day limit, for 30 days. The builder and `verifyRule` accept windows of up to 90 days.
- `verifyRule` refuses a rule unless it is in the `ospex-rule/1` format, its caveats match what the builder makes for the same parameters, it is signed by the account's owner, delegated to the given worker, and inside its window.
- `serializeRule` / `parseRule` carry a rule as text in the `ospex-rule/1` format.
