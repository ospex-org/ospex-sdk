# CLAUDE.md

The Ospex SDK + CLI monorepo. Inherits from `~/Documents/CLAUDE.md` and from `~/Documents/solidity/ospex-matched-pairs/CLAUDE.md` — git workflow, yarn-not-npm, TypeScript hygiene, and the broader Ospex landscape live there. Don't duplicate.

## Layout

- `packages/sdk` — `@ospex/sdk`. Public TypeScript SDK. Reads, EIP-712 helpers, Realtime odds.
- `packages/cli` — `@ospex/cli`. `ospex` binary on top of the SDK.

Yarn 1 workspaces. Commands run from the root or scoped: `yarn workspace @ospex/sdk <cmd>`.

## Source-of-truth pointers

- **Schema**: `ospex-indexer/schema/live.sql`. Hand-written DB row types in `packages/sdk/src/db/types.ts` mirror that file. When the schema moves, update the dump first, then the SDK types.
- **API contract**: `ospex-core-api/src/v1/`. The internal API response types in `packages/sdk/src/api/types.ts` mirror those handlers. When `ospex-core-api` changes a response shape, update both ends in lockstep.
- **Contracts**: ABIs live at `packages/sdk/src/contracts/abi/`. `MatchingModule.json`, `PositionModule.json`, `SpeculationModule.json`, `ContestModule.json`, and `OracleModule.json` are full Foundry artifacts, refreshed by copying from `ospex-foundry-matched-pairs/out/<Module>.sol/<Module>.json` on contract redeploy. `erc20.ts` is hand-written and reused for both USDC and LINK (both ERC-20-compatible for our needs). `addresses.ts` carries deployed addresses (incl. `linkToken`) for chain id 137 (mainnet) and 80002 (Amoy) — refresh from `docs/deployment/POLYGON_MAINNET_R4_output.txt` and `broadcast/DeployAmoy.s.sol/80002/run-latest.json` respectively. `constants.ts` carries M4 chainwise constants: `LINK_PAYMENT_PER_CALL_WEI`, `OSPEX_SHARED_SUBSCRIPTION_ID`, `APPROVED_SIGNER_BY_CHAIN`, `OSPEX_API_SERVER_URL`, `OSPEX_DEFAULT_GAS_LIMIT`, verification-poll defaults.
- **Script approvals (M4)**: `client.contests.scripts()` fetches `GET /v1/contests/scripts/approved` from core-api and caches the result for 5 minutes per Contests instance. Source data is committed in core-api at `src/data/scriptApprovals.ts`; refreshing approvals (notably the verify approval re-sign) requires only a core-api redeploy, no SDK release. The verify JS source itself is fetched from a public GitHub URL the approval points at and hash-checked locally before any tx is built — a hash mismatch throws `OspexScriptApprovalError(reason='hash_mismatch')` and never wastes gas/USDC on a guaranteed revert.
- **Encrypted Chainlink Functions secrets**: fetched from `https://secrets.ospex.org/api/get-encrypted-secrets` (protocol-stable alias for the Heroku app `ospex-api`). Override via `ContestsContext.apiServerUrl` for tests / local stubs.

## Hard rules

- **CLI never imports SDK internals.** Only `@ospex/sdk` and `@ospex/sdk/signers/keystore` — anything else is a layering violation.
- **No network parameter on the public SDK.** A client is configured for one network; the API returns the network id, the SDK never asks the user.
- **No module-level state in the SDK.** Multiple `OspexClient` instances must be fully isolated.
- **Errors are typed.** Throw `OspexAPIError`, `OspexConfigError`, `OspexValidationError`, `OspexSigningError`, `OspexAllowanceError`, `OspexChainError`, `OspexScriptApprovalError`, or `OspexSubscriptionError` — never strings.
- **Contest creation fee → TreasuryModule, not PositionModule.** `OspexAllowanceError.spender` for M4 contest writes is `TreasuryModule` (USDC) or `OracleModule` (LINK) — distinct from M2's USDC→PositionModule path. The CLI's `handleContestAllowance` distinguishes by comparing `err.spender` to `getAddresses(chainId).oracleModule`.
- **All I/O is async.** No mixed sync/async surfaces.

## Build & dependency gotchas

