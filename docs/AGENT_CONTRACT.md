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

`--yes` skips the human confirmation prompt. It is **required for non-interactive runs of any signing command**:

```
ospex commitments approve 5
ospex commitments submit --speculation 42 --side lakers --odds 2.50 --risk-usdc 1
ospex commitments match 0xe900c6dd
ospex approvals setup --risk-usdc 50
ospex contests create --game-id <id>
```

Without `--yes`, these commands check `process.stdin.isTTY` and refuse to proceed when it's false rather than hang forever on a never-answered prompt:

```
OspexValidationError: --yes is required for non-interactive runs of `<command>`. Re-run with --yes.
```

**`--yes` does not auto-approve approvals.** When `--yes` is set and an allowance is short, the command defaults to the **exact required** USDC amount, not unlimited. Pass `--approve-max` alongside `--yes` if you want unlimited.

**`--yes` is one-time consent.** Each invocation prompts (or confirms via `--yes`) once. There is no global "trust this agent for the next N minutes" mode — keep your call sites explicit.

---

## 4. CLI: the streaming contract (`ospex odds watch`)

`ospex odds watch <contestId> --json` is the agent-facing streaming primitive. Output format (one object per line, NDJSON):

```jsonl
{"kind":"change","contestId":"...","jsonoddsId":"...","market":"spread","line":"-3.5","awayOddsAmerican":"+150","homeOddsAmerican":"-180","changedAt":"2026-05-09T20:00:00Z"}
{"kind":"change","contestId":"...","market":"moneyline",...}
```

Promises:

- **Each line is independently parseable JSON.** No multi-line objects.
- `kind` is `'change'` (default) or `'refresh'` (only emitted when `--include-refreshes` is set).
- Lines stream until SIGINT (Ctrl+C) or SIGTERM. The handler unsubscribes channels and exits with code `0`.
- The `--json` mode writes **only** payload lines to stdout. The "Watching contest …, Ctrl+C to stop" banner is on stderr.
- A contest with no upstream linkage (`jsonoddsId === null`) exits `1` with a single stderr message — do not retry; this contest cannot be watched.

Non-promises:

- **No automatic reconnection logic** beyond what the underlying Supabase Realtime client provides. If you need durable subscriptions across long network gaps, wrap the command in your own supervisor that re-spawns on non-zero exit.
- **No replay of missed events.** If the channel drops, events arriving during the gap are lost. Re-poll a snapshot via `ospex odds show <contestId>` if you need a known-good baseline.
- **No ordering guarantee across markets.** A `spread` change for contest X may arrive before a `moneyline` change for contest X even if upstream ordered them the other way. Order is reliable per-channel, not across channels.

`ospex odds show <contestId>` is the one-shot equivalent — same data shape, single line per market, exits after emitting.

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
| Private keys | The SDK **never** asks for a private key, never logs one, and never persists one. Signing is delegated to a `Signer` interface (typed-data + raw-tx). |
| `KeystoreSigner` | Decrypts a v3 keystore (Foundry- or ethers-produced) on every signature. The decrypted private key lives in a JS variable for the duration of the call only. |
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

`commitments.cancelAllOnSpeculation` raises the on-chain nonce floor, which **invalidates every commitment with `nonce < newMinNonce`**. Use this carefully: it doesn't just cancel, it pre-emptively rejects all such commitments at match time on chain. After the call, your client's per-instance `lastInProcess` counter is unchanged — re-issued commitments after a bulk cancel will still have monotonically higher nonces.

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

The SDK follows **semver** with the following interpretation:

- **Patch** (`0.1.0` → `0.1.1`): bug fixes only. No new public API surface.
- **Minor** (`0.1.x` → `0.2.0`): additive — new commands, new SDK methods, new error reasons, new optional envelope fields. Existing pinned shapes still resolve. Agents pinned to `^0.1.0` get these automatically.
- **Major** (`0.x` → `1.x`, then `1.x` → `2.x`): breaking changes possible. Includes any `schemaVersion` bump.

Pre-1.0 (`0.x.y`) reserves the right to make breaking changes in a minor bump if the audit mandates it, but every effort will be made to deprecate first.

When you pin in your agent's manifest, pin to a minor:

```jsonc
// good: gets patches and additive minors
"@ospex/sdk": "^0.1.0",

// fragile: blocks even patch fixes
"@ospex/sdk": "0.1.0",
```

For the CLI installed via tarball, pin in the same `package.json`:

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
   - Public types barrel: [`packages/sdk/src/types/index.ts`](../packages/sdk/src/types/index.ts)
3. The integration playbook (which exercises every promise here against the live testnet) is [`MANUAL_INTEGRATION_TESTING.md`](./MANUAL_INTEGRATION_TESTING.md).

---

## Quick reference

```
schemaVersion === 1                    Locked envelope contract
--json alone                           Preview only, no signing/tx
--yes --json                           Execute and emit
--yes for non-TTY                      Required for signing commands
--json on stdout                       Always parseable; logs go to stderr
NDJSON for `odds watch`                One JSON object per line, SIGINT clean exit
err.code                               Switch on this for routing
err.reason                             Switch on this for fine dispatch (chain/script-approval/subscription)
schemaVersion: 2                       Will signal a breaking envelope change (not before v1.0.0)
```
