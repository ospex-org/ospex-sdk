# Ospex SDK + CLI

TypeScript SDK and command-line interface for the [Ospex](https://ospex.org) protocol — a zero-vig peer-to-peer sports prediction protocol on Polygon. The SDK and CLI cover reads (contests, speculations, commitments, positions, leaderboard, odds, games), EIP-712 signed-commitment submission/match/cancel, on-chain cancel + bulk-cancel, contest creation and scoring, position settlement and claims, and live odds streaming over core-api Server-Sent Events.

This repo is a Yarn 1 workspaces monorepo with two packages:

- [`@ospex/sdk`](./packages/sdk) — the public TypeScript SDK.
- [`@ospex/cli`](./packages/cli) — the `ospex` binary, built on top of the SDK.

> **Experimental software.** Ospex is experimental, ships without warranty, and involves financial risk. You control your own wallet and approvals; transactions are final. See [Disclaimers](#disclaimers) below before using on mainnet.

> Building an agent / programmatic integration? See [`docs/AGENT_CONTRACT.md`](./docs/AGENT_CONTRACT.md) for the stable JSON envelopes, error-code catalog, idempotency rules, and the odds streaming contract.

## Install

Distribution is via [GitHub Releases](https://github.com/ospex-org/ospex-sdk/releases) — **not** npm. The CLI ships as a **single self-contained bundle** (one file, every dependency inlined), so you install one tarball **globally** and run bare `ospex` — nothing else to resolve.

**npm:**

```bash
npm install -g https://github.com/ospex-org/ospex-sdk/releases/download/v<ver>/ospex-cli-<ver>.tgz
ospex --version
```

**yarn:**

```bash
yarn global add https://github.com/ospex-org/ospex-sdk/releases/download/v<ver>/ospex-cli-<ver>.tgz
ospex --version
```

Prefer downloading first? Grab `ospex-cli-<ver>.tgz` from the release page and install the local path: `npm install -g ./ospex-cli-<ver>.tgz` (or `yarn global add ./ospex-cli-<ver>.tgz`). The separate `ospex-sdk-<ver>.tgz` tarball is the unbundled library for programmatic consumers (a bot importing `@ospex/sdk`) — CLI users don't need it.

**Why GitHub releases (not npm)?** npm is a developer-productivity ecosystem; a sports-prediction CLI is consumer-entertainment with financial risk and doesn't share a natural audience there. GitHub releases keep the install path explicit (read the release notes, pin the tarball hash in your lockfile) and keep package-index search results uncluttered with software the user community won't generally be looking for. This is the **target distribution model**, not a pre-1.0 placeholder — if npm publishing is added later it would be a secondary channel, with GitHub releases remaining primary.

For local development from a clone of this repo (workspace-link puts `ospex` on your PATH for dev iteration):

```bash
yarn install --frozen-lockfile
yarn workspace @ospex/sdk build
yarn workspace @ospex/cli build
yarn workspace @ospex/cli link
```

End users install via the tarball flow above; the dev-mode link is for working on the SDK/CLI itself.

The full bettor / maker / operator walkthrough is at [`docs/QUICKSTART.md`](./docs/QUICKSTART.md). The release runbook (how a new version is built and tagged) is at [`docs/RELEASING.md`](./docs/RELEASING.md).

## Wallet model

Ospex never asks for your private key. Set up Foundry's keystore — Ospex reads it via a path you tell it about during `ospex init`:

```bash
mkdir -p ~/.foundry/keystores
cast wallet new ~/.foundry/keystores ospex-test    # Foundry generates the key, prints only the address
                                                   # — or `cast wallet import ospex-test` for an existing key
```

Then configure and start reading:

```bash
ospex init                                 # one-time prompts for chainId, apiUrl, rpcUrl, keystorePath
ospex doctor                               # readiness probe (balances, allowances, "Ready to" matrix)
ospex health                               # API liveness
ospex contests list --hours 168            # upcoming contests
ospex commitments match 0xe900c6dd         # take an existing commitment as the taker
```

See **[Wallet security](#wallet-security)** below for the full trust model.

## SDK usage

```typescript
import { OspexClient } from '@ospex/sdk';

const client = new OspexClient();

// Reads
const contests = await client.contests.list({ sport: 'nba', hours: 24 });
const contest = await client.contests.get(contestId);
const speculations = await client.speculations.list({ contestId });
const orderbook = await client.commitments.list({ speculationId });
const positions = await client.positions.byAddress('0x…');
const status = await client.positions.status('0x…');
const board = await client.leaderboard.active();
const info = await client.protocol.info();

// Live odds — opens an SSE stream to core-api for one (contest, market).
// Contest-id native; the handler payload is the market-specific shape.
const sub = await client.odds.subscribe(
  { contestId, market: 'spread' },
  {
    onSnapshot: (odds) => console.log('baseline', odds),
    onChange: (odds) => console.log('price moved', odds),
    onRefresh: (odds) => console.log('writer re-polled', odds),
    onStatus: (status) => console.log('stream', status),
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
  apiUrl: 'https://staging-api.example',  // defaults to the production core-api URL
  signer: myCustomSigner,                 // required for any chain write
  rpcUrl: 'https://polygon-mainnet.g.alchemy.com/v2/<key>', // required for chain ops
  chainId: 137,                           // 137 (mainnet) or 80002 (amoy); default 137
  timeoutMs: 10_000,
});
```

The CLI reads its config in this order: env var (`OSPEX_API_URL`, `OSPEX_RPC_URL`, `OSPEX_CHAIN_ID`) > `~/.ospex/config.json` > SDK built-in defaults.

The keystore location follows the same precedence: `OSPEX_KEYSTORE_PATH` env var > `keystorePath` field in `~/.ospex/config.json` (set once via `ospex init`) > default `~/.ospex/keystore.json`. The recommended setup is to put a Foundry-managed keystore path in the config file (so future shells don't need to re-export anything), and reserve the env var for per-shell overrides — useful for scripts and CI. Leading `~/` in either source is expanded.

### About `rpcUrl`

Every chain operation (`commitments.submit`, `match`, `approve`) needs an RPC URL — the SDK uses it to read allowance and nonce floor, and to broadcast signed transactions. **Use Alchemy, Infura, or QuickNode in production.** The public Polygon RPCs (`polygon-rpc.com`, `rpc-amoy.polygon.technology`) are rate-limited and prone to drops, and `polygon-rpc.com` has been returning 401 since 2026-03.

There is intentionally no public-RPC default. `ospex init` requires you to enter a value.

### USDC allowance target

Both maker and taker must approve **`PositionModule`** (NOT MatchingModule) for USDC. MatchingModule never custodies funds — it calls `PositionModule.recordFill`, which is where the `safeTransferFrom` happens. The SDK throws `OspexAllowanceError` with the structured shortfall when allowance is short; the CLI prompts to approve and retries.

### Sovereign cancel — off-chain DELETE vs. on-chain cancel

Off-chain `commitments.cancel(hash)` (DELETE `/v1/commitments/:hash`) marks the row cancelled in the API so the relay stops surfacing it. It does **not** prevent a taker who already holds the signed payload from matching the commitment — the contract still treats it as valid until `s_cancelledCommitments[hash]` flips on chain. For an authoritative cancel, use `commitments.cancelOnchain({ hash })` (fetches via the public API, narrows redaction, then broadcasts) — or `commitments.cancelOnchainSigned(payload)` when you already hold the maker-signed `SignedCommitmentPayload` locally (zero API round-trips, works against book-hidden rows). The CLI's `commitments cancel <hash> --also-onchain` runs the off-chain DELETE then the on-chain `{ hash }` cancel in sequence — the recommended pattern for off-chain consumers.

For bulk cancel ("revoke every order I have on this speculation"), `commitments.cancelAllOnSpeculation({ contestId, scorer, lineTicks, newMinNonce })` raises the maker's on-chain nonce floor so all sub-floor commitments become unmatchable in a single tx. `newMinNonce` is **required** — read the current floor with `commitments.getNonceFloor({ maker, contestId, scorer, lineTicks })`, add any headroom you need for cross-process signatures, and pass the result. The SDK does not auto-compute the floor: anonymous reads cannot enumerate the maker's book-hidden commitments, so any computed default would silently leave hidden-but-still-on-chain-matchable rows live (latent exposure). The contract has no `AlreadyCancelled` revert path; calling `cancelOnchain` on a hash that's already cancelled is a no-op success, so don't infer "first cancel" from tx success.

## CLI command reference

| Command | What it does |
|---|---|
| `ospex init` | Interactive setup — writes `~/.ospex/config.json` (rpcUrl, chainId, apiUrl, keystorePath). |
| `ospex doctor [--address <addr>]` | Readiness probe — balances, allowances, network status, "Ready to" matrix, next-step suggestion. |
| `ospex health` | API liveness probe. |
| `ospex contests list [--sport --status --hours --limit --offset]` | Lists upcoming contests with their speculations. |
| `ospex contests show <contestId>` | One contest with its full orderbook. |
| `ospex contests create --game-id <id>` (or `--game <slug-or-id>`) | Submit `OracleModule.createContestFromOracle`. `gameId` is the stable id from `ospex games list`; the SDK resolves the three external IDs server-side. `--game` is a resolver alias accepting either a slug or a UUID. Mainnet only today — Amoy contracts are wired but script approvals haven't been signed against the current `OracleModule` deploy ([Roadmap](#roadmap)). |
| `ospex contests score <contestId>` | Submit `OracleModule.scoreContestFromOracle`. |
| `ospex contests wait-verified <contestId>` | Poll until the contest reaches Verified state. |
| `ospex contests scripts` | Show the EIP-712 script approvals (debug). |
| `ospex games list [--sport --hours --creatable-only]` | Upcoming games on the schedule. The `creatable` column flags rows that can be passed to `contests create --game-id`; pass `--creatable-only` to narrow to those rows. |
| `ospex speculations list [--contest --sport --status --limit --offset]` | List speculations across one or more contests. |
| `ospex speculations show <speculationId>` | One speculation with its orderbook + parent contest context. |
| `ospex commitments show <hash-or-prefix>` | Single commitment lookup. Accepts a full hash or a unique 0x-prefixed hex prefix (≥ 8 hex chars). Resolves over all statuses. |
| `ospex commitments list [--maker --scorer --contest-id --speculation --status --side --sort --raw --with-fillability …]` | Lists commitments. Defaults to `open,partially_filled` and active rows. Default human columns are taker-centric (matchup, market, you back, your odds, max bet, to win); `--raw` switches to the protocol view (positionType, maker risk, maker odds). `--side <team>` filters to rows where you would back that side; `--sort size\|odds\|newest` (default `size`) orders the taker view. `--with-fillability` adds an advisory maker-funding column (taker / `--raw` views) and the per-row `fillability` object under `--json` — opt-in, point-in-time. `--json` is unaffected by `--raw` / `--side` / `--sort`: it emits a v2 `AgentEnvelope` with the commitment array under `payload` (see [`docs/AGENT_CONTRACT.md`](./docs/AGENT_CONTRACT.md)), so the agent contract stays stable. |
| `ospex commitments approve <decimal-usdc\|max>` | Approve PositionModule for USDC. Argument is decimal USDC (`5`, `0.25`) or `max`. Renders a confirmation prompt before signing; pass `--yes` to skip. For raw 6-decimal-units, use `commitments approve-raw`. The blessed multi-spender path is `ospex approvals setup --risk-usdc <n>`. |
| `ospex commitments approve-raw <wei6\|max>` | Same as `approve` but takes a raw 6-decimal-units integer (`5000000` = 5 USDC). |
| `ospex commitments submit [--speculation\|--contest --market --line] --side --odds --risk-usdc [--expiry --nonce --yes --json --approve-max --raw]` | High-level submit. Domain-language inputs (`--side lakers --odds 2.50 --risk-usdc 1`) + a win/lose/push preview before signing. `--raw` restores the `positionType=Upper/Lower` tag inside the `[sideTags]` bracket on the `side:` line for protocol debugging. `--json` alone = preview only (no signing); `--yes --json` = preview + post-submit result. |
| `ospex commitments submit-raw <contestId> <scorer> <lineTicks> <position> <oddsTick> <riskAmount>` | Protocol-level escape hatch — same canonical-tuple form. Use when you already have raw protocol values; otherwise prefer `submit`. |
| `ospex commitments match <hash-or-prefix> [--risk-usdc <decimal>] [--yes --json --approve-max --raw]` | Take a commitment as the taker. Renders a first-person preview (`You back:` / `Counterparty:` / `Your risk:` / `Your profit:` / `Maker fill:` plus a taker-perspective `Outcomes` block) before signing; pass `--yes` to skip the prompt. `--raw` falls back to the protocol-native dual maker/taker layout for debugging. `--json` alone = preview only (no tx); `--yes --json` = preview + post-submit result. |
| `ospex commitments cancel <hash-or-prefix> [--also-onchain]` | Off-chain cancel via signed DELETE. With `--also-onchain` additionally calls `MatchingModule.cancelCommitment` for an authoritative cancel. |
| `ospex commitments cancel-onchain <hash-or-prefix>` | On-chain cancel only. Authoritative; cannot be reverted off-chain. |
| `ospex commitments cancel-all --contest-id --scorer --line --new-min-nonce [--dry-run]` | Bulk-cancel every open commitment from this maker on one speculation by raising the on-chain nonce floor. `--new-min-nonce` is required (the SDK does not auto-compute — see [`docs/AGENT_CONTRACT.md` §1.5](./docs/AGENT_CONTRACT.md)). |
| `ospex commitments nonce-floor --maker --contest-id --scorer --line` | Read the current on-chain `s_minNonces[maker][specKey]`. |
| `ospex approvals setup [--risk-usdc <n>] [--fee-usdc <n>] [--link <n>] [--yes --json]` | One-shot multi-spender approval orchestration (PositionModule / TreasuryModule / OracleModule). Recommended baseline. |
| `ospex approvals show [--address <addr>]` | Read-only allowance snapshot for a wallet. |
| `ospex positions list <address>` | Position history for an address. |
| `ospex positions status <address>` | Three-bucket categorization: active / pendingSettle / claimable. |
| `ospex positions history <address>` | Full claim/settlement history. |
| `ospex claim <speculationId> --type upper\|lower` | Claim one specific winning position. Top-level for ergonomics — not under `positions`. |
| `ospex claim-all [--address <addr>] [--dry-run]` | Sweep every claimable position for a wallet (settles where needed; skips a speculation already settled by someone else). Top-level. |
| `ospex settle <speculationId>` | Permissionlessly settle a scored speculation. Idempotent — an already-settled speculation is a no-op success, not an error. Top-level. |
| `ospex leaderboard show` | Top entries on the active leaderboard. |
| `ospex odds show <contestId> [--json] [--market moneyline\|spread\|total]` | One-shot snapshot of upstream reference odds (moneyline / spread / total) for a contest's underlying game. Both American and decimal odds; `--json` emits a single envelope. `--market` narrows the human render to one market (no effect on `--json` — the envelope stays stable for agents). Use this to decide a commitment price. |
| `ospex odds watch <contestId> [--json --include-refreshes]` | Streams live upstream odds over core-api SSE — a `SNAP` baseline on connect, then `CHG` / `REF` events per market plus connection status. Line-delimited JSON in `--json` mode — agent-facing. Use `odds show` for a one-shot snapshot; `watch` is for reacting to changes over time. |
| `ospex auth use-foundry --account <name> --password-file <path> [--keystore-path <path>] [--foundry-keystores-dir <path>] [--no-pin-address]` | Pin a Foundry account + password file as the default signer for every subsequent `ospex` command. Decrypts once to validate, captures the resulting address, and writes `~/.ospex/config.json`. By default also pins the resolved address — a surprise key rotation throws `address_mismatch` before signing. Recommended for non-interactive / agent setups; see [QUICKSTART](./docs/QUICKSTART.md) for the three-step flow. |
| `ospex auth clear-foundry [--all] [--account] [--keystore-path] [--password-file] [--expected-address] [--foundry-keystores-dir]` | Remove Foundry signer fields from `~/.ospex/config.json`. `--all` clears every Foundry-signer field but preserves the legacy `keystorePath` from `ospex init`. |
| `ospex auth check [signer-flags...] [--strict] [--sign-challenge] [--json]` | Diagnose the resolved signer source without sending a transaction. Walks the same precedence ladder a real write would (flag > env > config > default), optionally unlocks + verifies, optionally signs a deterministic EIP-712 challenge. `--strict` promotes a group/other-readable password file (mode `& 0o077 != 0`) from a stderr warning to a hard exit — same gate added to `ospex doctor --strict`. |
| `ospex wallet import [--force]` | Encrypts a private key into `~/.ospex/keystore.json` (legacy path). |
| `ospex wallet unlock` | Legacy session-cache unlock — decrypts the keystore and caches the private key at `~/.ospex/session` for 15 minutes. Kept for compatibility; Foundry-first agents should prefer `ospex auth use-foundry` (above) or the per-invocation `--account` + `--password-file` flags on write commands. |
| `ospex wallet lock` | Deletes the cached unlocked key. |
| `ospex wallet address` | Prints the keystore's address. Foundry-produced keystores omit the top-level `address` field, so the passphrase is requested in that case. |

Most commands support `--json` for machine-readable output. The interactive setup / wallet-management commands — `init`, `wallet import`, `wallet unlock`, `wallet lock` — do not, because they're stateful prompt flows. See [`docs/AGENT_CONTRACT.md`](./docs/AGENT_CONTRACT.md) for the stable JSON envelope shapes and which commands are preview-bearing vs. output-format-only.

Every command that signs (`commitments {submit, match, approve, approve-raw, cancel, cancel-onchain, cancel-all}`, `contests {create, score}`, top-level `{claim, claim-all, settle}`, `approvals setup`, `wallet address`) accepts the same six signer-resolution flags: `--account`, `--keystore-path`, `--password-file`, `--password-stdin`, `--expected-address`, `--foundry-keystores-dir`. They beat env vars, which beat `~/.ospex/config.json`. The flag group is the per-invocation override seam; `ospex auth use-foundry` is the once-per-host pin. See [`docs/AGENT_CONTRACT.md` §4](./docs/AGENT_CONTRACT.md) for the full non-interactive signing contract.

## Wallet security

**Recommended path: Foundry-managed keystore.** Run `mkdir -p ~/.foundry/keystores && cast wallet new ~/.foundry/keystores <name>` (or `cast wallet import <name>` for an existing PK) once, then run `ospex init` and supply the path (`~/.foundry/keystores/<name>`) when it prompts for **Keystore path** — it persists in `~/.ospex/config.json` so future shells just work. For per-shell overrides (scripts / CI) the `OSPEX_KEYSTORE_PATH` env var still wins when set. Ospex never sees your private key — it reads the v3 JSON keystore Foundry produces and prompts you for the passphrase only when a signature is needed. This is the path documented in the [QUICKSTART](./docs/QUICKSTART.md).

**Non-interactive signing for agents:** Pin a default signer once via `ospex auth use-foundry --account <name> --password-file <path>` — every subsequent write command unlocks the Foundry keystore in process memory using the passphrase from the file, with no decrypted key written to disk (unlike `wallet unlock`). The address is also pinned by default, so a surprise key rotation throws `address_mismatch` before signing. See [QUICKSTART → "Optional: pin a non-interactive signer"](./docs/QUICKSTART.md) for the three-step setup and [`docs/AGENT_CONTRACT.md` §4](./docs/AGENT_CONTRACT.md) for the full surface (flag group, env vars, `auth check` JSON envelope, reason codes).

**Legacy path (still functional but not recommended):** `ospex wallet import` writes an Ospex-managed keystore at `~/.ospex/keystore.json`. `ospex wallet unlock` caches the decrypted private key at `~/.ospex/session` (plain JSON, mode 0600, 15-minute TTL) inside `~/.ospex` (mode 0700). Both are written atomically and the modes are reasserted on overwrite — they do not silently inherit weaker permissions from a pre-existing file.

What 0600 actually buys you: the session file is unreadable by *other* users on the host. **Any process running as the same user can still read it while the session is unlocked.** OS-keychain integration (DPAPI / Keychain / libsecret) is out of scope. The Foundry path avoids the session-cache trade-off entirely — each write prompts for the passphrase, or unlocks non-interactively from a `.pass` file under `auth use-foundry`, and the decrypted key is never persisted in cleartext.

For the full SDK-level trust-boundary description (how `KeystoreSigner` holds decrypted material in memory, what the SDK never does), see [`docs/AGENT_CONTRACT.md` §8](./docs/AGENT_CONTRACT.md). For the non-interactive signing surface (the `--account` / `--password-file` flag group, `auth use-foundry` pinning, and the `auth check` JSON envelope), see [`docs/AGENT_CONTRACT.md` §4](./docs/AGENT_CONTRACT.md).

## Architecture notes

- `@ospex/sdk` reads protocol state through the public Ospex core API (no direct database access). Live odds and protocol deltas arrive over core-api Server-Sent Events — there are no realtime credentials to configure or bootstrap.
- All chain interactions go through `viem`. Keystore encrypt/decrypt uses `ethers` v6 — both libraries co-exist intentionally for this scope.
- The SDK has no `network` parameter. The API decides which chain it speaks to; the SDK reads what it returns.

## Testing & validation

Unit tests run via `yarn test`. The most important one is the EIP-712 hash vector test in [`packages/sdk/tests/chain-eip712.test.ts`](./packages/sdk/tests/chain-eip712.test.ts) — it pins the SDK's typed-data declaration against the contract's `COMMITMENT_TYPEHASH` and cross-validates with ethers, so any drift in field order or types fails CI before a single bad commitment hits the wire.

Integration coverage is a documented manual flow at [`docs/MANUAL_INTEGRATION_TESTING.md`](./docs/MANUAL_INTEGRATION_TESTING.md). Walk it (15-20 minutes against Polygon Amoy) before tagging a release.

CI runs install / build / typecheck / test on every PR — see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## Roadmap

Out of the current public surface, deferred work:

- **Streaming match notifications.** A core-api SSE stream for `MatchExecuted` events. Today, agents poll (or watch the position / fill streams).
- **Cross-process nonce coordination.** A pluggable `nonceProvider` for callers distributing submits across hosts. Today, callers serialize per `(maker, speculationKey)` themselves.
- **Read-only nonce-floor endpoint.** A `GET /v1/makers/:address/nonce-floor` API path so callers without an RPC URL can read the floor without an `eth_call`.
- **Bulk on-chain claim.** Multicall3-based bulk claim flow.
- **Polygon Amoy script approvals for contest creation.** `contests create` and `contests score` work on mainnet only today. The Amoy contracts are wired identically, but the EIP-712 script approvals served by `ospex-core-api` are mainnet-only — the API's `scriptApprovals.amoy` bundle is `null`, so calling against Amoy throws `OspexScriptApprovalError(reason: 'not_configured')`. Most agent integrations don't need the create/score path — validate end-to-end by matching an open commitment whose preview shows `tradeAction: 'trade-only'` (the speculation already exists), where your only costs are gas and the commitment risk. A lazy match (preview shows `trade-and-create-speculation`) additionally pulls a TreasuryModule creation-fee approval; the SDK preflight quotes the exact amount before signing. Amoy support lands when approvals are signed against the current `OracleModule` deploy and committed to the API.
- **Secondary-market position UX.** SecondaryMarketModule integration.

Contributions welcome on any of these — see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Disclaimers

By using this SDK and CLI you acknowledge:

- **Experimental software.** Ospex is experimental and ships **without warranty**, express or implied. See [`LICENSE`](./LICENSE).
- **Sole control of your wallet.** You — and only you — control your private key, your approvals, and your transactions. The SDK never asks for or persists a raw private key in its public interface. The legacy CLI session cache (`ospex wallet unlock`) writes a decrypted private key to `~/.ospex/session` for 15 minutes; the recommended Foundry-keystore path avoids this.
- **Financial risk.** Wagering, approvals, and on-chain transactions carry financial risk. Approvals can be exploited by malicious frontends or scripts; bugs in this SDK could cause loss of funds. Approve only the amount you're willing to risk; revoke approvals you no longer need. Use the public `ospex doctor` and `ospex approvals show` commands to audit your wallet's exposure at any time.
- **No guarantees.** No guarantee of liquidity, settlement timing, odds accuracy, indexer projection latency, RPC availability, or profit. The protocol settles via Chainlink Functions on a best-effort basis; outages happen.
- **Local law compliance.** You are responsible for complying with the laws of your jurisdiction. This software does not enforce geofencing, KYC, or any other regulatory check. Don't use it where you shouldn't.
- **Not financial or legal advice.** Nothing in this repository constitutes financial, legal, or tax advice.

Smart-contract security issues should go through the contracts repo. SDK / CLI security issues — see [`SECURITY.md`](./SECURITY.md).

## Contributing

PRs and issue reports welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev workflow and conventions.

## License

[MIT](./LICENSE).