- **Yarn workspace typecheck depends on dependent build.** `@ospex/cli` imports from `@ospex/sdk`'s `dist/index.d.ts` (via the workspace symlink + `types` field). Without `dist/`, every SDK import resolves to "Cannot find module" and ~5 implicit-any errors cascade through callbacks and `catch` blocks. The CLI's `typecheck` script chains `yarn workspace @ospex/sdk build` first — don't break that chain. Long-term proper fix is TypeScript project references (`composite: true`, `tsc --build`).
- **viem `waitForTransactionReceipt` returns a receipt for both successful AND reverted transactions** — distinguished only by `receipt.status`. Without an explicit `status !== 'success'` check, write methods return "success" for txns that actually reverted on chain. `chain/client.ts:broadcastSignedTx` does this check and throws `OspexChainError({ txHash })` on revert. Any future viem-RPC interaction that "waits and returns" must do the same.
- **`tsconfig.base.json` uses `module: NodeNext`** so `import x from './y.json' with { type: 'json' }` works for ABI artifacts. Do NOT downgrade to `Node16` — TypeScript will reject import attributes with `TS2823`.
- **`CoreEventEmitted` event-log decoding requires double-wrapping in test fixtures.** Ospex's `OspexCore.emitCoreEvent(eventType, eventData)` declares `eventData` as a non-indexed `bytes` parameter. The log's `data` field is therefore the ABI-encoded form of a single `bytes` value (offset + length + payload), not the raw payload. When constructing fake receipts in tests, use `encodeAbiParameters([{ type: 'bytes' }], [innerEventData])` for the log data — passing the inner bytes directly will throw "Number ... is not in safe integer range" inside viem's decoder. Used by `positions/{settle,claim}.ts` for receipt parsing; tests at `tests/positions-{settle,claim,claimAll}.test.ts` follow the wrap pattern.
- **`parseEventLogs` from JSON-imported ABIs loses `args` typing.** viem's `parseEventLogs` only narrows `args` when the ABI is `as const`. JSON-imported ABIs (`{ type: 'json' }`) are typed as a generic `Abi[]` so `args` shows up as `never`. Workaround: `as unknown as Array<{ args: { foo: T } }>` after the call — runtime values are correct, only the static narrowing is missing. Used in `contests/{create,score}.ts` for `ContestCreated` + `RequestSent` parsing.

## Bootstrap config

Public Realtime credentials come from `GET /v1/config/public` on `ospex-core-api`. The SDK fetches it lazily on the first realtime call. Don't bake the Supabase publishable key into client code — when it rotates, the bootstrap endpoint serves the new value without a SDK release.

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
- DB row types in `packages/sdk/src/db/types.ts` — internal, used by Realtime payloads.
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

`MarketType` (`'moneyline' | 'spread' | 'total'`) is kept as a tag for the odds-data layer — it parallels the on-chain `ContestMarket` struct and the `current_odds.market` Supabase column. It's used by `Commitment.marketType` (which scorer the wager points at) and `OddsSnapshot.market`. Not an alias for any SDK entity.

## What's implemented

