# Agent contract — `@ospex/sdk` + `ospex` CLI

This document is the integration contract for **programmatic and agent consumers** of the Ospex SDK and CLI. It records what the SDK and CLI *promise* to do, what they *require* from you, and what changes between releases will and will not break you.

The contract is deliberately narrow. Promises here are load-bearing — once an agent depends on them, breaking them is an emergency. Anything not promised here is implementation detail and may change without notice.

> **Audience.** Market-maker bots, ELO-driven arbitrage agents, settlement watchdogs, monitoring stacks, downstream LLM tools. Humans use [`QUICKSTART.md`](./QUICKSTART.md).

---

## 1. Stability surface

| Surface | Promise | Breaks at |
|---|---|---|
| `@ospex/sdk` package barrel exports | Stable | major version |
| `@ospex/sdk/signers/keystore` subpath | Stable | major version |
| CLI command names + flag names | Stable | major version |
| CLI **JSON envelope shapes** (`schemaVersion: 1`) | Stable while `schemaVersion === 1` | bump to `schemaVersion: 2` |
| Typed `error.code` strings (e.g. `'ALLOWANCE_INSUFFICIENT'`) | Stable | major version |
| Typed `error.reason` enum strings (e.g. `'NotCommitmentMaker'`) | Stable | major version |
| CLI **human-readable text output** | NOT stable | any release |
| `error.message` exact text | NOT stable | any release |
| stderr log lines | NOT stable | any release |
| `dist/` internal file paths | NOT stable | any release |

**Rule of thumb for agents.** Always pass `--json` for CLI output you intend to parse. Always switch on `error.code` or `error.reason`, never on `error.message`. Read the JSON envelope's `schemaVersion` and refuse to proceed if it's not the version you were built for.

Additive changes inside `schemaVersion: 1` (new optional fields, new enum values) are explicitly allowed without a schema bump. Treat unknown fields and unknown enum values as forward-compatible — log + ignore, don't crash.

---

## 2. CLI: the `--json` contract

Three CLI commands ship a **dual-mode** `--json`: preview-only without `--yes`, execute-and-emit with `--yes`. These are the agent-friendly commands:

| Command | `--json` alone | `--yes --json` |
|---|---|---|
| `ospex commitments submit` | Emits `SubmitPreviewEnvelope`. **No signing, no POST.** | Emits `SubmitJsonResult`. Signs and posts. |
| `ospex commitments match` | Emits `MatchPreviewEnvelope`. **No tx.** Signer may unlock once to derive the taker address (for the `selfMatch` flag and allowance preflight). | Emits `MatchJsonResult`. Sends a tx. |
| `ospex approvals setup` | Plan-only envelope (no tx). | Executes the plan, emits the result envelope. |

Other write commands (`contests score`, `settle`, `claim`, `claim-all`, `commitments cancel`, `commitments cancel-onchain`, `commitments cancel-all`) treat `--json` as **output format only** — they may still send a transaction. For these, use `--dry-run` where available (`claim-all`, `commitments cancel-all`) for plan-only behavior.

### Envelope shapes (TypeScript)

```ts
// commitments submit --json
interface SubmitPreviewEnvelope {
  schemaVersion: 1;
  preview: SubmitPreview;     // contest, market, side, economics, expiry, raw, approvals[], outcomes[]
}

// commitments submit --yes --json
interface SubmitJsonResult {
  schemaVersion: 1;
  preview: SubmitPreview;
  result: { hash: string; commitment: Commitment };
}

// commitments match --json
interface MatchPreviewEnvelope {
  schemaVersion: 1;
  preview: MatchPreview;      // commitment, taker, selfMatch, contest, market, odds, economics,
                              //   expiry, speculation { mode, lazyCreation? }, approvals[], warnings[]
}

// commitments match --yes --json
interface MatchJsonResult {
  schemaVersion: 1;
  preview: MatchPreview;
  result: {
    txHash: `0x${string}`;
    status: 'success' | 'reverted';
    blockNumber: string;        // decimal string (bigint-safe)
    takerRiskWei6: string;
    fillMakerRiskWei6: string;
  };
}
```

