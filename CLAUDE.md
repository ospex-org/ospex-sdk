# CLAUDE.md

Maintainer notes for the Ospex SDK + CLI monorepo. Public docs live in [`README.md`](./README.md), [`docs/QUICKSTART.md`](./docs/QUICKSTART.md), and [`docs/AGENT_CONTRACT.md`](./docs/AGENT_CONTRACT.md); contributor workflow is in [`CONTRIBUTING.md`](./CONTRIBUTING.md). This file captures repo-internal context the public docs don't need to carry.

## Layout

- `packages/sdk` — `@ospex/sdk`. Public TypeScript SDK. Reads, EIP-712 helpers, SSE odds + protocol streams.
- `packages/cli` — `@ospex/cli`. `ospex` binary on top of the SDK.

Yarn 1 workspaces. Commands run from the root or scoped: `yarn workspace @ospex/sdk <cmd>`.

## Source-of-truth pointers

- **API contract**: internal API response types in `packages/sdk/src/api/types.ts` mirror the core-API handlers. When the core API changes a response shape, update both ends in lockstep. This is the SDK's only schema-mirroring surface — the SDK reads all protocol state (and streams odds / protocol deltas) through core-api, so there are no hand-written DB row types.
- **Contracts**: ABIs live at `packages/sdk/src/contracts/abi/`. `MatchingModule.json`, `PositionModule.json`, `SpeculationModule.json`, `ContestModule.json`, and `OracleModule.json` are full Foundry artifacts, refreshed by copying from the contracts repo on contract redeploy. `erc20.ts` is hand-written and reused for both USDC and LINK. `addresses.ts` carries deployed addresses (incl. `linkToken`) for chain id 137 (mainnet) and 80002 (Amoy) — refresh from the contracts repo's deployment artifacts on every redeploy. `constants.ts` carries chainwise constants: `LINK_PAYMENT_PER_CALL_WEI`, `OSPEX_SHARED_SUBSCRIPTION_ID`, `APPROVED_SIGNER_BY_CHAIN`, `OSPEX_API_SERVER_URL`, `OSPEX_DEFAULT_GAS_LIMIT`, verification-poll defaults.
- **Script approvals**: `client.contests.scripts()` fetches `GET /v1/contests/scripts/approved` from the core API and caches the result for 5 minutes per Contests instance. Refreshing approvals (notably the verify-script re-sign) requires only a core-API redeploy, no SDK release. The verify JS source itself is fetched from the public URL the approval points at and hash-checked locally before any tx is built — a hash mismatch throws `OspexScriptApprovalError(reason='hash_mismatch')` and never wastes gas/USDC on a guaranteed revert.
- **Encrypted Chainlink Functions secrets**: fetched from `https://secrets.ospex.org/api/get-encrypted-secrets` (protocol-stable alias). Override via `ContestsContext.apiServerUrl` for tests / local stubs.

## Distribution model

**GitHub releases, not npm.** Each tagged release at `github.com/ospex-org/ospex-sdk/releases` attaches two tarballs (`ospex-sdk-<ver>.tgz` and `ospex-cli-<ver>.tgz`). The release runbook is in [`docs/RELEASING.md`](./docs/RELEASING.md). **CLI users install just the bundled `ospex-cli-<ver>.tgz` globally** (`npm install -g` / `yarn global add`) and run bare `ospex` — see `docs/QUICKSTART.md`. The `ospex-sdk-<ver>.tgz` is the unbundled library for programmatic consumers (e.g. the market-maker); CLI users don't need it.

Rationale: npm is overwhelmingly a developer-productivity ecosystem; a sports-betting CLI is consumer-entertainment with financial risk and doesn't share a natural audience there. If npm publish is ever added later it'd be a *secondary* channel; GitHub releases stays primary. See "Build & dependency gotchas" below for the implication on `@ospex/cli`'s package.json shape.

## Hard rules

- **CLI never imports SDK internals.** Only `@ospex/sdk` and `@ospex/sdk/signers/keystore` — anything else is a layering violation.
- **No network parameter on the public SDK.** A client is configured for one network; the API returns the network id, the SDK never asks the user.
- **No module-level state in the SDK.** Multiple `OspexClient` instances must be fully isolated.
- **Errors are typed.** Throw `OspexAPIError`, `OspexConfigError`, `OspexValidationError`, `OspexSigningError`, `OspexAllowanceError`, `OspexChainError`, `OspexScriptApprovalError`, or `OspexSubscriptionError` — never strings.
- **Contest creation fee → TreasuryModule, not PositionModule.** `OspexAllowanceError.spender` for M4 contest writes is `TreasuryModule` (USDC) or `OracleModule` (LINK) — distinct from M2's USDC→PositionModule path. The CLI's `handleContestAllowance` distinguishes by comparing `err.spender` to `getAddresses(chainId).oracleModule`.
- **All I/O is async.** No mixed sync/async surfaces.