- **M1**: reads (`contests.{list, get}`, `speculations.{list, get}`, `commitments.{list, get}`, `positions`, `leaderboard`, `protocol`, `health`), Signer abstraction, KeystoreSigner, Realtime odds via `client.odds.subscribe`. CLI: read commands + `wallet {import, address, unlock, lock}`.
- **M2**: `commitments.{submit, match, approve, cancel}` via `client.commitments`. Per-instance nonce counter (`max(floor, lastInProcess+1, unixSec)`). EIP-712 helpers in `src/chain/eip712.ts`. Chain client adapter in `src/chain/client.ts`. ABI + addresses in `src/contracts/`. Errors: `OspexAllowanceError` + `OspexChainError`. CLI: `init` + `commitments {approve, submit, match, cancel}` with allowance-prompt-and-retry.
- **M2.5**: on-chain cancel + nonce-floor surface. `commitments.{cancelOnchain, raiseMinNonce, cancelAllOnSpeculation, getNonceFloor}` via `client.commitments`. `cancelOnchain(hash)` fetches the full struct from `/v1/commitments/:hash`, encodes `MatchingModule.cancelCommitment(commitment)`, signs and sends. `cancelAllOnSpeculation` picks `newMinNonce = max(onChainFloor, lastInProcess, supabaseMaxStored) + 1` by default (override via `newMinNonce`), counts affected rows up-front, and returns `invalidatedCount`. Known `MatchingModule__NotCommitmentMaker` / `MatchingModule__NonceMustIncrease` reverts decode (structured + raw-selector paths) into `OspexChainError({ reason })` — selector matching lives in `src/commitments/matchingErrors.ts`. `Commitment.isLive` derived predicate (`status==='open' && !nonceInvalidated`) computed in the API mapper so consumers never have to remember the second clause. CLI: `commitments {cancel-onchain, cancel-all, nonce-floor}` plus `cancel --also-onchain` for the recommended off-chain-then-on-chain pattern. Idempotent re-cancel by design (the contract has no `AlreadyCancelled` revert path — documented in `cancelOnchain` jsdoc and Section 10.4 of the manual playbook).
- **M3**: Position lifecycle. `positions.{claimParams, claim, settleSpeculation, claimAll, byTx, claimResult}` via `client.positions`. Receipt-driven payout / winSide parsing from `OspexCore.CoreEventEmitted` logs (`POSITION_CLAIMED`, `SPECULATION_SETTLED`). Three-bucket status (`active | pendingSettle | claimable`) — pendingSettle covers winners on scored-but-not-settled speculations. CLI: `positions history`, `claim`, `settle`, `claim-all` (with `--dry-run`), and the existing `positions status` extended to show pendingSettle. Depends on the multi-step `txParams[]` shape introduced in `ospex-core-api` PR #11. Implicit signer / no per-call signer arg, mirroring M2 ergonomics.
- **M4**: Contest creation + scoring. `contests.{scripts, get, list, waitForVerified, create, score, approveLink, approveFee, invalidateScriptsCache}` via `client.contests`. `create` submits `OracleModule.createContestFromOracle` — pre-flights LINK→OracleModule and USDC→TreasuryModule allowance, fetches script source from GitHub, hash-verifies before tx, fetches encrypted Chainlink secrets from `ospex-api-server`, parses `ContestCreated` from receipt for `contestId`. `score` mirrors the pipeline for `OracleModule.scoreContestFromOracle` (LINK only, no fee). `waitForVerified` polls on-chain `ContestModule.getContest` (NOT Supabase — pre-flight noted indexer can park `CONTEST_VERIFIED` in `pending_events`). `scripts()` cached 5min per Contests instance; cache-bust via `invalidateScriptsCache()` after a re-sign deploy. New errors: `OspexScriptApprovalError`, `OspexSubscriptionError`. Depends on `ospex-core-api` `GET /v1/contests/scripts/approved` (lands first). CLI: `ospex contests {create, score, show, list, wait-verified, scripts}`.
- **Integration validation**: manual playbook at `docs/MANUAL_INTEGRATION_TESTING.md`. Walked before every release; nine sections, M1 + M2 + M3 surfaces, ~20-25 minutes against Amoy. M4 requires Polygon mainnet (Amoy script approvals are not committed) — see "Calendar" below.

## What's deferred

- M2.5 (still deferred): `commitments.matches.subscribe` (Realtime channel for match events); cross-process `nonceProvider` injection on `OspexClient` (waits on `ospex-market-maker` to surface concrete coordination needs); optional `GET /v1/makers/:address/nonce-floor` core-api endpoint for read-only / no-RPC clients.
- M3.5: Realtime `positions` subscription (Supabase channel for `POSITION_CLAIMED` / `SPECULATION_SETTLED` rows). On-chain Multicall3-based bulk claim (defer to demand). Auto-claim daemon (out of SDK scope; market-maker / agent territory).
- M4.5: `contests.updateMarkets()` + `ospex contests update-markets` (odds refresh — not lifecycle-critical, mainly for frontend display). Watcher CLI (`ospex contests watch`) for auto-update-markets / auto-score on schedule. Realtime publication membership for `contests` / `speculations` so `waitForVerified` can use a Supabase channel instead of polling (requires indexer migration). Amoy `POLYGON_AMOY_R4_SCRIPT_APPROVALS.md` + `scriptApprovals.amoy.json` so M4 is testable on Amoy too.
- M5: Secondary-market position UX. Speculation-creation methods (auto-creates on first commitment match per pre-flight §3 — no operator surface needed).

## Calendar — re-sign verify approval before 2026-10-26

The Polygon mainnet verify-script approval expires `1793030835` (2026-10-26T16:07:15Z). After expiry, `OracleModule.createContestFromOracle` reverts on every new contest until `APPROVED_SIGNER` (`0xfd6C7Fc1F182de53AA636584f1c6B80d9D885886` — Vince's deployer key) re-signs and `core-api` redeploys with the new signature.

Re-signing tool: `ospex-foundry-matched-pairs/scripts/sign-script-approval.js` — fetches the current GitHub source, computes keccak256, signs the EIP-712 ScriptApproval struct against the on-chain OracleModule domain. Existing contests are unaffected (the contract verifies the existing signature only at creation time; subsequent ops validate by hash-match against the per-contest stored hash).

After re-signing, edit `ospex-core-api/src/data/scriptApprovals.ts` and bump only the `verify.signature` and `verify.validUntil` fields — `scriptHash` stays identical (the JS source hasn't changed). Then `git push heroku main` to publish. SDK consumers pick up the new approval on their next `client.contests.scripts()` call (5-min TTL).
