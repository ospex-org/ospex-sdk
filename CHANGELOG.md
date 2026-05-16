# Changelog

All notable changes to `@ospex/sdk` and `@ospex/cli` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semver](https://semver.org/) with the pre-1.0 caret-pinning rules described in [`docs/AGENT_CONTRACT.md` §13](./docs/AGENT_CONTRACT.md).

## [Unreleased]

### SDK (`@ospex/sdk`)

- **`SpeculationCreationFeeSummary`** — new always-present, mode-symmetric block on `MatchPreview.speculation.creationFee` and `SubmitPreview.market.speculation.creationFee`. Replaces the previous "no `lazyCreation` block ⇒ no fee" negative inference with positive, machine-readable fields: `applies`, `condition` (`'never'` | `'if-first-match-at-execution'`), `totalFee*`, role-based `taker/makerShare*`, wallet-centric `viewerShare*` (collapses self-match doubling), `spender`, `spenderLabel`, `approvalPurpose`, `approvalNeeded`, and a human `note`. On existing mode every numeric is `"0"` and `applies===false` so an agent reads one field and acts. Driven from the on-chain `SPECULATION_CREATION_FEE_WEI6` constant via a shared `buildCreationFeeSummary` helper used by both builders. Type exported from the main SDK barrel. Additive under `schemaVersion: 1`.
- **`MatchPreview.tradeAction` and `SubmitPreview.submitAction`** — new always-present top-level tag (`'trade-only'` | `'trade-and-create-speculation'`) describing the action implied by current preview state. Mirrors `speculation.mode` but stated in operator/agent vocabulary so an agent can branch on what the transaction DOES without translating protocol jargon. Documented as preview-state, not eternal guarantee — on a lazy match another tx may create the speculation first and the action collapses back to trade-only at execution time (encoded in `creationFee.condition`).
- **`MatchPreviewSpeculation.lazyCreation` soft-deprecated.** Marked `@deprecated` via JSDoc; still emitted on lazy-mode previews for backwards compat. The maker-allowance diagnostic it carries (`makerTreasuryAllowance*`) remains the source of the `'maker-treasury-allowance-insufficient'` warning. New code should read `speculation.creationFee` for fee semantics.
- **`commitments.prepareSubmit({ maker })` and `commitments.prepareMatch({ taker })`** — new optional address overrides. When set, the preview computation uses the supplied address instead of calling `signer.getAddress()`. Enables `--json` preview-only flows in the CLI to compute a full preview without ever unlocking the keystore. The actual sign step (`submitPrepared` / `matchFromPreview`) always uses the configured signer, so the override can never cause a sign with the wrong wallet.
- **`KeystoreSigner.fromFoundryAccount({ account, passwordFile?, passphrase?, fromStdin?, foundryKeystoresDir?, expectedAddress?, strict? })`** and **`KeystoreSigner.fromKeystoreFile({ keystorePath, passwordFile?, passphrase?, fromStdin?, expectedAddress?, strict? })`** — new non-interactive constructors. Read a v3 keystore file plus a passphrase (from a file, stdin, literal arg, or `OSPEX_PASSWORD_FILE` env), decrypt in memory, and optionally verify an expected address. The decrypted private key never crosses a function boundary outside the signer. Available via the `@ospex/sdk/signers/keystore` subpath alongside the existing `unlock` constructor.
- **`resolveKeystoreSource`, `readPassphrase`, `checkPasswordFilePermissions`** — composable building blocks behind the new constructors, exported from `@ospex/sdk/signers/keystore` for callers that want fine-grained control. The resolver honors `OSPEX_FOUNDRY_KEYSTORES_DIR` and `FOUNDRY_DIR` env vars; the passphrase reader honors `OSPEX_PASSWORD_FILE`.
- **`OspexSignerResolutionError`** — new typed error class with a stable `reason` code, attached `path` / `expectedAddress` / `actualAddress` / `mode` fields. Reasons: `keystore_not_found`, `password_file_not_found`, `decryption_failed`, `address_mismatch`, `non_interactive_password_required`, `password_file_permissions_loose`, `account_and_path_conflict`, `password_source_conflict`. Exported from the main SDK barrel.
- **`computeTakerView(commitment, { awayTeam, homeTeam })`** — pure helper exported from the SDK barrel. Derives the taker-centric perspective of a maker's open commitment: the team / side the taker would be backing, the inverted (taker-side) decimal + American odds, the max USDC to fully fill, and the profit on full fill. Used by `ospex commitments list` and available to agents / market makers that want to render the same view.
- **`MatchPreview.you` / `counterparty` / `outcomes` and `SubmitPreview.you` / `counterparty`** — new optional first-person blocks on both preview envelopes. `you` carries the executing party's `role` (maker on submit, taker on match), `address`, concise `backing` label ("Los Angeles Dodgers", "Lakers -3.5", "Over 220.5"), effective `odds` (decimal + American + tick), and `risk` / `profit` / `totalReturn` as `{ wei6, usdc }` pairs (6dp USDC). `counterparty` is the symmetric mirror with `address: null` on the submit-side hypothetical. `MatchPreview.outcomes` reaches parity with the existing `SubmitPreview.outcomes` shape, in the taker's perspective. Additive under `schemaVersion: 1` per [`docs/AGENT_CONTRACT.md` §1](./docs/AGENT_CONTRACT.md).
- **`computeMatchYouView(preview)` and `computeSubmitYouView(preview)`** — pure accessors exported from the SDK barrel. Return `preview.you` / `counterparty` / `outcomes` directly when present and otherwise backfill from the legacy preview fields — `makerSide` / `takerSide` / `odds` / `economics` for match, `side` / `economics` (plus the always-populated `market` / `contest` / `raw` blocks) for submit. Agents handling mixed-SDK-version envelopes call one helper and ignore the version.
- **`PreviewYou`, `PreviewCounterparty`, `PerspectiveAmount`, `PerspectiveOdds`** — new public type exports on the SDK barrel. Alongside the value-level builders `buildPreviewYou`, `buildPreviewCounterparty`, `buildPerspectiveOdds`, `buildPerspectiveAmount`, `buildBackingLabel`, `inverseOddsTick`, `sideRoleFor`, `invertSideRole`, `buildPreviewOutcomes` for callers composing custom previews.
- **Internal refactor: shared math via `perspectiveView.ts` and `outcomeView.ts`.** The 200-line copy-paste of spread/total/moneyline outcome generation that used to live inside `buildSubmitPreview` now lives in one shared module called from both `buildSubmitPreview` and `buildMatchPreview`. No behavioral change to existing fields.
- **Fix: `LazyCreationFee.makerShareWei6` is now `0n` on self-match** (was incorrectly `totalFeeWei6`). The on-the-wire invariant `takerShareWei6 + makerShareWei6 === totalFeeWei6` now holds in both self-match and non-self-match cases — dashboards summing the shares no longer double-count on self-match. The docstring on `LazyCreationFee` already described this behavior; the implementation has been brought into agreement. `makerTreasuryAllowanceSufficient` is trivially `true` on self-match as a consequence; the `maker-treasury-allowance-insufficient` warning is gated on `!selfMatch` already so no UX path is affected.

### CLI (`@ospex/cli`)

- **`ospex commitments match` preview — explicit Speculation / Action block on every render.** Existing-mode shows a compact two-line answer (`Speculation: #N — already created, no creation fee` + `Action: trade only`) so an agent or a reader sees the trade-only / no-fee answer without inferring from absence of fields. Lazy-mode shows the full breakdown — total fee, taker/maker shares, the wallet-centric "your wallet exposure" line that collapses self-match doubling, and a "pulled only if this tx is still the first match at execution time" caveat. The legacy maker-allowance warning is preserved. `--raw` mirrors the same content in the protocol-native layout. `--json` is unchanged — agents read the same data through `preview.tradeAction` + `preview.speculation.creationFee` (see SDK section above).
- **`ospex commitments submit` preview — symmetric Speculation block** with an explicit `→ trade-only submit` line on existing-mode and a tightened `→ trade + speculation creation IF your commitment is the first to match` block on lazy. Wire `submitAction` and `market.speculation.creationFee` fields drive the JSON contract.
- **`ospex auth use-foundry --account <name> --password-file <path> [--no-pin-address]`** — pin a Foundry account + password file as the default signer for every future `ospex` command. Validates by decrypting once and (by default) pins the resulting address in config as a safety check. Every subsequent unlock compares the resolved signer's address against the pinned value and throws `OspexSignerResolutionError({ reason: 'address_mismatch' })` on mismatch — agent guardrail against accidental key rotation under the same account name. `--no-pin-address` opts out of the pin. `--keystore-path <path>` accepted as a mutually-exclusive alternative to `--account` for non-Foundry v3 keystores.
- **`ospex auth clear-foundry [--account] [--password-file] [--expected-address] [--foundry-keystores-dir] [--all]`** — remove `auth use-foundry`-pinned defaults from `~/.ospex/config.json`. Without flags, clears every foundry-signer field. Targeted flags clear only the named fields. Non-signer config (`apiUrl`, `rpcUrl`, `chainId`, legacy `keystorePath`) is untouched.
- **Config-pinned defaults flow through every write command.** After `auth use-foundry`, subsequent calls to `commitments submit`, `commitments match`, `approvals setup`, `contests create`, etc. pick up the configured `foundryAccount` / `passwordFile` / `foundryKeystoresDir` / `expectedAddress` automatically. Precedence: flag > env > config > default. The merge runs inside `loadSigner` so the existing legacy-session-cache UX is preserved for users who haven't run `auth use-foundry`.
- **Shared non-interactive signer option group on every write command.** Each of `approvals setup`, `commitments {submit, submit-raw, match, approve, approve-raw, cancel, cancel-onchain, cancel-all}`, `contests {create, score}`, top-level `{claim, claim-all, settle}` (registered at the program root, not under `positions`), and `wallet address` now accepts:
  - `--account <name>` — Foundry account (resolved against `~/.foundry/keystores`, `OSPEX_FOUNDRY_KEYSTORES_DIR`, or `FOUNDRY_DIR/keystores`).
  - `--keystore-path <path>` — explicit v3 keystore JSON.
  - `--password-file <path>` — read the passphrase from a `0600` file (skips the interactive prompt).
  - `--password-stdin` — read the passphrase from a pipe (`pass show … | ospex …`).
  - `--expected-address <0x…>` — refuse to sign if the unlocked address differs; also used as the preview-only address override.
  - `--foundry-keystores-dir <path>` — override the Foundry keystores directory.

  When non-interactive credentials are supplied (or `OSPEX_PASSWORD_FILE` is set in the env), the SDK's new `KeystoreSigner.fromFoundryAccount` / `fromKeystoreFile` helpers run; no session-cache write. The legacy `ospex wallet unlock` flow keeps working when none of the new flags are passed.
- **Lazy signer unlock for `--json` preview-only flows.** `ospex commitments submit --json` and `ospex commitments match --json` (both without `--yes`) no longer trigger a keystore decrypt or interactive prompt. The taker/maker address is resolved from `--expected-address`, configured non-interactive credentials, or a cached legacy session — in that order. If none is available, the commands fail fast with `OspexSignerResolutionError({ reason: 'non_interactive_password_required' })` and an actionable message pointing at the three remediation paths. Agents can now run preview-only flows in CI without keystore access at all.
- **`ospex commitments list` — default human output is now taker-centric.** Columns: matchup, market, you back, your odds, max bet, to win. The previous protocol view (positionType=upper/lower, maker risk, maker odds) is preserved behind `--raw`. `--json` output is intentionally unchanged — the on-chain commitment shape stays the agent-stable contract.
- **`ospex commitments list --side <team>`** — taker-view filter. Case-insensitive substring match against `youBack`. Handles full team names, last-token nicknames, and `over`/`under` for totals.
- **`ospex commitments list --sort size|odds|newest`** — taker-view sort order. Default `size` puts the largest available `maxBet` first.
- `ospex odds show <contestId> --market <type>` — narrow the human render to a single market (`moneyline`, `spread`, or `total`). The `--json` envelope shape is intentionally unchanged so agents still see the same `{ moneyline, spread, total }` triple regardless of the flag.
- **`ospex commitments match` — default human render is now first-person.** Columns: `You back: <team> at <american> (decimal X.XX)` / `Counterparty: <team> at <american> (decimal X.XX) — maker 0x…` / `Your risk:` / `Your profit: +N USDC if <team> wins` / `Maker fill: X of Y remaining (full|partial fill)` plus an `Outcomes:` block (taker perspective). Approval rows are rendered in USDC instead of raw wei6. Self-match renders a dedicated dual-stake block with an explicit `Position stake from your wallet:` line and a separate `Creation fee exposure:` line for lazy specs. The previous dual maker/taker layout (with `maker side:` / `taker side:` lines, `[oddsTick=…]`, protocol `line_ticks`, and raw approval wei6 figures) is preserved behind `--raw`. `--json` is unchanged — the envelope is the agent contract.
- **`ospex commitments submit` — default human render drops `positionType=Upper/Lower`** from the `[sideTags]` bracket on the `side:` line. The protocol-internal Upper / Lower terminology was the only remaining leakage in the submit-preview render. The `scorer` + `source` tags are unchanged. `--raw` restores the `positionType` tag for debugging.
- **`ospex commitments {submit, match} --raw`** — new flag on both commands. Renders the protocol-native layout instead of the first-person default. Useful for debugging EIP-712 hash mismatches and protocol-level audits. No effect on `--json` output.

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
- `ospex positions {list, status, history}` plus top-level `claim`, `claim-all`, `settle` (registered at the program root for day-to-day ergonomics, not under `positions`) with `--dry-run` on `claim-all` and `cancel-all`.
- `ospex odds {show, watch}` — one-shot snapshot + Realtime stream (line-delimited JSON in `--json` mode).
- `ospex leaderboard show`.
- `ospex wallet {import, address, unlock, lock}` — legacy session-cache path.
- Most commands support `--json` for machine-readable output; the interactive setup / wallet-management flows (`init`, `wallet import`, `wallet unlock`, `wallet lock`) do not. See [`docs/AGENT_CONTRACT.md`](./docs/AGENT_CONTRACT.md) for the stable agent contract.

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