## Build & dependency gotchas

- **`@ospex/cli` ships as a single self-contained esbuild bundle with no runtime dependencies** (since 0.4.0). `packages/cli/scripts/bundle.mjs` (run by the CLI's `build` script, after the SDK build) inlines everything — `@ospex/sdk`, `viem`, `ethers`, `commander`, `zod`, `cli-table3` — into one `dist/index.js`, and `packages/cli/package.json` has `dependencies: {}` (the former runtime deps are now devDependencies, present only for tsc / dev / tests / the esbuild step). So a global install (`npm install -g` / `yarn global add` the release tarball) resolves **nothing** and bare `ospex` works on any global store — which is the whole point (it fixed a bare-`ospex` crash on a host whose global store pinned an incompatible `@noble/hashes`). Build gotchas baked into `scripts/bundle.mjs`: ESM output (keeps `import.meta.url` valid for the bin-symlink `isMainModule` check); a `createRequire` banner so CJS deps' `require()` calls don't hit esbuild's "Dynamic require not supported" guard; versions injected via esbuild `define` (`src/lib/version.ts` — the runtime `package.json` read is only the dev/tsc fallback) so the one-file bundle reads no `package.json` at runtime; and **do not put a shebang in the banner** — esbuild already preserves the entry's `#!/usr/bin/env node`, and a second one lands on line 2 → `SyntaxError`. The `@ospex/sdk` tarball stays a normal unbundled library — its `dependencies` (`viem`, `ethers`) resolve normally for programmatic consumers like `ospex-market-maker`.
- **Yarn workspace typecheck depends on dependent build.** `@ospex/cli` imports from `@ospex/sdk`'s `dist/index.d.ts` (via the workspace symlink + `types` field). Without `dist/`, every SDK import resolves to "Cannot find module" and ~5 implicit-any errors cascade through callbacks and `catch` blocks. The CLI's `typecheck` script chains `yarn workspace @ospex/sdk build` first — don't break that chain. Long-term proper fix is TypeScript project references (`composite: true`, `tsc --build`).
- **viem `waitForTransactionReceipt` returns a receipt for both successful AND reverted transactions** — distinguished only by `receipt.status`. Without an explicit `status !== 'success'` check, write methods return "success" for txns that actually reverted on chain. `chain/client.ts:broadcastSignedTx` does this check and throws `OspexChainError({ txHash })` on revert. Any future viem-RPC interaction that "waits and returns" must do the same.
- **`tsconfig.base.json` uses `module: NodeNext`** so `import x from './y.json' with { type: 'json' }` works for ABI artifacts. Do NOT downgrade to `Node16` — TypeScript will reject import attributes with `TS2823`.
- **`CoreEventEmitted` event-log decoding requires double-wrapping in test fixtures.** Ospex's `OspexCore.emitCoreEvent(eventType, eventData)` declares `eventData` as a non-indexed `bytes` parameter. The log's `data` field is therefore the ABI-encoded form of a single `bytes` value (offset + length + payload), not the raw payload. When constructing fake receipts in tests, use `encodeAbiParameters([{ type: 'bytes' }], [innerEventData])` for the log data — passing the inner bytes directly will throw "Number ... is not in safe integer range" inside viem's decoder. Used by `positions/{settle,claim}.ts` for receipt parsing; tests at `tests/positions-{settle,claim,claimAll}.test.ts` follow the wrap pattern.
- **`parseEventLogs` from JSON-imported ABIs loses `args` typing.** viem's `parseEventLogs` only narrows `args` when the ABI is `as const`. JSON-imported ABIs (`{ type: 'json' }`) are typed as a generic `Abi[]` so `args` shows up as `never`. Workaround: `as unknown as Array<{ args: { foo: T } }>` after the call — runtime values are correct, only the static narrowing is missing. Used in `contests/{create,score}.ts` for `ContestCreated` + `RequestSent` parsing.

## Common commands

```bash
yarn install                                 # from the root
yarn workspace @ospex/sdk build              # SDK must build before CLI typechecks
yarn workspace @ospex/cli build
yarn workspace @ospex/sdk test               # vitest, unit-only — no live infra
yarn workspace @ospex/cli test
yarn typecheck                               # both packages
node packages/cli/dist/index.js <command>    # run CLI without linking
```

## What lives where (when in doubt)

- Public SDK types in `packages/sdk/src/types/` — re-exported from the package barrel.
- Internal API response shapes in `packages/sdk/src/api/types.ts` — never re-exported.
- Errors in `packages/sdk/src/errors.ts`.
- KeystoreSigner in `packages/sdk/src/signers/keystore.ts` — exposed via subpath, NOT the main barrel.

## Wallet — Foundry-first by design

The SDK and CLI deliberately do not handle raw private keys. The recommended setup is `cast wallet new ~/.foundry/keystores <name>` (note the dir-then-name positional form — `cast wallet new <name>` alone treats `<name>` as a directory and fails on cast 1.5.x) for a brand-new key, or `cast wallet import <name>` for an existing one. Then `export OSPEX_KEYSTORE_PATH=~/.foundry/keystores/<name>`. Ospex consumes a standard v3 keystore and prompts for the Foundry passphrase only when a signature is needed. The user-facing walkthrough is [`docs/QUICKSTART.md`](./docs/QUICKSTART.md). This positioning keeps key-handling liability outside Ospex — Foundry's keystore is the trusted boundary.

`OSPEX_KEYSTORE_PATH` (precedence: env > default `~/.ospex/keystore.json`) is the override seam. `OSPEX_HOME` still moves the rest of the `.ospex/` directory; the keystore-path override is independent so a Foundry keystore can sit outside the Ospex home directory without disturbing config or session paths.

Foundry-produced keystores omit the top-level `address` field that ethers' `encryptKeystoreJson` writes. `lib/keystore.ts:getKeystoreAddressIfPresent` returns null in that case; `wallet/address.ts` falls back to a passphrase-driven `KeystoreSigner.unlock(...).getAddress()` call. Any future code that wants the address cheaply must use the helper and handle the null case the same way.

## CLI session-cache trade-off (legacy path)

`ospex wallet import` / `unlock` / `lock` and the on-disk session cache predate the Foundry-first stance and are kept for backwards compatibility. New users should not be steered to them. `ospex wallet unlock` writes the decrypted private key to `~/.ospex/session` plain JSON, mode 0600, 15-minute expiry. The parent dir is mode 0700. Both are written atomically via `lib/secure-fs.ts` (temp + rename + defensive chmod) so overwriting an existing path tightens the mode rather than inheriting it.

0600 keeps the file unreadable by other users on the host but does not protect against any process running as the same user. The Foundry path side-steps this entirely — no decrypted material is persisted; each write prompts for the passphrase. Documented in `packages/cli/src/lib/client.ts`.

## Vocabulary — match the contracts

The SDK + CLI use `Contest`, `Speculation`, and `Position` as the entity names — same as the on-chain structs in `OspexTypes.sol`. Each is a first-class entity:

- **`client.contests.{list, get}`** + `ospex contests {list, show <id>}` — `GET /v1/contests`, `GET /v1/contests/:contestId`. Detail endpoint embeds `speculations[]` with their orderbooks.
- **`client.speculations.{list, get}`** + `ospex speculations {list, show <id>}` — `GET /v1/speculations`, `GET /v1/speculations/:speculationId`. Detail endpoint returns `orderbook[]` plus a 5-field parent `contest` context block.
- **`client.commitments.{list, get}`** + `ospex commitments {list, show <hash>}` — `GET /v1/commitments` (filters: `maker, scorer, contestId, speculationId, status`), `GET /v1/commitments/:hash`.

`Speculation` always carries `contestId` (mirrors the on-chain struct field 1) so a speculation row is meaningful standalone.

`MarketType` (`'moneyline' | 'spread' | 'total'`) is kept as a tag for the odds-data layer — it parallels the on-chain `ContestMarket` struct and the writer's `current_odds.market` column. It's used by `Commitment.marketType` (which scorer the wager points at) and the per-market odds shapes (`MoneylineOdds` / `SpreadOdds` / `TotalOdds`). Not an alias for any SDK entity.

## What's implemented

- **M1**: reads (`contests.{list, get}`, `speculations.{list, get}`, `commitments.{list, get}`, `positions`, `leaderboard`, `protocol`, `health`), Signer abstraction, KeystoreSigner, odds surface via `client.odds.{snapshot, subscribe}` — `snapshot(contestId)` reads `GET /v1/contests/:contestId/odds` (one-shot upstream reference odds for the contest's underlying game; user-facing path), `subscribe({ contestId, market }, handlers)` opens the core-api odds SSE stream (`GET /v1/stream/odds`) for one market and delivers the market-specific shape (agent-facing, NDJSON contract under `--json`). The odds subscribe migrated from Supabase Realtime to core-api SSE in 0.3.0. CLI: read commands + `wallet {import, address, unlock, lock}` plus `ospex odds {show, watch}`.
- **M2**: `commitments.{submit, match, approve, cancel}` via `client.commitments`. Per-instance nonce counter (`max(floor, lastInProcess+1, unixSec)`). EIP-712 helpers in `src/chain/eip712.ts`. Chain client adapter in `src/chain/client.ts`. ABI + addresses in `src/contracts/`. Errors: `OspexAllowanceError` + `OspexChainError`. CLI: `init` + `commitments {approve, submit, match, cancel}` with allowance-prompt-and-retry.
- **M2.5**: on-chain cancel + nonce-floor surface. `commitments.{cancelOnchain, raiseMinNonce, cancelAllOnSpeculation, getNonceFloor}` via `client.commitments`. `cancelOnchain(hash)` fetches the full struct from `/v1/commitments/:hash`, encodes `MatchingModule.cancelCommitment(commitment)`, signs and sends. `cancelAllOnSpeculation` picks `newMinNonce = max(onChainFloor, lastInProcess, supabaseMaxStored) + 1` by default (override via `newMinNonce`), counts affected rows up-front, and returns `invalidatedCount`. Known `MatchingModule__NotCommitmentMaker` / `MatchingModule__NonceMustIncrease` reverts decode (structured + raw-selector paths) into `OspexChainError({ reason })` — selector matching lives in `src/commitments/matchingErrors.ts`. `Commitment.isLive` derived predicate (`status==='open' && !nonceInvalidated`) computed in the API mapper so consumers never have to remember the second clause. CLI: `commitments {cancel-onchain, cancel-all, nonce-floor}` plus `cancel --also-onchain` for the recommended off-chain-then-on-chain pattern. Idempotent re-cancel by design (the contract has no `AlreadyCancelled` revert path — documented in `cancelOnchain` jsdoc and Section 10.4 of the manual playbook).
- **M3**: Position lifecycle. `positions.{claimParams, claim, settleSpeculation, claimAll, byTx, claimResult}` via `client.positions`. Receipt-driven payout / winSide parsing from `OspexCore.CoreEventEmitted` logs (`POSITION_CLAIMED`, `SPECULATION_SETTLED`). Three-bucket status (`active | pendingSettle | claimable`) — pendingSettle covers winners on scored-but-not-settled speculations. CLI: `positions history`, `claim`, `settle`, `claim-all` (with `--dry-run`), and the existing `positions status` extended to show pendingSettle. Depends on the multi-step `txParams[]` shape from the core API. Implicit signer / no per-call signer arg, mirroring M2 ergonomics.
- **M4**: Contest creation + scoring. `contests.{scripts, get, list, waitForVerified, create, score, approveLink, approveFee, invalidateScriptsCache}` via `client.contests`. `create({ gameId })` submits `OracleModule.createContestFromOracle` — first resolves `gameId` (the stable jsonodds_id from `client.games.list/get`) to the game row via `GET /v1/games/:gameId` and pulls the three external IDs the contract requires; refuses if the game's `canCreateContest` is false; then pre-flights LINK→OracleModule and USDC→TreasuryModule allowance, fetches script source from GitHub, hash-verifies before tx, fetches encrypted Chainlink secrets from the secrets API, parses `ContestCreated` from receipt for `contestId`. `score` mirrors the pipeline for `OracleModule.scoreContestFromOracle` (LINK only, no fee). `waitForVerified` polls on-chain `ContestModule.getContest` (NOT Supabase — pre-flight noted that the indexer can park `CONTEST_VERIFIED` in `pending_events`). `scripts()` cached 5min per Contests instance; cache-bust via `invalidateScriptsCache()` after a re-sign deploy. New errors: `OspexScriptApprovalError`, `OspexSubscriptionError`. Depends on the core API's `GET /v1/contests/scripts/approved`. CLI: `ospex contests {create, score, show, list, wait-verified, scripts}` — `create` takes a single `--game-id`, no external-id flags exposed.
- **M4 games surface**: `client.games.{list, get}` reads `GET /v1/games[/:gameId]` from the core API. `gameId` is the row's `jsonodds_id` (part of the games pkey, immutable); the writer's `slug` is exposed for display but is mutable, so do not use it as a lookup key. The public `Game` type carries `externalIds` for symmetry and advanced consumers, but the canonical user flow hides them — `client.contests.create({ gameId })` handles the resolution server-side. CLI: `ospex games list` defaults to showing every upcoming game on the schedule — the `creatable` column flags which rows can be passed to `contests create --game-id`. Pass `--creatable-only` to narrow to those rows (all three external IDs present, status=upcoming, contest_created=false). `--all` is preserved as a deprecated no-op alias of the new default for back-compat with older scripts. `availableOnly` filtering is a server-side predicate, not client-side, so paginated listings are accurate; the CLI explicitly passes `availableOnly=false` (rather than relying on the API's `availableOnly=true` default) so the schedule view doesn't depend on whether the client and server agree on the default.
- **Integration validation**: manual playbook at `docs/MANUAL_INTEGRATION_TESTING.md`. Walked before every release; nine sections, M1 + M2 + M3 surfaces, ~20-25 minutes against Amoy. M4 (`contests create` / `contests score`) requires mainnet — Amoy contracts are wired but the API's `scriptApprovals.amoy` bundle is `null`, so the SDK returns `OspexScriptApprovalError(reason: 'not_configured')`. The creation fee is read from `TreasuryModule.s_feeRates(0)` at runtime (1 USDC on mainnet at time of writing); plus LINK for the verify and score Chainlink Functions calls (the SDK preflight quotes the exact amounts). For lightweight smoke checks of the rest of the surface, match an open commitment whose preview shows `tradeAction: 'trade-only'` (existing speculation) — only gas and commitment risk apply, no creation fees. See "Calendar" below for the verify-script re-sign deadline.

## What's deferred

- M2.5 (still deferred): `commitments.matches.subscribe` (a core-api SSE stream for match events); cross-process `nonceProvider` injection on `OspexClient` (waits on `ospex-market-maker` to surface concrete coordination needs); optional `GET /v1/makers/:address/nonce-floor` core-api endpoint for read-only / no-RPC clients.
- M3.5: a dedicated settlement-event SSE stream for `POSITION_CLAIMED` / `SPECULATION_SETTLED` (the S1 `positions` / `fills` protocol streams already cover most of this). On-chain Multicall3-based bulk claim (defer to demand). Auto-claim daemon (out of SDK scope; market-maker / agent territory).
- M4.5: `contests.updateMarkets()` + `ospex contests update-markets` (odds refresh — not lifecycle-critical, mainly for frontend display). Watcher CLI (`ospex contests watch`) for auto-update-markets / auto-score on schedule. A `contests` / `speculations` stream so `waitForVerified` can subscribe instead of polling (requires indexer publication membership). Amoy `POLYGON_AMOY_R4_SCRIPT_APPROVALS.md` + `scriptApprovals.amoy.json` so M4 is testable on Amoy too.
- M5: Secondary-market position UX. Speculation-creation methods (auto-creates on first commitment match per pre-flight §3 — no operator surface needed).

## Calendar — re-sign verify approval before 2026-11-27

The Polygon mainnet verify-script approval expires `1795737600` (2026-11-27T00:00:00Z). After expiry, `OracleModule.createContestFromOracle` reverts on every new contest until `APPROVED_SIGNER` (`0xfd6C7Fc1F182de53AA636584f1c6B80d9D885886`) re-signs and the core API redeploys with the new signature.

Re-signing uses the Foundry-keystore flow in the contracts repo at `script-approvals/` (`cast wallet sign` with the `ospex-mainnet-signer` keystore — no raw key on the CLI): it fetches the current public script source, computes keccak256, and signs the EIP-712 ScriptApproval struct against the on-chain OracleModule domain. (The older `scripts/sign-script-approval.js` ethers/raw-key path still exists but is superseded.) Existing contests are unaffected (the contract verifies the existing signature only at creation time; subsequent ops validate by hash-match against the per-contest stored hash).

After re-signing, update the core API's committed `scriptApprovals` data: bump `verify.signature` and `verify.validUntil`, and also `verify.scriptHash` whenever the JS source changed — it did for the 2026-05-27 Athletics MLB `teamLegend` fix (`0x01c48e15…` → `0xec6a7e9c…`); a pure expiry renewal with an unchanged source keeps the same hash. Then redeploy the core API. SDK consumers pick up the new approval on their next `client.contests.scripts()` call (5-min TTL).
