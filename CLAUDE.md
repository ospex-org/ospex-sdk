# CLAUDE.md

The Ospex SDK + CLI monorepo. Inherits from `~/Documents/CLAUDE.md` and from `~/Documents/solidity/ospex-matched-pairs/CLAUDE.md` — git workflow, yarn-not-npm, TypeScript hygiene, and the broader Ospex landscape live there. Don't duplicate.

## Layout

- `packages/sdk` — `@ospex/sdk`. Public TypeScript SDK. Reads, EIP-712 helpers, Realtime odds.
- `packages/cli` — `@ospex/cli`. `ospex` binary on top of the SDK.

Yarn 1 workspaces. Commands run from the root or scoped: `yarn workspace @ospex/sdk <cmd>`.

## Source-of-truth pointers

- **Schema**: `ospex-indexer/schema/live.sql`. Hand-written DB row types in `packages/sdk/src/db/types.ts` mirror that file. When the schema moves, update the dump first, then the SDK types.
- **API contract**: `ospex-core-api/src/v1/`. The internal API response types in `packages/sdk/src/api/types.ts` mirror those handlers. When `ospex-core-api` changes a response shape, update both ends in lockstep.
- **Contracts**: ABIs are not committed yet — M1 is read-side only. M2 will copy the canonical artifacts into `packages/sdk/src/contracts/abi/` from `ospex-foundry-matched-pairs/out/<Contract>.sol/<Contract>.json`. Refresh on contract redeploy.

## Hard rules

- **CLI never imports SDK internals.** Only `@ospex/sdk` and `@ospex/sdk/signers/keystore` — anything else is a layering violation.
- **No network parameter on the public SDK.** A client is configured for one network; the API returns the network id, the SDK never asks the user.
- **No module-level state in the SDK.** Multiple `OspexClient` instances must be fully isolated.
- **Errors are typed.** Throw `OspexAPIError`, `OspexConfigError`, `OspexValidationError`, or `OspexSigningError` — never strings.
- **All I/O is async.** No mixed sync/async surfaces.

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

`ospex wallet unlock` writes the decrypted private key to `~/.ospex/session` plain JSON, mode 0600, 15-minute expiry. OS-keychain integration (DPAPI / Keychain / libsecret) is out of scope for v1. If higher assurance is needed, run write commands without `wallet unlock` — each one prompts for the passphrase inline and never writes the decrypted key to disk. Documented in `packages/cli/src/lib/client.ts`.

## What's deferred

- M2: `commitments.submit`, `commitments.cancel`, `commitments.matches.subscribe`. ABI artifacts under `packages/sdk/src/contracts/abi/`. Chain client in `packages/sdk/src/chain/`. `rpcUrl` becomes a required SDK config (no default) when chain writes ship.
- M3: Position lifecycle (claims, payouts).

When you scaffold M2, create the `chain/` and `contracts/abi/` directories then — they're intentionally absent from M1 to keep the repo clean of empty placeholders.
