# CLAUDE.md

The Ospex SDK + CLI monorepo. Inherits from `~/Documents/CLAUDE.md` and from `~/Documents/solidity/ospex-matched-pairs/CLAUDE.md` — git workflow, yarn-not-npm, TypeScript hygiene, and the broader Ospex landscape live there. Don't duplicate.

## Layout

- `packages/sdk` — `@ospex/sdk`. Public TypeScript SDK. Reads, EIP-712 helpers, Realtime odds.
- `packages/cli` — `@ospex/cli`. `ospex` binary on top of the SDK.

Yarn 1 workspaces. Commands run from the root or scoped: `yarn workspace @ospex/sdk <cmd>`.

## Source-of-truth pointers

- **Schema**: `ospex-indexer/schema/live.sql`. Hand-written DB row types in `packages/sdk/src/db/types.ts` mirror that file. When the schema moves, update the dump first, then the SDK types.
- **API contract**: `ospex-core-api/src/v1/`. The internal API response types in `packages/sdk/src/api/types.ts` mirror those handlers. When `ospex-core-api` changes a response shape, update both ends in lockstep.
- **Contracts**: ABIs live at `packages/sdk/src/contracts/abi/`. `MatchingModule.json` is the full Foundry artifact, refreshed by copying from `ospex-foundry-matched-pairs/out/MatchingModule.sol/MatchingModule.json` on contract redeploy. `erc20.ts` is hand-written (USDC). `addresses.ts` carries deployed addresses for chain id 137 (mainnet) and 80002 (Amoy) — refresh from `docs/deployment/POLYGON_MAINNET_R4_output.txt` and `broadcast/DeployAmoy.s.sol/80002/run-latest.json` respectively.

## Hard rules

- **CLI never imports SDK internals.** Only `@ospex/sdk` and `@ospex/sdk/signers/keystore` — anything else is a layering violation.
- **No network parameter on the public SDK.** A client is configured for one network; the API returns the network id, the SDK never asks the user.
- **No module-level state in the SDK.** Multiple `OspexClient` instances must be fully isolated.
- **Errors are typed.** Throw `OspexAPIError`, `OspexConfigError`, `OspexValidationError`, `OspexSigningError`, `OspexAllowanceError`, or `OspexChainError` — never strings.
- **All I/O is async.** No mixed sync/async surfaces.

## Build & dependency gotchas

- **Yarn workspace typecheck depends on dependent build.** `@ospex/cli` imports from `@ospex/sdk`'s `dist/index.d.ts` (via the workspace symlink + `types` field). Without `dist/`, every SDK import resolves to "Cannot find module" and ~5 implicit-any errors cascade through callbacks and `catch` blocks. The CLI's `typecheck` script chains `yarn workspace @ospex/sdk build` first — don't break that chain. Long-term proper fix is TypeScript project references (`composite: true`, `tsc --build`).
- **viem `waitForTransactionReceipt` returns a receipt for both successful AND reverted transactions** — distinguished only by `receipt.status`. Without an explicit `status !== 'success'` check, write methods return "success" for txns that actually reverted on chain. `chain/client.ts:broadcastSignedTx` does this check and throws `OspexChainError({ txHash })` on revert. Any future viem-RPC interaction that "waits and returns" must do the same.
- **`tsconfig.base.json` uses `module: NodeNext`** so `import x from './y.json' with { type: 'json' }` works for ABI artifacts. Do NOT downgrade to `Node16` — TypeScript will reject import attributes with `TS2823`.

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

## CLI session-cache trade-off

`ospex wallet unlock` writes the decrypted private key to `~/.ospex/session` plain JSON, mode 0600, 15-minute expiry. The parent dir is mode 0700. Both are written atomically via `lib/secure-fs.ts` (temp + rename + defensive chmod) so overwriting an existing path tightens the mode rather than inheriting it.

0600 keeps the file unreadable by other users on the host but does not protect against any process running as the same user. OS-keychain integration (DPAPI / Keychain / libsecret) is the higher-assurance option and is out of scope for v1. If that matters for the use case at hand, run write commands without `wallet unlock` — each one prompts for the passphrase inline and never writes the decrypted key to disk. Documented in `packages/cli/src/lib/client.ts`.

## What's implemented

- **M1**: reads (`markets`, `commitments.list`, `positions`, `leaderboard`, `protocol`, `health`), Signer abstraction, KeystoreSigner, Realtime odds via `client.odds.subscribe`. CLI: read commands + `wallet {import, address, unlock, lock}`.
- **M2**: `commitments.{submit, match, approve, cancel}` via `client.commitments`. Per-instance nonce counter (`max(floor, lastInProcess+1, unixSec)`). EIP-712 helpers in `src/chain/eip712.ts`. Chain client adapter in `src/chain/client.ts`. ABI + addresses in `src/contracts/`. Errors: `OspexAllowanceError` + `OspexChainError`. CLI: `init` + `commitments {approve, submit, match, cancel}` with allowance-prompt-and-retry.
- **Integration validation**: manual playbook at `docs/MANUAL_INTEGRATION_TESTING.md`. Walked before every release; eight sections, M1 + M2 surfaces, ~15-20 minutes against Amoy.

## What's deferred

- M2.5: on-chain `cancelCommitment` + `raiseMinNonce` (bulk cancel-by-nonce); `commitments.matches.subscribe` (Realtime channel for match events); cross-process nonce coordination helpers; optional `GET /v1/makers/:address/nonce-floor` core-api endpoint for read-only / no-RPC clients.
- M3: Position lifecycle (claims, payouts).
- M4: Contest creation surface for ops tooling.
