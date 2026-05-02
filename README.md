# Ospex SDK + CLI

TypeScript SDK and command-line interface for the [Ospex](https://ospex.org) protocol — zero-vig peer-to-peer sports prediction on Polygon. M2 ships the EIP-712 signed-commitment surface (`submit`, `match`, `approve`, `cancel`) on top of the M1 read-side. Position lifecycle (claims, payouts) is M3.

This repo is a Yarn 1 workspaces monorepo with two packages:

- [`@ospex/sdk`](./packages/sdk) — the public TypeScript SDK.
- [`@ospex/cli`](./packages/cli) — the `ospex` binary, built on top of the SDK.

## Quick start (CLI)

```bash
git clone <repo> ospex-sdk && cd ospex-sdk
yarn install
yarn workspace @ospex/sdk build
yarn workspace @ospex/cli build
yarn workspace @ospex/cli link             # adds `ospex` to your PATH

ospex init                                 # one-time: write ~/.ospex/config.json (rpcUrl required)
ospex health                               # liveness probe
ospex markets list --hours 168             # upcoming markets
ospex wallet import                        # encrypt a private key into ~/.ospex/keystore.json
ospex wallet address                       # print the keystore's address
ospex odds watch <contestId>               # live odds stream (line-delimited JSON with --json)

# M2 chain writes — require ospex init + ospex wallet import
ospex commitments approve max              # approve PositionModule for unlimited USDC
ospex commitments submit <contestId> <scorer> <lineTicks> upper 250 1000
ospex commitments match <commitment-hash>  # match an existing maker commitment
ospex commitments cancel <commitment-hash> # off-chain cancel via signed DELETE
```

When `npm install -g @ospex/cli` is published this becomes a one-step install — for now use the workspace-link flow above.

## Quick start (SDK)

```bash
yarn add @ospex/sdk
```

```typescript
import { OspexClient } from '@ospex/sdk';

const client = new OspexClient();

// Reads
const markets = await client.markets.list({ sport: 'nba', hours: 24 });
const market = await client.markets.get(contestId);
const orderbook = await client.commitments.list({ contestId });
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

### About `rpcUrl`

Every chain operation (`commitments.submit`, `match`, `approve`) needs an RPC URL — the SDK uses it to read allowance and nonce floor, and to broadcast signed transactions. **Use Alchemy, Infura, or QuickNode in production.** The public Polygon RPCs (`polygon-rpc.com`, `rpc-amoy.polygon.technology`) are rate-limited and prone to drops, and `polygon-rpc.com` has been returning 401 since 2026-03 (per [`ospex-foundry-matched-pairs/docs/DEPLOYMENT.md`](../ospex-foundry-matched-pairs/docs/DEPLOYMENT.md)).

There is intentionally no public-RPC default. `ospex init` requires you to enter a value.

### USDC allowance target

Both maker and taker must approve **`PositionModule`** (NOT MatchingModule) for USDC. MatchingModule never custodies funds — it calls `PositionModule.recordFill`, which is where the `safeTransferFrom` happens. The SDK throws `OspexAllowanceError` with the structured shortfall when allowance is short; the CLI prompts to approve and retries.

## CLI command reference

| Command | What it does |
|---|---|
| `ospex init` | Interactive setup — writes `~/.ospex/config.json` (rpcUrl, chainId, apiUrl). |
| `ospex health` | Hits `/healthz` and prints liveness info. |
| `ospex markets list [--sport --status --hours --limit --offset]` | Lists upcoming contests with their speculations. |
| `ospex markets show <contestId>` | One contest with its full orderbook. |
| `ospex commitments list [--maker --scorer --contest-id --status …]` | Lists commitments. Defaults to `open,partially_filled` and active rows. |
| `ospex commitments approve <amount\|max>` | Approve PositionModule for USDC (M2). |
| `ospex commitments submit <contestId> <scorer> <lineTicks> <position> <oddsTick> <riskAmount>` | Sign + POST a commitment (M2). Prompts to approve if allowance is short. |
| `ospex commitments match <hash> [--risk <amount>]` | Take a commitment as the taker (M2). Prompts to approve. |
| `ospex commitments cancel <hash>` | Off-chain cancel via signed DELETE (M2). |
| `ospex positions list <address>` | Position history for an address. |
| `ospex positions status <address>` | Active vs. claimable categorization. |
| `ospex leaderboard show` | Top entries on the active leaderboard. |
| `ospex odds watch <contestId> [--json --include-refreshes]` | Streams Realtime odds events for the contest's three speculations. |
| `ospex wallet import [--force]` | Encrypts a private key into `~/.ospex/keystore.json`. |
| `ospex wallet unlock` | Caches the decrypted key for 15 minutes in `~/.ospex/session`. |
| `ospex wallet lock` | Deletes the cached unlocked key. |
| `ospex wallet address` | Prints the keystore's address (no decryption needed). |

Every command supports `--json` for machine-readable output.

## Wallet security

`ospex wallet unlock` writes the decrypted private key to `~/.ospex/session` (plain JSON, mode 0600, 15-minute TTL) inside `~/.ospex` (mode 0700). Both are written atomically and the modes are reasserted on overwrite — they do not silently inherit weaker permissions from a pre-existing file.

What 0600 actually buys you: the file is unreadable by *other* users on the host. **Any process running as the same user can still read it while the session is unlocked.** OS-keychain integration (DPAPI on Windows, Keychain on macOS, libsecret on Linux) is the right answer for higher assurance and is out of scope for v1. If you don't want the cache, run write commands without `unlock`: each one prompts for the passphrase inline and never persists the decrypted key.

## Roadmap

- **M1**: reads, wallet plumbing, Realtime odds. No on-chain writes.
- **M2 (this release)**: `commitments.{submit, match, approve, cancel}`, contract ABIs under `packages/sdk/src/contracts/abi/`, `rpcUrl` required for chain operations, allowance prompts in the CLI.
- **M2.5**: on-chain `cancelCommitment` + `raiseMinNonce` (bulk cancel-by-nonce), multi-process nonce coordination helpers.
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
