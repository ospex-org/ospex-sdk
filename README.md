# Ospex SDK + CLI

TypeScript SDK and command-line interface for the [Ospex](https://ospex.org) protocol — zero-vig peer-to-peer sports prediction on Polygon. M2 ships the EIP-712 signed-commitment surface (`submit`, `match`, `approve`, `cancel`) on top of the M1 read-side. Position lifecycle (claims, payouts) is M3.

This repo is a Yarn 1 workspaces monorepo with two packages:

- [`@ospex/sdk`](./packages/sdk) — the public TypeScript SDK.
- [`@ospex/cli`](./packages/cli) — the `ospex` binary, built on top of the SDK.

> Building an agent / programmatic integration? See [`docs/AGENT_CONTRACT.md`](./docs/AGENT_CONTRACT.md) for the stable JSON envelopes, error-code catalog, idempotency rules, and the Realtime contract.

## Quick start (CLI)

For the minimum-friction zero-to-commitment walkthrough, see [`docs/QUICKSTART.md`](./docs/QUICKSTART.md). Short version below.

For local development from this repo (workspace-link puts `ospex` on your PATH for dev iteration):

```bash
yarn install
yarn workspace @ospex/sdk build
yarn workspace @ospex/cli build
yarn workspace @ospex/cli link
```

End users install via the tarball flow in [`docs/QUICKSTART.md`](./docs/QUICKSTART.md), not this dev-mode link.

Wallet — Ospex never asks for your private key. Set up Foundry's keystore (Ospex reads it via a path you tell it about during `ospex init`):

```bash
mkdir -p ~/.foundry/keystores
cast wallet new ~/.foundry/keystores ospex-test    # Foundry generates the key, prints only the address
                                                   # — or `cast wallet import ospex-test` for an existing key
```

Configure and read:

```bash
ospex init                                 # one-time prompts for chainId, apiUrl, rpcUrl, keystorePath
ospex health                               # liveness probe
ospex contests list --hours 168            # upcoming contests
ospex contests show <contestId>            # one contest with its full orderbook
ospex speculations list --contest <id>     # bettable lines under a contest
ospex speculations show <speculationId>    # one speculation with its orderbook + parent contest
ospex wallet address                       # prompts for Foundry passphrase, prints the address
ospex odds show <contestId>                # one-shot snapshot of upstream reference odds
ospex odds watch <contestId>               # streaming subscription (line-delimited JSON with --json)

# Chain writes — require ospex init + a configured keystore
ospex approvals setup --risk-usdc 50                         # blessed multi-spender path (also auto-includes a small fee budget)
ospex commitments approve 5                                  # single-spender shortcut: PositionModule for 5 USDC (decimal)
ospex commitments approve max                                # …or unlimited
ospex commitments approve-raw 5000000                        # raw 6-decimal-units form for power users / scripts

# High-level submit (domain-language inputs + win/lose/push preview).
# Interactive: prompts for an amount with the exact-required value as default;
# type "max" at that prompt for unlimited. Non-interactive (--yes): exact-required
# by default, or pass --approve-max alongside --yes for unlimited.
ospex commitments submit \                                   # high-level path (recommended)
  --speculation <id> --side lakers --odds 2.50 --risk-usdc 1
ospex commitments submit \                                   # by --contest, line lazy-creates if absent
  --contest <id> --market spread --side padres --line -3.5 --odds 1.91 --risk-usdc 25
ospex commitments submit-raw <contestId> <scorer> <lineTicks> upper 250 1000  # protocol escape hatch

# Match an existing maker commitment as the taker. Renders a preview block
# before signing; pass --yes to skip the prompt. Accepts a full hash OR a
# unique 0x-prefixed hex prefix (≥ 8 hex chars after 0x).
#   --json alone          → emit the MatchPreviewEnvelope (preview only)
#   --yes --json          → execute and emit the MatchJsonResult envelope
#   --risk-usdc <decimal> → taker desired risk (decimal USDC); default = full fill
ospex commitments match <hash-or-prefix>                     # interactive; preview + confirm + send
ospex commitments cancel <hash-or-prefix>                    # off-chain cancel via signed DELETE
ospex commitments cancel <hash-or-prefix> --also-onchain     # off-chain DELETE + authoritative on-chain cancel (M2.5)
ospex commitments cancel-onchain <hash-or-prefix>            # on-chain cancel only (M2.5)
ospex commitments cancel-all --contest-id <id> \             # bulk-cancel via raiseMinNonce (M2.5)
  --scorer <addr> --line <ticks> [--dry-run]
ospex commitments nonce-floor --maker <addr> \               # read on-chain nonce floor (M2.5)
  --contest-id <id> --scorer <addr> --line <ticks>
```

Distribution is via [GitHub releases](https://github.com/ospex-org/ospex-sdk/releases) — download both tarballs from the latest release and install with the tarball flow in [`docs/QUICKSTART.md`](./docs/QUICKSTART.md). The workspace-link flow above is for local development from this repo.

## Quick start (SDK)

Install via [GitHub releases](https://github.com/ospex-org/ospex-sdk/releases) — download `ospex-sdk-<ver>.tgz` and:

```bash
yarn add file:./ospex-sdk-<ver>.tgz
```

Until the first release is tagged, build the tarball locally from a clone of this repo (`yarn workspace @ospex/sdk build && yarn workspace @ospex/sdk pack --filename ospex-sdk.tgz`) and `yarn add file:/abs/path/to/ospex-sdk/packages/sdk/ospex-sdk.tgz`.

```typescript
import { OspexClient } from '@ospex/sdk';

const client = new OspexClient();

// Reads
const contests = await client.contests.list({ sport: 'nba', hours: 24 });
const contest = await client.contests.get(contestId);
const speculations = await client.speculations.list({ contestId });
const speculation = await client.speculations.get(speculationId);
const orderbook = await client.commitments.list({ speculationId });
const commitment = await client.commitments.get(commitmentHash);
const positions = await client.positions.byAddress('0x…');
const status = await client.positions.status('0x…');
const board = await client.leaderboard.active();
const info = await client.protocol.info();

// Realtime — opens a Supabase channel under the hood. The first call
// lazily fetches /v1/config/public to obtain Realtime credentials.
const sub = await client.odds.subscribe(
  { jsonoddsId, market: 'spread' },
  {
    onChange: (odds) => console.log('price moved', odds),
    onRefresh: (odds) => console.log('writer re-polled', odds),
  },
);
await sub.unsubscribe();
```

The optional keystore signer is shipped as a subpath import so consumers who don't need it don't pull `ethers` into their bundle:

```typescript
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';

const json = await KeystoreSigner.encrypt(privateKey, passphrase);
const signer = await KeystoreSigner.unlock(json, passphrase);
const address = await signer.getAddress();
const sig = await signer.signTypedData({ domain, types, primaryType, message });
```

## Configuration

Defaults point at production. Override anything via the constructor:

```typescript
new OspexClient({
  apiUrl: 'https://staging-api.example',  // defaults to ospex-core-api production URL
  supabaseUrl: '…',                       // optional override; otherwise lazy-fetched
  supabaseAnonKey: '…',                   // optional override; otherwise lazy-fetched
  signer: myCustomSigner,                 // required for any M2 write
  rpcUrl: 'https://polygon-mainnet.g.alchemy.com/v2/<key>', // required for chain ops
  chainId: 137,                           // 137 (mainnet) or 80002 (amoy); default 137
  timeoutMs: 10_000,
});
```

The CLI reads its config in this order: env var (`OSPEX_API_URL`, `OSPEX_SUPABASE_URL`, `OSPEX_SUPABASE_ANON_KEY`, `OSPEX_RPC_URL`, `OSPEX_CHAIN_ID`) > `~/.ospex/config.json` > SDK built-in defaults.

The keystore location follows the same precedence: `OSPEX_KEYSTORE_PATH` env var > `keystorePath` field in `~/.ospex/config.json` (set once via `ospex init`) > default `~/.ospex/keystore.json`. The recommended setup is to put a Foundry-managed keystore path in the config file (so future shells don't need to re-export anything), and reserve the env var for per-shell overrides — useful for scripts and CI. Leading `~/` in either source is expanded.

### About `rpcUrl`

Every chain operation (`commitments.submit`, `match`, `approve`) needs an RPC URL — the SDK uses it to read allowance and nonce floor, and to broadcast signed transactions. **Use Alchemy, Infura, or QuickNode in production.** The public Polygon RPCs (`polygon-rpc.com`, `rpc-amoy.polygon.technology`) are rate-limited and prone to drops, and `polygon-rpc.com` has been returning 401 since 2026-03 (per [`ospex-foundry-matched-pairs/docs/DEPLOYMENT.md`](../ospex-foundry-matched-pairs/docs/DEPLOYMENT.md)).

There is intentionally no public-RPC default. `ospex init` requires you to enter a value.

### USDC allowance target

Both maker and taker must approve **`PositionModule`** (NOT MatchingModule) for USDC. MatchingModule never custodies funds — it calls `PositionModule.recordFill`, which is where the `safeTransferFrom` happens. The SDK throws `OspexAllowanceError` with the structured shortfall when allowance is short; the CLI prompts to approve and retries.

### Sovereign cancel — off-chain DELETE vs. on-chain cancel

Off-chain `commitments.cancel(hash)` (DELETE `/v1/commitments/:hash`) marks the row cancelled in the API so the relay stops surfacing it. It does **not** prevent a taker who already holds the signed payload from matching the commitment — the contract still treats it as valid until `s_cancelledCommitments[hash]` flips on chain. For an authoritative cancel, use `commitments.cancelOnchain(hash)` (M2.5) which calls `MatchingModule.cancelCommitment(commitment)` directly. The CLI's `commitments cancel <hash> --also-onchain` runs both in sequence — the recommended pattern.

For bulk cancel ("revoke every order I have on this speculation"), `commitments.cancelAllOnSpeculation({ contestId, scorer, lineTicks })` raises the maker's on-chain nonce floor so all sub-floor commitments become unmatchable in a single tx. The default `newMinNonce` is computed from `max(onChainFloor, lastInProcess, supabaseMaxStored) + 1` — override via the optional `newMinNonce` arg. The contract has no `AlreadyCancelled` revert path; calling `cancelOnchain` on a hash that's already cancelled is a no-op success, so don't infer "first cancel" from tx success.

## CLI command reference

| Command | What it does |
|---|---|
| `ospex init` | Interactive setup — writes `~/.ospex/config.json` (rpcUrl, chainId, apiUrl, keystorePath). |
| `ospex health` | Hits `/healthz` and prints liveness info. |
| `ospex contests list [--sport --status --hours --limit --offset]` | Lists upcoming contests with their speculations. |
| `ospex contests show <contestId>` | One contest with its full orderbook. |
| `ospex games list [--sport --hours --creatable-only]` | List upcoming games on the schedule. Default shows every upcoming game; the `creatable` column flags which rows can be passed to `contests create --game-id`. Pass `--creatable-only` to narrow to those creatable rows. `--all` is preserved as a deprecated no-op alias of the new default. |
| `ospex contests create --game-id <id>` (or `--game <slug-or-id>`) | Submit `OracleModule.createContestFromOracle` (M4). `gameId` is the stable id from `ospex games list`; the SDK resolves the three external IDs server-side. `--game` is a resolver alias accepting either the slug or a UUID. |
| `ospex contests score <contestId>` | Submit `OracleModule.scoreContestFromOracle` (M4). |
| `ospex contests wait-verified <contestId>` | Poll until the contest reaches Verified state (M4). |
| `ospex contests scripts` | Show the EIP-712 script approvals (debug). |
| `ospex speculations list [--contest --sport --status --limit --offset]` | List speculations across one or more contests. |
| `ospex speculations show <speculationId>` | One speculation with its orderbook + parent contest context. |
| `ospex commitments show <hash-or-prefix>` | Single commitment lookup. Accepts a full EIP-712 hash or a unique 0x-prefixed hex prefix (≥ 8 hex chars). Resolves over all statuses (cancelled / expired rows included). |
| `ospex commitments list [... --speculation <id> ...]` | Existing list extended with `--speculation` filter. |
| `ospex commitments list [--maker --scorer --contest-id --status …]` | Lists commitments. Defaults to `open,partially_filled` and active rows. |
| `ospex commitments approve <decimal-usdc\|max>` | Approve PositionModule for USDC (M2). Argument is decimal USDC (`5`, `0.25`) or `max`. Renders a confirmation prompt before signing; pass `--yes` to skip. For raw 6-decimal-units, use `commitments approve-raw`. The blessed multi-spender path is `ospex approvals setup --risk-usdc <n>`. |
| `ospex commitments approve-raw <wei6\|max>` | Same as `approve` but takes a raw 6-decimal-units integer (e.g. `5000000` = 5 USDC). Power-user / scripted-flow shortcut; otherwise prefer `approve`. |
| `ospex commitments submit [--speculation\|--contest --market --line] --side --odds --risk-usdc [--expiry --nonce --yes --json --approve-max]` | High-level submit. Domain-language inputs (`--side lakers --odds 2.50 --risk-usdc 1`) + a win/lose/push preview before signing. `--json` alone = preview only (no signing); `--yes --json` = preview + post-submit result. Interactive flow asks for the approval amount with exact-required as the default — type `max` for unlimited. Non-interactive (`--yes`) defaults to exact-required; pass `--approve-max` alongside `--yes` for unlimited. |
| `ospex commitments submit-raw <contestId> <scorer> <lineTicks> <position> <oddsTick> <riskAmount>` | Protocol-level escape hatch — same canonical-tuple form as the original `submit`. Use when you already have raw protocol values; otherwise prefer `submit`. |
| `ospex commitments match <hash-or-prefix> [--risk-usdc <decimal>] [--yes --json --approve-max]` | Take a commitment as the taker (M2). Renders a preview with both `taker risks` and `maker fill` lines before signing; pass `--yes` to skip the prompt. Accepts a full hash or a unique 0x-prefixed hex prefix (≥ 8 hex chars). `--risk-usdc` is the **taker** desired risk / max outlay in decimal USDC (e.g. `--risk-usdc 0.5`); default is full fill. `--json` alone = preview only (no tx); `--yes --json` = preview + post-submit result. |
| `ospex commitments cancel <hash-or-prefix> [--also-onchain]` | Off-chain cancel via signed DELETE (M2). With `--also-onchain` (M2.5) additionally calls `MatchingModule.cancelCommitment` for an authoritative cancel. |
| `ospex commitments cancel-onchain <hash-or-prefix>` | On-chain cancel only — `MatchingModule.cancelCommitment(commitment)` (M2.5). Authoritative; cannot be reverted off-chain. |
| `ospex commitments cancel-all --contest-id --scorer --line [--new-min-nonce] [--dry-run]` | Bulk-cancel every open commitment from this maker on one speculation by raising the on-chain nonce floor (M2.5). |
| `ospex commitments nonce-floor --maker --contest-id --scorer --line` | Read the current on-chain `s_minNonces[maker][specKey]` (M2.5). |
| `ospex positions list <address>` | Position history for an address. |
| `ospex positions status <address>` | Active vs. claimable categorization. |
| `ospex leaderboard show` | Top entries on the active leaderboard. |
| `ospex odds show <contestId> [--json]` | One-shot snapshot of upstream reference odds (moneyline / spread / total) for a contest's underlying game. Both American and decimal odds; `--json` emits a single envelope. Use this to decide a commitment price. |
| `ospex odds watch <contestId> [--json --include-refreshes]` | Streams Realtime upstream odds change events. Line-delimited JSON in `--json` mode — agent-facing. Use `odds show` for a one-shot snapshot; `watch` is for reacting to changes over time. |
| `ospex wallet import [--force]` | Encrypts a private key into `~/.ospex/keystore.json`. |
| `ospex wallet unlock` | Caches the decrypted key for 15 minutes in `~/.ospex/session`. |
| `ospex wallet lock` | Deletes the cached unlocked key. |
| `ospex wallet address` | Prints the keystore's address. Skips decryption if the keystore JSON includes a top-level `address`; Foundry-produced keystores omit it, so the passphrase is requested in that case. |

Every command supports `--json` for machine-readable output.

## Wallet security

**Recommended path: Foundry-managed keystore.** Run `mkdir -p ~/.foundry/keystores && cast wallet new ~/.foundry/keystores <name>` (or `cast wallet import <name>` for an existing PK) once, then run `ospex init` and supply the path (`~/.foundry/keystores/<name>`) when it prompts for **Keystore path** — it persists in `~/.ospex/config.json` so future shells just work. For per-shell overrides (scripts / CI) the `OSPEX_KEYSTORE_PATH` env var still wins when set. Ospex never sees your private key — it reads the v3 JSON keystore Foundry produces and prompts you for the passphrase only when a signature is needed. This is the path documented in the [QUICKSTART](./docs/QUICKSTART.md).

**Legacy path (still functional but not recommended):** `ospex wallet import` writes an Ospex-managed keystore at `~/.ospex/keystore.json`. `ospex wallet unlock` caches the decrypted private key at `~/.ospex/session` (plain JSON, mode 0600, 15-minute TTL) inside `~/.ospex` (mode 0700). Both are written atomically and the modes are reasserted on overwrite — they do not silently inherit weaker permissions from a pre-existing file.

What 0600 actually buys you: the session file is unreadable by *other* users on the host. **Any process running as the same user can still read it while the session is unlocked.** OS-keychain integration (DPAPI / Keychain / libsecret) is out of scope. The Foundry path avoids the session-cache trade-off entirely — each write prompts for the passphrase and the key is never persisted in cleartext.

## Roadmap

- **M1**: reads, wallet plumbing, Realtime odds. No on-chain writes.
- **M2 (this release)**: `commitments.{submit, match, approve, cancel}`, contract ABIs under `packages/sdk/src/contracts/abi/`, `rpcUrl` required for chain operations, allowance prompts in the CLI.
- **M2.5**: on-chain `cancelCommitment` + `raiseMinNonce` (bulk cancel-by-speculation) — sovereign cancel that blocks even takers who already hold the signed payload. Adds `cancelOnchain`, `raiseMinNonce`, `cancelAllOnSpeculation`, `getNonceFloor` to `client.commitments`; CLI mirrors with `cancel-onchain`, `cancel-all`, `nonce-floor`, plus `--also-onchain` on the existing `cancel`. Recommended pattern (per `ospex-core-api/docs/CANCEL_FLOW.md`): off-chain DELETE *and* on-chain cancel — DELETE stops new takers, on-chain cancel stops takers who already have the payload.
- **M3**: Position lifecycle (claims, payouts), event-driven matches.
- **M4**: Contest creation surface for ops tooling.

## Testing & validation

Unit tests run via `yarn workspace @ospex/sdk test`. The most important one is the EIP-712 hash vector test in [`tests/chain-eip712.test.ts`](./packages/sdk/tests/chain-eip712.test.ts) — it pins the SDK's typed-data declaration against the contract's `COMMITMENT_TYPEHASH` and cross-validates with ethers, so any drift in field order or types fails CI before a single bad commitment hits the wire.

Integration coverage is a documented manual flow at [`docs/MANUAL_INTEGRATION_TESTING.md`](./docs/MANUAL_INTEGRATION_TESTING.md). Walk all eight sections (15-20 minutes against Polygon Amoy) before tagging a release.

## Architecture notes

- `@ospex/sdk` reads protocol state through `ospex-core-api` (no direct Supabase queries). It only opens Supabase channels for Realtime odds.
- The SDK fetches `GET /v1/config/public` on its first Realtime call to obtain the publishable Supabase URL + anon key. This means clients don't need to track a key that may rotate.
- All chain interactions go through `viem`. Keystore encrypt/decrypt uses `ethers` v6 — both libraries co-exist intentionally; the spec for M1 explicitly approves this.
- The SDK has no `network` parameter. The API decides which chain it speaks to; the SDK reads what it returns.

## Repository setup

This repo lives next to the rest of the Ospex stack at `~/Documents/solidity/ospex-matched-pairs/ospex-sdk/`. The relevant context (production URLs, indexer schema, contract addresses) lives in sibling repos. See `CLAUDE.md` for the source-of-truth pointers.

## License

MIT.