Authoritative source: [`packages/sdk/src/types/preview.ts`](../packages/sdk/src/types/preview.ts) and [`packages/sdk/src/types/matchPreview.ts`](../packages/sdk/src/types/matchPreview.ts).

### Numeric-field rule

Every value that may exceed `Number.MAX_SAFE_INTEGER` is a **decimal string** (`'1000000'`, never `1000000`). This includes:

- `riskWei6`, `riskAmount`, `nonce`, `expiry`
- `blockNumber`, `takerRiskWei6`, `fillMakerRiskWei6`
- `oddsTick` is a small int — emitted as a number, but adjacent USDC formatted strings (`riskUSDC: '1.000000'`) accompany it.

USDC formatted strings are six fractional digits: `'1.000000'`, `'0.250000'`. Round-trip with `usdcDecimalToWei6` / `wei6ToDecimalUSDC` from the SDK barrel.

### `--json` always goes to stdout

Stdout is reserved for the JSON payload. Anything else — passphrase prompts, "Resolved 0xabc → 0xabcdef…" prefix-resolution echoes, progress logs, allowance prompts — goes to **stderr**. `… --json | jq .` is therefore always parseable.

A non-TTY run that requires a signer with no cached session AND wants `--json` output will fail at the passphrase prompt (it can't read hidden input from a piped stdin). Pre-cache a session with `ospex wallet unlock` (15-minute TTL) before piping.

---

## 3. CLI: the `--yes` contract

`--yes` skips the human confirmation prompt. It is **required for non-interactive runs of preview-bearing signing commands** — the commands that render a confirmation prompt before signing. Specifically:

- `ospex commitments submit`
- `ospex commitments match`
- `ospex commitments approve`
- `ospex commitments approve-raw`
- `ospex approvals setup`
- `ospex contests create --game <slug-or-uuid>` *(only when the value resolves to a slug that maps to multiple games — UUID input via `--game-id` does not enforce the guard)*

These commands check `process.stdin.isTTY` and refuse to proceed when it's false rather than hang forever on a never-answered prompt:

```
OspexValidationError: --yes is required for non-interactive runs of `<command>`. Re-run with --yes.
```

**Other write commands sign and send WITHOUT requiring `--yes`** — including `commitments cancel`, `commitments cancel-onchain`, `commitments cancel-all`, `positions claim`, `positions claim-all`, `positions settle`, `contests score`, and `contests create --game-id <uuid>`. For these, `--json` is an *output format only*, not a preview gate; the command may still send a transaction. Use `--dry-run` where available (`claim-all`, `commitments cancel-all`) for plan-only behavior.

**`--yes` does not auto-approve approvals.** When `--yes` is set on a preview-bearing command and an allowance is short, the command defaults to the **exact required** USDC amount, not unlimited. Pass `--approve-max` alongside `--yes` if you want unlimited.

**`--yes` is one-time consent.** Each invocation confirms via `--yes` once. There is no global "trust this agent for the next N minutes" mode — keep your call sites explicit.

---

## 4. CLI: the streaming contract (`ospex odds watch`)

`ospex odds watch <contestId> --json` is the agent-facing streaming primitive. Each event is emitted via `JSON.stringify({ kind, ...odds })` where `odds` is an `OddsSnapshot` from [`packages/sdk/src/types/odds.ts`](../packages/sdk/src/types/odds.ts). One object per line, NDJSON.

### Wire shape per line

```ts
interface WatchEvent {
  kind: 'change' | 'refresh';
  // ...the spread of OddsSnapshot:
  jsonoddsId: string;
  market: 'moneyline' | 'spread' | 'total';
  network: 'polygon' | 'amoy';
  line: number | null;                  // spread/total threshold; null for moneyline
  awayOddsAmerican: number | null;
  homeOddsAmerican: number | null;
  upstreamLastUpdated: string;          // ISO-8601
  pollCapturedAt: string;               // ISO-8601
  changedAt: string;                    // ISO-8601
}
```

`line` and the two `*OddsAmerican` fields are **numbers**, not strings — `-3.5`, `150`, `-180`. `null` when not populated. Example line (formatted for legibility — actual output is single-line):

```jsonl
{"kind":"change","jsonoddsId":"abc-123","market":"spread","network":"polygon","line":-3.5,"awayOddsAmerican":150,"homeOddsAmerican":-180,"upstreamLastUpdated":"2026-05-09T19:55:00Z","pollCapturedAt":"2026-05-09T19:59:30Z","changedAt":"2026-05-09T20:00:00Z"}
```

> **Note.** The `OddsSnapshot` shape is shared across all three markets and uses `awayOddsAmerican`/`homeOddsAmerican` even for `total` events. The `ospex odds show` command (below) uses richer market-specific shapes that name `over`/`under` explicitly.

### Promises

- **Each line is independently parseable JSON.** No multi-line objects.
- `kind` is `'change'` (default) or `'refresh'` (only emitted when `--include-refreshes` is set).
- Lines stream until SIGINT (Ctrl+C) or SIGTERM. The handler unsubscribes channels and exits with code `0`.
- The `--json` mode writes **only** payload lines to stdout. The "Watching contest …, Ctrl+C to stop" banner is on stderr.
- A contest with no upstream linkage (`jsonoddsId === null`) exits `1` with a single stderr message — do not retry; this contest cannot be watched.

### Non-promises

- **No automatic reconnection logic** beyond what the underlying Supabase Realtime client provides. If you need durable subscriptions across long network gaps, wrap the command in your own supervisor that re-spawns on non-zero exit.
- **No replay of missed events.** If the channel drops, events arriving during the gap are lost. Re-poll a snapshot via `ospex odds show <contestId>` if you need a known-good baseline.
- **No ordering guarantee across markets.** A `spread` change for contest X may arrive before a `moneyline` change for contest X even if upstream ordered them the other way. Order is reliable per-channel, not across channels.

### One-shot equivalent: `ospex odds show <contestId> --json`

`odds show` is **not NDJSON** and **not the same shape as `odds watch`**. It emits a **single envelope**:

```ts
interface OddsShowEnvelope {
  contest: {
    contestId: string;
    awayTeam: string;
    homeTeam: string;
    sport: string;
    matchTime: string;          // ISO-8601
    jsonoddsId: string | null;
  };
  odds: {
    moneyline: MoneylineOdds | null;   // { market: 'moneyline', awayOddsAmerican, homeOddsAmerican, ...timestamps }
    spread:    SpreadOdds    | null;   // { market: 'spread',    awayLine, homeLine, awayOddsAmerican, homeOddsAmerican, ...timestamps }
    total:     TotalOdds     | null;   // { market: 'total',     line, overOddsAmerican, underOddsAmerican, ...timestamps }
  };
}
```

Each market entry uses an explicit, market-specific shape (over/under named directly for `total`; both labelled lines for `spread`). Authoritative source: [`packages/sdk/src/types/odds.ts`](../packages/sdk/src/types/odds.ts).

Use `odds show` to decide a price *now*; use `odds watch` to react to changes over time.

---

## 5. CLI: exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Generic failure (unhandled exception, validation error in argument parse). |
| `130` | User declined a confirmation prompt (`Cancelled.` printed to stderr). Equivalent to SIGINT in the shell convention. |

The SDK's typed errors that surface to the CLI all currently exit `1`. If you need to distinguish error classes programmatically, use `--json` and parse the result envelope OR catch the SDK error in a TypeScript caller — don't depend on richer exit codes.

---

## 6. SDK: typed error contract

Every error thrown by the SDK extends `OspexError` and carries a discriminable `code` field. Switch on `code` for routing; switch on `reason` (sub-class) for finer dispatch.

```ts
import {
  OspexError,
  OspexAPIError,
  OspexConfigError,
  OspexValidationError,
  OspexSigningError,
  OspexAllowanceError,
  OspexChainError,
  OspexScriptApprovalError,
  OspexSubscriptionError,
} from '@ospex/sdk';

try {
  await client.commitments.submit({ ... });
} catch (err) {
  if (err instanceof OspexError) {
    switch (err.code) {
      case 'ALLOWANCE_INSUFFICIENT': // ...
      case 'CHAIN_ERROR':            // ...
    }
  }
}
```

### Catalog

| `code` | Class | Structured fields | Typical cause |
|---|---|---|---|
| `API_ERROR` | `OspexAPIError` | `status`, `apiCode`, `path` | Non-2xx from `ospex-core-api`, network failure, bad JSON. |
| `CONFIG_ERROR` | `OspexConfigError` | — | Missing signer / `rpcUrl` for a write; Realtime config unobtainable. |
| `VALIDATION_ERROR` | `OspexValidationError` | `field` | Caller-supplied argument failed a shape / range / regex check. |
| `SIGNING_ERROR` | `OspexSigningError` | — | Keystore decrypt failed (wrong passphrase), EIP-712 sign failed. |
| `ALLOWANCE_INSUFFICIENT` | `OspexAllowanceError` | `required: bigint`, `current: bigint`, `spender`, `token` | Pre-flight allowance shortfall. SDK never auto-approves. |
| `CHAIN_ERROR` | `OspexChainError` | `reason?`, `revertReason?`, `txHash?` | RPC error, revert, receipt status reverted. |
| `SCRIPT_APPROVAL_INVALID` | `OspexScriptApprovalError` | `reason: 'hash_mismatch' \| 'expired' \| 'not_configured'`, `expectedHash?`, `actualHash?` | Chainlink Functions ScriptApproval is unusable. |
| `SUBSCRIPTION_ERROR` | `OspexSubscriptionError` | `reason: 'link_balance_insufficient' \| 'consumer_not_registered' \| 'subscription_id_missing'`, `subscriptionId?` | Chainlink Functions subscription unusable. |

### `OspexChainError.reason` enum

Stable strings:

- `'NotCommitmentMaker'` — caller is not the maker of the cancelled commitment.
- `'NonceMustIncrease'` — `raiseMinNonce` / `cancelAllOnSpeculation` called with `newMinNonce` ≤ current floor.

Other reverts surface with `reason` undefined and a free-form `revertReason` string when the SDK can decode it. New typed reasons are additive (forward-compatible).

### Retryability

| `code` / condition | Retry safe? |
|---|---|
| `API_ERROR` with `status === 429` or `>= 500` | Yes, with backoff. |
| `API_ERROR` with `status` 4xx (except 429) | No — fix the request. |
| `API_ERROR` with no `status` (transport) | Yes, with backoff. |
| `CONFIG_ERROR` | No — fix configuration. |
| `VALIDATION_ERROR` | No — fix the argument. |
| `SIGNING_ERROR` | No (passphrase) / situational. |
| `ALLOWANCE_INSUFFICIENT` | Yes after running an `approve` for `required - current`. |
| `CHAIN_ERROR` with `txHash` | No — the tx already landed reverted. Inspect on-chain. |
| `CHAIN_ERROR` without `txHash` | Sometimes — RPC transport errors are retry-safe; reverts before send are not. Use `reason` to distinguish. |
| `SCRIPT_APPROVAL_INVALID` with `reason === 'expired'` | Wait for re-sign + redeploy of `ospex-core-api`. |
| `SUBSCRIPTION_ERROR` with `reason === 'link_balance_insufficient'` | Yes after funding the wallet with LINK. |

The SDK does not retry for you. Build the retry loop in your agent.

---

## 7. SDK: trust boundaries

The SDK's threat model is "the host machine is honest, the user's wallet is sovereign." From that, the contract:

| Surface | Promise |
|---|---|
| Private keys (SDK) | The SDK never asks for a raw private key in its public `Signer` interface, never logs one, and never persists one. Signing is delegated to whichever `Signer` you supply (typed-data + raw-tx). |
| `KeystoreSigner` | `KeystoreSigner.unlock(json, passphrase)` decrypts a v3 keystore (Foundry- or ethers-produced) **once** and stores a `viem.PrivateKeyAccount` on the signer instance. Subsequent `signTypedData` / `signTransaction` calls reuse that account — they do **not** re-decrypt. The decrypted material lives for the lifetime of the `KeystoreSigner` instance, not "the duration of the call". `KeystoreSigner.fromPrivateKey(pk)` constructs from a raw key directly (no decrypt). |
| **CLI session cache (`ospex wallet unlock`)** | Writes the **decrypted private key** to `~/.ospex/session` as plain JSON, mode `0600`, 15-minute TTL (parent dir mode `0700`). Mode `0600` makes the file unreadable by *other* users on the host but does NOT protect against any process running as the same user — those can read it for the duration of the unlock. The Foundry-keystore path with no `wallet unlock` (each signature re-prompts for the passphrase via a fresh `KeystoreSigner.unlock`) avoids this trade-off entirely; the legacy session-cache path is kept for backwards compatibility but is not the recommended posture. |
| RPC URL | **Caller-supplied.** No public-RPC default; `ospex init` prompts for one. The SDK uses the URL only as a viem `PublicClient` transport. |
| Supabase URL + anon key | Lazy-fetched from `GET /v1/config/public` on the first Realtime call, OR caller-supplied via `OspexClient` constructor. The anon key is the **publishable** key — never the service-role key. |
| Chainlink Functions encrypted secrets | Fetched from a public alias (`secrets.ospex.org`) and passed verbatim into `OracleModule.createContestFromOracle`. The SDK never sees the plaintext. |
| API base URL | Defaults to `https://api.ospex.org`. Override at construction. |

The SDK has no module-level state. Multiple `OspexClient` instances are fully isolated — including per-instance nonce counters (see §9).

---

## 8. SDK: idempotency contracts

| Operation | Idempotent? | Notes |
|---|---|---|
| `commitments.submit` with **identical inputs** | Yes | Server-side dedup on `commitmentHash`. Same hash returned, no duplicate row. |
| `commitments.cancel(hash)` (off-chain DELETE) | Yes | Re-cancel on a cancelled row returns `200`. |
| `commitments.cancelOnchain(hash)` | Yes | The contract has **no `AlreadyCancelled` revert path** — the second `cancelCommitment` succeeds. Don't infer "first cancel" from tx success; check off-chain status if you need that signal. |
| `commitments.raiseMinNonce` / `cancelAllOnSpeculation` with `newMinNonce` ≤ current floor | No | Reverts `NonceMustIncrease`. Use the default-path floor computation (`max(onChainFloor, lastInProcess, supabaseMaxStored) + 1`) for safe retries. |
| `positions.claim(speculationId, type)` re-claim | No | Reverts `AlreadyClaimed`. Surface as `OspexChainError`. |
| `positions.settleSpeculation(speculationId)` re-settle | No | Reverts `AlreadySettled`. Surface as `OspexChainError`. |
| `commitments.approve` re-approval | Yes | Standard ERC-20 — repeated approve calls just overwrite. |

For long-running agents, the safe retry pattern after a transient failure is: re-fetch state via the API, then re-issue. Don't replay the original arguments blindly — block timing, allowance state, and nonce floor may have moved.

---

## 9. SDK: nonce semantics

`commitments.submit` uses a **per-`OspexClient`-instance** nonce counter:

```
nextNonce = max(
  onChainFloor,                  // s_minNonces[maker][specKey]
  lastInProcess + 1,             // last nonce assigned by THIS instance
  unixSecNow                     // wall-clock floor
) + 0
```

Two consequences:

1. **One client per signing identity per process.** Two `OspexClient` instances on the same wallet in the same process will collide on the unix-second floor and produce identical nonces, leading to one of the submits failing with a duplicate-hash 409 from the API. Concrete pattern: spawn one `OspexClient` per worker, share it across all submits from that worker.
2. **Clients across processes need coordination.** An external `nonceProvider` injection is on the M2.5 deferred list. Until then, agents distributing submits across hosts must serialize nonce assignment themselves — typically by routing all submits for a given `(maker, speculationKey)` through a single host.

`commitments.cancelAllOnSpeculation` (and the underlying `commitments.raiseMinNonce`) raises the on-chain nonce floor, which **invalidates every commitment with `nonce < newMinNonce`**. Use this carefully: it doesn't just cancel, it pre-emptively rejects all such commitments at match time on chain.

After the on-chain call returns, the SDK calls `nonceCounter.observe(maker, speculationKey, newMinNonce)` so the per-instance counter is bumped to at least `newMinNonce`. Subsequent submits in the same process pick a nonce strictly above the new floor without an extra `eth_call` to refresh from chain — but a *different* process / `OspexClient` instance will not see the bump until it reads the on-chain floor.

---

## 10. SDK: Realtime contract (`client.odds.subscribe`)

Lazy bootstrap. The first `client.odds.subscribe(...)` call:

1. Fetches `GET /v1/config/public` to obtain the publishable Supabase URL + anon key (skipped if you passed `supabaseUrl` + `supabaseAnonKey` to the constructor).
2. Constructs a Supabase client with `eventsPerSecond: 10`, `persistSession: false`, `autoRefreshToken: false`.
3. Opens a Postgres-changes channel filtered to `(jsonodds_id, market)`.

Promises:

- `onChange` fires for every UPDATE that meaningfully altered an odds field. Refresh-only no-ops are routed to `onRefresh` and gated behind `--include-refreshes` in the CLI.
- `onError` is invoked with an `Error` for transport-level Realtime failures; the channel is not torn down on transport errors — Supabase manages reconnect.
- `subscribe` resolves to a `Subscription` object with a single `unsubscribe(): Promise<void>` method. Calling it removes the channel cleanly.

Non-promises:

- **No replay.** Events that arrived while the channel was disconnected are lost. If you need historical odds, query `client.odds.snapshot(contestId)` separately.
- **No ordering across markets.** Per-channel ordering is reliable; cross-channel is not (see §4).
- **No automatic re-bootstrap on `/v1/config/public` failure.** The SDK resets the supabase-client promise so the *next* subscribe call retries — but the failed call's caller still receives an `OspexConfigError`.

The CLI's `ospex odds watch` opens three channels (one per market) and is the canonical agent shape. For SDK-level use, batch your own subscribes if you want all three.

---

## 11. What is NOT promised

Explicit non-guarantees, listed so you don't accidentally depend on them:

- **Human-readable CLI output.** The pretty preview blocks, table formatting, color codes, ordering of fields, and exact wording of every stderr line are subject to change without notice. Use `--json`.
- **Exact `error.message` text.** The structured `code`, `reason`, and other typed fields are stable; the human message that accompanies them is not.
- **stderr log lines.** Anything written to stderr is informational. Don't grep it.
- **`dist/` file paths.** Importing from `@ospex/sdk/dist/...` directly is unsupported. Import from the package barrel (`@ospex/sdk`) or the documented subpath (`@ospex/sdk/signers/keystore`).
- **Field order in JSON envelopes.** Treat the envelope as an unordered object (which it is, per JSON spec).
- **Network behavior.** Block timing, RPC latency, gas prices, and Chainlink callback latency are external. The SDK does not promise any specific timing — bake your own SLOs around the calls.
- **Indexer projection latency.** A successful on-chain write does not mean the corresponding API row is visible *yet*. Poll the API row's status (or wait ~30s for a typical projection) before downstream actions that depend on the row.
- **Order-book completeness in Realtime.** Realtime exists for *odds*, not for the orderbook. Commitments do not stream — re-list as needed.

---

## 12. Versioning + migration

The SDK follows **semver** with the following interpretation of each kind of bump:

- **Patch** (`0.1.0` → `0.1.1`): bug fixes only. No new public API surface.
- **Minor** (`0.1.x` → `0.2.0`): intended-additive — new commands, new SDK methods, new error reasons, new optional envelope fields. Pre-1.0 reserves the right to ship a breaking change in a minor bump if the audit demands it; release notes will call out any break explicitly, and every effort will be made to deprecate first.
- **Major** (`0.x` → `1.x`, then `1.x` → `2.x`): breaking changes possible. Includes any `schemaVersion` bump.

### Pinning under pre-1.0 (caret behavior)

npm/yarn caret semantics for pre-1.0 packages **lock the 0.x line**: `^0.1.0` resolves to `>=0.1.0 <0.2.0`, NOT `>=0.1.0 <1.0.0`. So caret-pinning to `^0.1.0` gives you patch updates within the 0.1 line and **does not** float to 0.2.0. Verify yourself:

```sh
npx semver -r '^0.1.0' 0.1.1 0.2.0
# 0.1.1
```

Bumping to a new minor is therefore an explicit opt-in — change the manifest to `^0.2.0` and re-install after reading the release notes. This is the right shape for pre-1.0 anyway, since pre-1.0 minors are not guaranteed to be additive.

```jsonc
// good: gets patches within the 0.1 line
"@ospex/sdk": "^0.1.0",

// opt into the next minor deliberately after reading migration notes
"@ospex/sdk": "^0.2.0",

// fragile: blocks even patch fixes
"@ospex/sdk": "0.1.0"
```

Once the SDK reaches `1.0.0`, caret pinning will float across additive minors as the typical post-1.0 semver convention (`^1.2.3` resolves to `>=1.2.3 <2.0.0`).

For the CLI installed via tarball, pin the exact tarball path:

```jsonc
"@ospex/cli": "file:./vendor/ospex-cli-0.1.0.tgz"
```

Re-vendor when you choose to upgrade — there is no auto-update story for tarballs.

---

## 13. Where to look when something doesn't match this doc

If you observe a runtime difference between this contract and the SDK:

1. **The contract is the source of truth for promises**, but the code is the source of truth for behavior. If they conflict, treat the contract as the bug — open an issue with a minimal repro.
2. The authoritative source files for shapes:
   - Error codes: [`packages/sdk/src/errors.ts`](../packages/sdk/src/errors.ts)
   - Submit envelope: [`packages/sdk/src/types/preview.ts`](../packages/sdk/src/types/preview.ts)
   - Match envelope: [`packages/sdk/src/types/matchPreview.ts`](../packages/sdk/src/types/matchPreview.ts)
   - Odds wire shapes (watch + show): [`packages/sdk/src/types/odds.ts`](../packages/sdk/src/types/odds.ts)
   - Public types barrel: [`packages/sdk/src/types/index.ts`](../packages/sdk/src/types/index.ts)
3. The integration playbook (which exercises every promise here against the live testnet) is [`MANUAL_INTEGRATION_TESTING.md`](./MANUAL_INTEGRATION_TESTING.md).

---

## Quick reference

```
schemaVersion === 1                    Locked envelope contract
--json alone (preview-bearing cmds)    Preview only, no signing/tx (submit, match, approvals setup)
--json (other write cmds)              Output format only — may still send a tx (cancel, claim, settle, …)
--yes --json                           Execute and emit (preview-bearing cmds)
--yes for non-TTY                      Required only for preview-bearing commands (see §3)
--json on stdout                       Always parseable; logs/prompts go to stderr
NDJSON for `odds watch`                One JSON object per line, numbers (not strings) for line/odds, SIGINT clean exit
single envelope for `odds show`        NOT NDJSON; { contest, odds: { moneyline, spread, total } }
err.code                               Switch on this for routing
err.reason                             Switch on this for fine dispatch (chain/script-approval/subscription)
schemaVersion: 2                       Will signal a breaking envelope change (not before v1.0.0)
```
