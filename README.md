# Ospex SDK + CLI

TypeScript SDK and command-line interface for the [Ospex](https://ospex.org) protocol — zero-vig peer-to-peer sports prediction on Polygon. This is M1: read-side SDK, wallet plumbing, and a reads-only CLI. Commitment submission and on-chain writes ship in M2/M3.

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

ospex health                               # liveness probe
ospex markets list --hours 168             # upcoming markets
ospex wallet import                        # encrypt a private key into ~/.ospex/keystore.json
ospex wallet address                       # print the keystore's address
ospex odds watch <contestId>               # live odds stream (line-delimited JSON with --json)
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
  signer: myCustomSigner,                 // optional; reserved for M2 writes
  timeoutMs: 10_000,
});
```

The CLI reads its config in this order: env var (`OSPEX_API_URL`, `OSPEX_SUPABASE_URL`, `OSPEX_SUPABASE_ANON_KEY`) > `~/.ospex/config.json` > SDK built-in defaults.

## CLI command reference (M1)

| Command | What it does |
|---|---|
| `ospex health` | Hits `/healthz` and prints liveness info. |
| `ospex markets list [--sport --status --hours --limit --offset]` | Lists upcoming contests with their speculations. |
| `ospex markets show <contestId>` | One contest with its full orderbook. |
| `ospex commitments list [--maker --scorer --contest-id --status …]` | Lists commitments. Defaults to `open,partially_filled` and active rows. |
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

`ospex wallet unlock` writes the decrypted private key to `~/.ospex/session` (plain JSON, mode 0600, 15-minute TTL). OS-keychain integration is out of scope for v1 — the file lives inside your user-profile directory, but a sufficiently privileged process on the same machine could read it. If you don't want the cache, run write commands without `unlock`: each one prompts for the passphrase inline and never persists the decrypted key.

## Roadmap

- **M1 (this release)**: reads, wallet plumbing, Realtime odds. No on-chain writes.
- **M2**: `commitments.submit` (signed via the keystore), `commitments.cancel`, contract ABIs under `packages/sdk/src/contracts/abi/`, `rpcUrl` becomes a required config for chain writes.
- **M3**: Position lifecycle (claims, payouts), event-driven matches.

## Architecture notes

- `@ospex/sdk` reads protocol state through `ospex-core-api` (no direct Supabase queries). It only opens Supabase channels for Realtime odds.
- The SDK fetches `GET /v1/config/public` on its first Realtime call to obtain the publishable Supabase URL + anon key. This means clients don't need to track a key that may rotate.
- All chain interactions go through `viem`. Keystore encrypt/decrypt uses `ethers` v6 — both libraries co-exist intentionally; the spec for M1 explicitly approves this.
- The SDK has no `network` parameter. The API decides which chain it speaks to; the SDK reads what it returns.

## Repository setup

This repo lives next to the rest of the Ospex stack at `~/Documents/solidity/ospex-matched-pairs/ospex-sdk/`. The relevant context (production URLs, indexer schema, contract addresses) lives in sibling repos. See `CLAUDE.md` for the source-of-truth pointers.

## License

MIT.
