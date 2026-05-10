# Changelog

All notable changes to `@ospex/sdk` and `@ospex/cli` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semver](https://semver.org/) with the pre-1.0 caret-pinning rules described in [`docs/AGENT_CONTRACT.md` §12](./docs/AGENT_CONTRACT.md).

## [Unreleased]

—

## [0.1.0] — 2026-05-10

Initial public release.

### SDK (`@ospex/sdk`)

- **Reads** — `client.contests.{list,get}`, `speculations.{list,get}`, `commitments.{list,get}`, `positions.{byAddress,status}`, `leaderboard.active`, `protocol.info`, `health`, `games.{list,get}`, `teams`.
- **EIP-712 signed commitments** — `client.commitments.{submit, match, approve, cancel}` with per-instance nonce coordination, structured allowance preflight (`OspexAllowanceError` carries `required`/`current`/`spender`/`token`), and high-level `submit` orchestrator with domain-language inputs (team aliases, decimal/American odds, decimal USDC).
- **On-chain cancel surface** — `client.commitments.{cancelOnchain, raiseMinNonce, cancelAllOnSpeculation, getNonceFloor}` with typed `OspexChainError.reason` for known reverts (`NotCommitmentMaker`, `NonceMustIncrease`).
- **Position lifecycle** — `client.positions.{claimParams, claim, settleSpeculation, claimAll, byTx, claimResult}` with three-bucket status categorization (active / pendingSettle / claimable) and receipt-driven payout/winSide decoding.
- **Contest creation** — `client.contests.{scripts, get, list, create, score, waitForVerified, approveLink, approveFee, invalidateScriptsCache}` for permissionless contest creation (mainnet only) and scoring on top of Chainlink Functions, with `OspexScriptApprovalError` and `OspexSubscriptionError` for typed pre-flight failures.
- **Approvals + balances** — `client.approvals.read`, `client.balances.read` for one-shot wallet readiness queries.
- **Realtime odds** — `client.odds.subscribe({ jsonoddsId, market }, handlers)` opens a Supabase channel with lazy `/v1/config/public` bootstrap; `client.odds.snapshot(contestId)` is the one-shot equivalent.
- **Signers** — `KeystoreSigner` (subpath import `@ospex/sdk/signers/keystore`) for v3 keystore-backed signing; bring-your-own `Signer` interface (`signTypedData`, `signTransaction`, `getAddress`) for any custom integration.
- **Typed errors** — `OspexAPIError`, `OspexConfigError`, `OspexValidationError`, `OspexSigningError`, `OspexAllowanceError`, `OspexChainError`, `OspexScriptApprovalError`, `OspexSubscriptionError`. All extend `OspexError` with a discriminable `code` field.

### CLI (`@ospex/cli`, binary `ospex`)

- `ospex init` — interactive setup (`apiUrl`, `rpcUrl`, `chainId`, `keystorePath`).
- `ospex doctor` — readiness probe with balances, allowances, network, and a "Ready to" matrix. `--address` for read-only inspection.
- `ospex health` — API liveness.
- `ospex contests {list, show, create, score, wait-verified, scripts}`, `ospex games list`.
- `ospex speculations {list, show}`.
- `ospex commitments {list, show, submit, submit-raw, match, approve, approve-raw, cancel, cancel-onchain, cancel-all, nonce-floor}` with preview blocks, prefix-resolution for hashes, and allowance prompts.
- `ospex approvals {setup, show}` — multi-spender approval orchestration.
- `ospex positions {list, status, history, claim, claim-all, settle}` with `--dry-run` on `claim-all` and `cancel-all`.
- `ospex odds {show, watch}` — one-shot snapshot + Realtime stream (line-delimited JSON in `--json` mode).
- `ospex leaderboard show`.
- `ospex wallet {import, address, unlock, lock}` — legacy session-cache path.
- Every command supports `--json` for machine-readable output. See [`docs/AGENT_CONTRACT.md`](./docs/AGENT_CONTRACT.md) for the stable agent contract.

### Documentation

- [`README.md`](./README.md) — overview, install from GitHub Releases, supported surfaces.
- [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) — bettor / maker / operator paths.
- [`docs/AGENT_CONTRACT.md`](./docs/AGENT_CONTRACT.md) — stable JSON envelope, typed error catalog, idempotency, nonce semantics, Realtime contract, versioning rules.
- [`docs/MANUAL_INTEGRATION_TESTING.md`](./docs/MANUAL_INTEGRATION_TESTING.md) — pre-release validation playbook.
- [`docs/RELEASING.md`](./docs/RELEASING.md) — release runbook for tarball builds and tagging.

### Known limitations

- Tarball-only distribution (no npm publication). Both `ospex-sdk-<ver>.tgz` and `ospex-cli-<ver>.tgz` must be installed in the same `yarn add` call.
- Cross-process nonce coordination is not provided — submits distributed across hosts must serialize nonce assignment per `(maker, speculationKey)`.
- Realtime channels do not replay missed events on reconnect — re-poll snapshots if you need a known-good baseline.
- Contest creation is mainnet-only; Polygon Amoy script approvals are not committed.

[Unreleased]: https://github.com/ospex-org/ospex-sdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ospex-org/ospex-sdk/releases/tag/v0.1.0
