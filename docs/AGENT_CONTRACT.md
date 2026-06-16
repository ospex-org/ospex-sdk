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
| CLI **JSON envelope shape** (`AgentEnvelope<TPayload>`, `schemaVersion: 2`) | Stable while `schemaVersion === 2` | bump to `schemaVersion: 3` |
| Typed `error.code` strings (e.g. `'ALLOWANCE_INSUFFICIENT'`) | Stable | major version |
| Typed `error.reason` enum strings (e.g. `'NotCommitmentMaker'`) | Stable | major version |
| CLI **human-readable text output** | NOT stable | any release |
| `error.message` exact text | NOT stable | any release |
| stderr log lines | NOT stable | any release |
| `dist/` internal file paths | NOT stable | any release |

**Rule of thumb for agents.** Always pass `--json` for CLI output you intend to parse. Always switch on `error.code` or `error.reason`, never on `error.message`. Read the JSON envelope's `schemaVersion` and refuse to proceed if it's not the version you were built for.

Additive changes inside `schemaVersion: 2` (new optional fields on the envelope or its payloads, new enum values) are explicitly allowed without a schema bump. Treat unknown fields and unknown enum values as forward-compatible — log + ignore, don't crash.

---

## 1.5. Public commitments — visible vs. hidden type split

Every public commitment read (`client.commitments.get(hash)`, `client.commitments.list(...)`, any embedded orderbook in a contest/speculation response) returns the discriminated union `Commitment = PublicVisibleCommitment | PublicHiddenCommitment`. The discriminant fields:

```ts
type PublicVisibleCommitment = { visibility: 'visible'; redacted: false; /* full matchable payload */ };
type PublicHiddenCommitment   = { visibility: 'hidden';  redacted: true; payloadAvailable: false; /* allow-list only */ };
```

A commitment is `hidden` when its maker pulled it from the public order book via a signed off-chain `DELETE /v1/commitments/:hash` (`book_visible=false`). The signed payload may still be matchable on chain until expiry / nonce-floor / on-chain `cancelCommitment` — but third parties cannot reach it from public reads. The public hidden body is allow-list-projected: `commitmentHash`, `maker`, `contestId`, `positionType`, `status`, `storedStatus`, `filledRiskAmount`, `expiry`, `bookVisible`, `nonceInvalidated` (plus the three discriminant fields). Anything in `MatchingModule.matchCommitment`'s struct (`signature`, `nonce`, `riskAmount`, `oddsTick`, `scorer`, `lineTicks`, `marketType`, `speculationKey`) is **never** present on a hidden body.

**How to discriminate.**

- Predicate: `if (isVisibleCommitment(c)) { /* PublicVisibleCommitment */ }` / `if (isHiddenCommitment(c)) { /* PublicHiddenCommitment */ }` (both exported from the SDK barrel).
- Inline: `if (c.redacted === false) { /* visible */ }` / `if (c.redacted === true) { /* hidden */ }`.
- `if (c.visibility === 'visible')` also narrows; both discriminants always agree.

**Consequences for write-path SDK calls.** Operations that need the matchable payload refuse on a redacted body, surfaced as `OspexValidationError({ field: 'commitment' })` with an error message that names the hash and points at the owner-auth own-state surface:

- `client.ownState.snapshot({ address, cursor? })` returns ONE owner-auth page (full `OwnerCommitment` payload regardless of `book_visible`). Callers that need the full commitment set MUST loop while `snapshot.truncated === true`, passing `snapshot.cursor` back on each call. A single-page read can omit higher-`row_updated_at` rows.
- `client.ownState.getCommitment({ address, hash })` returns `OwnerCommitment | null`. **`null` means "outside the drained snapshot scope" — i.e., the helper paged the snapshot to `truncated:false` without finding `hash`. It is NOT a historical "doesn't exist" verdict.** Throws `OspexOwnStateError({reason:'scan_limit_exceeded'})` when the helper's defensive page bound is hit and the server is still reporting `truncated:true`; that case is UNKNOWN, not `null`.
- `client.ownState.subscribe({ address }, handlers)` opens the composite owner-auth SSE stream. Handlers are `onSnapshot` (fires per snapshot page — once on cold-start; plus any REST pages from a truncated handoff), `onReady` (fires after the final untruncated snapshot OR after server catchup on resume — the "safe to trade" signal), `onCommitment` / `onFill` / `onPositionStatus` (live deltas; `OwnerCommitment` carries the full payload regardless of `book_visible`, `PositionStatusEvent` wraps the wider `PositionLifecycle` enum that adds terminal `settledLost` / `void` beyond `OwnerPosition.status`), `onStatus` (`'connected' | 'reconnecting' | 'degraded' | 'resync'`), `onError` (non-fatal transport errors). Token lifecycle is internal — the SDK mints a stream-auth bearer via the challenge/token flow, caches it, refreshes ~120 s before expiry NON-INTERACTIVELY, and re-mints on 401. Reconnects with `Last-Event-ID` = running cursor (internal to the live subscription); a server-side `event: resync`, a rejected cursor (`400 INVALID_CURSOR`), or a failed truncated-snapshot REST paging attempt all drop the cursor, emit `onStatus('resync')`, and make the next reconnect a cold-start — a consumer that builds its baseline by accumulating `onSnapshot` pages MUST discard any partial accumulation on `resync` (the cold-start snapshot replaces the baseline; it is not a continuation). Across a PROCESS restart there is nothing to resume — a fresh `subscribe` cold-starts with a snapshot, which is the recommended pattern (the reference market maker does exactly this; the snapshot's cumulative fill amounts subsume anything missed while down). `Subscription.unsubscribe()` is the ONLY close path — no handler fires after `await sub.unsubscribe()` returns. From v0.5.2 the `OwnerCommitment` payload carries owner-only enrichment — `speculationId`, `sport`, absolute `awayTeam`/`homeTeam`, `updatedAtUnixSec`, and `signedPayload: SignedCommitmentPayload | null` (the canonical unit `commitments.cancelOnchainSigned(...)` consumes — authoritatively cancel a book-hidden row straight from own-state; `null` on indexer-discovered/signature-less rows) — and `OwnerPosition` carries `contestId` / `sport` / absolute teams / `riskAmountWei6` / `counterpartyRiskWei6` / `updatedAtUnixSec`.
- `client.ownState.health()` (v0.5.2) is a PUBLIC indexer-lag probe — no signer/token, no arguments. Returns `OwnStateHealth { indexerLagSeconds, lastIndexedAt, lagSource }`. A consumer's stream-health gate polls it on a slow cadence and holds quoting when `indexerLagSeconds` crosses its threshold — the reference market maker polls once per tick (its `ownState.auditPollIntervalMs`, default 60 s). Nothing latency-critical should wait on this probe: fills and lifecycle changes arrive over the stream in real time.

Refusing callers:

| SDK surface | Behavior on redacted input |
|---|---|
| `commitments.prepareMatch({ hash \| commitment })` | Throws `OspexValidationError({ field: 'commitment' })`. |
| `commitments.matchFromPreview(preview)` | Fresh re-fetch is a hidden body → throws (same shape). |
| `commitments.checkCommitmentFillability({ hash \| commitment })` | Returns `outcome: 'not-fillable'` with `reasons: [{ code: 'COMMITMENT_REDACTED' }]`. No chain read, no `requireChainClient` / `getAddresses` access — the verdict resolves even for callers without an RPC config. |
| `commitments.cancelOnchain({ hash } \| { signedCommitment })` | Convenience overload — mutually exclusive inputs (throws on both supplied, throws on neither). `{ signedCommitment }` branch is a thin pass-through to `cancelOnchainSigned(payload)` and hits zero API endpoints; preferred path for makers / MMs holding the signed payload in local state, including book-hidden rows. `{ hash }` branch fetches via `CommitmentsApi.get` → `toCommitment`, narrows with `requireVisibleCommitment` BEFORE any signer / RPC / gas access, reconstructs the `SignedCommitmentPayload` from the visible row, then delegates; redacted public input throws `OspexValidationError({ field: 'commitment' })` without unlocking the keystore. |
| `commitments.cancelOnchainSigned(payload)` | Canonical low-level primitive — takes a complete `SignedCommitmentPayload` (`{ commitmentHash, commitment, signature }`). Validates payload shape, asserts the struct round-trips to `commitmentHash` against the configured chain's MatchingModule domain BEFORE signing (prevents an unguarded cancel marking a different `s_cancelledCommitments` slot when a stored row drifted from the signed payload), then broadcasts `MatchingModule.cancelCommitment(commitment)`. Hits no API endpoint. |
| `commitments.checkSubmitFundability({ preview, bookScope? })` | **Default (`bookScope` omitted / `'visible-book-only'`): visible-book-only** — the verdict carries `scope: 'visible-book-only'`. The public commitments list filters `book_visible=true` upstream, so the maker's book-hidden (`book_visible=false`) but still-on-chain-matchable rows (e.g. left live by the default off-chain `commitments cancel`) never appear in the summed book at all and are silently OUTSIDE the aggregate; a stray redacted row (only reachable via `?since=` recovery / defensive projection, neither of which the default scan uses) is likewise skipped. In this default the verdict does **NOT** degrade to `unknown` for hidden rows — so `fundable` means "fundable against the visible book," and real exposure can be higher. **Opt in** with `bookScope: 'whole-book'` (CLI `commitments submit --fundability-scope whole-book`) to ALSO count hidden exposure via an owner-auth own-state read: on success `scope: 'whole-book'`; if the own-state read is unavailable it never reports a false `fundable` (a definite shortfall still refuses, otherwise it degrades to `outcome: 'unknown'` / `HIDDEN_EXPOSURE_UNKNOWN`). See the advisory-preflight section (§ "Advisory preflights") for the full scope/coverage contract. A market-maker's per-tick funding guard tracks the same latent exposure locally rather than calling this per tick. |
| `commitments.cancelAllOnSpeculation({ ..., newMinNonce })` | **`newMinNonce` is REQUIRED** (interface-required AND runtime-validated; `OspexValidationError({ field: 'newMinNonce' })` on undefined or `<= 0`). The SDK no longer auto-computes a default because the public commitments list filters `book_visible=true` upstream, so a maker's cross-process book-hidden commitments at higher nonces are invisible to anonymous reads — any "convenience default" would silently leave them on-chain matchable. Callers must supply the floor from a source they trust (process-local nonce ledger, on-chain floor + headroom, or `client.ownState.snapshot({address, cursor?})` for the maker's full hidden+visible book — **the caller MUST drain every page (loop while `truncated:true`) before computing `max(nonce) + 1`, since a single-page read can leave higher-nonce hidden commitments live**; the SDK still requires the explicit floor here to keep the failure mode loud). The CLI's `commitments cancel-all` reflects this — `--new-min-nonce` is required for both `--dry-run` (preview) and execute (the dry-run filters its preview to `nonce < newMinNonce` so it shows what THIS floor would invalidate). The `complete-cancel-all` next-command round-trips the previewed floor verbatim. |

**Backwards compatibility.** Older core-api builds (predating the hidden-row redaction) omit the `redacted` flag entirely and serve only visible bodies; the SDK treats absence as `visibility: 'visible'`, so an SDK running against an older API behaves exactly like the pre-split code.

---

## 2. CLI: the `--json` contract

Every Class A `--json` invocation emits a single envelope matching `AgentEnvelope<TPayload>` — a shared shoulder block (`ok`, `action`, `stage`, `network`, `wallet`, `warnings`, `errors`, `effects`, `nextCommands`, …) wrapped around a command-specific `payload`. Agents route on the shoulder fields and read the payload only when they need command-specific data.

The full envelope shape, per-stage population rules, per-command field matrix, and failure envelope contract live in [`AGENT_ENVELOPE_SPEC.md`](./AGENT_ENVELOPE_SPEC.md). This section covers only the rules and payload shapes specific to the preview-bearing CLI surface.

### Dual-mode `--json`

Three commands ship a **dual-mode** `--json`: preview-only without `--yes`, execute-and-emit with `--yes`. These are the canonical agent-friendly commands:

| Command | `--json` alone | `--yes --json` |
|---|---|---|
| `ospex commitments submit` | `stage: 'preview'`, `payload: SubmitPreview`. **No signing, no POST.** | `stage: 'execute'`, `payload: { preview: SubmitPreview; result: { hash; commitment }; fundability: CheckSubmitFundabilityResult \| null; preflightFundability?; approvalRemediation? }`. Signs and posts. The `preview` mirrors the `--json`-alone envelope so agents can audit what they signed for; `result` carries the post-sign artifacts (`hash`, `commitment`) — pinned to that two-field subset, NOT the in-memory SDK `SubmitResult` (which carries the canonical `signedPayload` from v0.5.1 onward but is intentionally NOT emitted in CLI JSON; reach for it from the SDK return instead); `fundability` is the **effective send-time** submit-preflight verdict (post-approval re-check when the auto-approve loop confirmed; `null` when skipped). When the loop confirmed at least one tx, `preflightFundability` preserves the pre-approval verdict and `approvalRemediation` lists what got resolved. |
| `ospex commitments match` | `stage: 'preview'`, `payload: MatchPreview`. **No tx.** The signer may unlock once to derive the taker address (for the `selfMatch` flag and allowance preflight) — only when a non-interactive credential is configured. See §4 (lazy-unlock contract). | `stage: 'execute'`, `payload: { preview: MatchPreview; result: MatchResult; fillability: CheckCommitmentFillabilityResult \| null; preflightFillability?; approvalRemediation? }`. Sends a tx. Same audit-friendly shape as submit — `preview` mirrors the preview envelope; `result` carries `txHash`, `status`, `blockNumber`, and the per-side risk wei6 figures; `fillability` is the **effective send-time** match-preflight verdict (post-approval re-check when the auto-approve loop confirmed; `null` when skipped). When the loop confirmed at least one tx, `preflightFillability` preserves the pre-approval verdict and `approvalRemediation` lists what got resolved. |
| `ospex approvals setup` | `stage: 'preview'`, `payload: { plan: SetupPlan }`. No tx. | `stage: 'execute'`, `payload: { plan: SetupPlan; results: SetupResult[] }`. Executes the plan; one entry in `results` per approval tx. |

Other write commands (`contests score`, `settle`, `claim`, `claim-all`, `commitments cancel`, `commitments cancel-onchain`, `commitments cancel-all`) treat `--json` as **output format only** — they may still send a transaction. Use `--dry-run` where available (`claim-all`, `commitments cancel-all`) for plan-only behavior.

### Payload TypeScript shapes

The per-command `payload` types are the SDK preview/result models — `AgentEnvelope` adds the shoulder block around them. The one exception: the `submit` / `match` **execute** payloads also carry the advisory preflight verdict (`fundability` / `fillability`) alongside `preview` / `result` (see "Advisory preflights" below).

```ts
// commitments submit --json (no --yes)  →  AgentEnvelope<SubmitPreview>
// SubmitPreview: contest, market { speculation { creationFee, … } }, side, economics, expiry,
//                raw, approvals[], outcomes[], submitAction, you?, counterparty?

// commitments submit --yes --json
type SubmitResultEnvelope = AgentEnvelope<{
  preview: SubmitPreview;
  result: {
    hash: string;
    commitment: Commitment;
  };
  fundability: CheckSubmitFundabilityResult | null;
  preflightFundability?: CheckSubmitFundabilityResult;
  approvalRemediation?: {
    remediatedReasonCodes: SubmitFundabilityReasonCode[];
    approvalPurposes: ApprovalPurpose[];
  };
}>;
// payload.preview mirrors the --json-alone envelope verbatim.
// payload.result.hash is the commitment hash; payload.result.commitment is the persisted row.
// payload.fundability is the EFFECTIVE send-time submit-preflight verdict:
//   - post-approval re-check when the auto-approve loop confirmed any tx
//   - the pre-approval verdict when no approve was needed
//   - null when --skip-fundability-preflight / --force was set
//   - outcome:'unknown' (with FUNDABILITY_UNKNOWN) when the re-check itself failed
// payload.preflightFundability preserves the pre-approval verdict — present ONLY
//   when the re-check ran (i.e. some approve confirmed AND preflight was not skipped).
// payload.approvalRemediation summarizes what the loop resolved — present ONLY when
//   at least one approve tx confirmed.

// commitments match --json (no --yes)  →  AgentEnvelope<MatchPreview>
// MatchPreview: commitment, taker, selfMatch, contest, market, odds, economics, expiry,
//               speculation { mode, creationFee, lazyCreation? }, approvals[], warnings[],
//               tradeAction, you?, counterparty?, outcomes?

// commitments match --yes --json
type MatchResultEnvelope = AgentEnvelope<{
  preview: MatchPreview;
  result: {
    txHash: `0x${string}`;
    status: 'success' | 'reverted';
    blockNumber: string;            // decimal string (bigint-safe)
    takerRiskWei6: string;
    fillMakerRiskWei6: string;
  };
  fillability: CheckCommitmentFillabilityResult | null;
  preflightFillability?: CheckCommitmentFillabilityResult;
  approvalRemediation?: {
    remediatedReasonCodes: FillabilityReasonCode[];
    approvalPurposes: ApprovalPurpose[];
  };
}>;
// Same pre/post split as submit (see comment block above). On a successful
// match where the auto-approve loop resolved a taker-allowance shortfall,
// payload.fillability is the post-approval re-check (typically `fillable`)
// and payload.preflightFillability preserves the original verdict for audit.
```

The `{ preview, result, … }` shape on execute envelopes is deliberate: agents reading the result can verify the preview block in the same envelope against the preview block they accepted at signing time, without holding state across two invocations. `submit` / `match` add the preflight verdict (`fundability` / `fillability`) alongside. Reach for `payload.result.txHash` (not `payload.txHash`); `payload.preview` is identical-shape to the preview envelope and carries the same audit fields.

`SubmitResultEnvelope` / `MatchResultEnvelope` above are **illustrative** — the SDK exports the generic `AgentEnvelope<T>`, not these exact aliases. The similarly-named `SubmitPreviewEnvelope` / `SubmitJsonResult` / `MatchPreviewEnvelope` / `MatchJsonResult` types the SDK *does* export are **`@deprecated` pre-v2 wire shapes** (`schemaVersion: 1`, no preflight verdict) — kept for back-compat, NOT what the current CLI emits.

Authoritative payload sources: [`packages/sdk/src/types/preview.ts`](../packages/sdk/src/types/preview.ts) and [`packages/sdk/src/types/matchPreview.ts`](../packages/sdk/src/types/matchPreview.ts). Authoritative envelope source: [`packages/sdk/src/types/agentEnvelope.ts`](../packages/sdk/src/types/agentEnvelope.ts).

### Perspective view (`you` / `counterparty` / `outcomes`)

Both envelopes carry an optional first-person view of the trade alongside the existing maker/taker fields. The blocks normalize the protocol's "maker on Upper / Lower" / "taker on the inverted side" semantics into one shape the executing party (the agent) can read directly:

```ts
interface PreviewYou {
  role: 'maker' | 'taker';                  // which protocol role the viewer is playing
  address: `0x${string}`;                   // viewer's wallet (lowercased)
  backing: string;                          // "Los Angeles Dodgers" / "Lakers -3.5" / "Over 220.5"
  odds: { decimal: string; american: string; oddsTick: number };
  risk: { wei6: string; usdc: string };     // 6dp USDC ("4.999918")
  profit: { wei6: string; usdc: string };
  totalReturn: { wei6: string; usdc: string };  // risk + profit (not "return" — polyglot-codegen safe)
}

interface PreviewCounterparty extends Omit<PreviewYou, 'address'> {
  address: `0x${string}` | null;            // null on SubmitPreview (no taker has signed yet)
}
```

On `MatchPreview` the viewer is the taker (`you.role === 'taker'`) and the counterparty is the named maker. On `SubmitPreview` the viewer is the maker (`you.role === 'maker'`) and the counterparty is a hypothetical full-fill taker (`address: null`). The shape is uniform across both envelopes so polyglot agent code can dispatch on one accessor path.

USDC values inside `you` / `counterparty` are always 6 fractional digits, round-tripping with `wei6ToDecimalUSDC` / `usdcDecimalToWei6` — concise formats (`"5.00"`) appear only in human renderers, never in JSON.

The perspective fields are **optional on the payload**. The `@ospex/sdk` exports `computeMatchYouView(preview)` and `computeSubmitYouView(preview)` — pure accessors that return the view directly when present and backfill from the legacy `makerSide` / `takerSide` / `odds` / `economics` (or `side` / `economics` on submit) blocks when absent. Agents consuming either shape call one helper and never branch.

The CLI mirror: `ospex commitments match` and `ospex commitments submit` render this view by default in human mode. Pass `--raw` to fall back to the pre-perspective-view layout for debugging EIP-712 hash mismatches and protocol-level audits — the exact restored content differs by command:

- `commitments match --raw` restores the dual `maker side:` / `taker side:` layout, the both-perspective `line:` and `odds:` lines (with `[oddsTick=…]` and protocol `line_ticks`), the `taker risks:` / `maker fill:` block, and raw approval-row wei6 figures.
- `commitments submit --raw` restores the `positionType=Upper/Lower` tag inside the `[sideTags]` bracket on the `side:` line. The submit render had no other protocol-leakage to suppress.

`--raw` has no effect on `--json` output — the envelope is the agent contract.

### Lazy creation fee semantics

A commitment match whose `(contestId, scorer, lineTicks)` tuple has no speculation yet triggers **lazy speculation creation** and pulls a creation fee (0.50 USDC on Polygon mainnet / Amoy; split 50/50 between maker and taker via `TreasuryModule.processSplitFee`). Once the speculation exists, no further matches pay this fee.

The agent contract surfaces this in two always-present, mode-symmetric fields. Read once; act:

| Question | Field | Existing | Lazy |
|---|---|---|---|
| Is this trade-only or trade + speculation creation? | `tradeAction` / `submitAction` | `'trade-only'` | `'trade-and-create-speculation'` |
| Does a fee apply on this tx? | `speculation.creationFee.applies` | `false` | `true` |
| Is the lazy case conditional? | `speculation.creationFee.condition` | `'never'` | `'if-first-match-at-execution'` |
| What will THIS wallet pay? | `speculation.creationFee.viewerShareUSDC` | `'0.000000'` | viewer's share (collapses on self-match) |
| Which spender? | `speculation.creationFee.spender` + `spenderLabel` | `null` / `null` | TreasuryModule address / `'TreasuryModule'` |
| Approval needed? | `speculation.creationFee.approvalNeeded` | `false` | `true` iff `viewerTreasuryAllowance < viewerShare` |
| Approval-row discriminator | `speculation.creationFee.approvalPurpose` | `null` | `'lazy-creation-fee'` |

`viewerShareUSDC` is the practical "wallet exposure" answer — on a `MatchPreview` the viewer is the taker, and on a self-match (taker===maker) it collapses to the FULL fee (the single wallet pays both halves of `TreasuryModule.processSplitFee`). On a `SubmitPreview` the viewer is the maker; no self-match concept yet (no taker has signed), so `viewerShare === makerShare`.

`tradeAction` and `submitAction` describe the preview-time expected execution path — **not a guarantee**. On a lazy match, another tx may create the speculation first; if it lands before yours, your tx executes as trade-only and no fee is charged. The contract field `creationFee.condition === 'if-first-match-at-execution'` makes this race explicit so agents reason about it correctly.

The legacy `speculation.lazyCreation` block (lazy-mode only) is still emitted for back-compat and carries the `makerTreasuryAllowance*` diagnostic + the `'maker-treasury-allowance-insufficient'` warning. New code should prefer `creationFee` for fee semantics; `lazyCreation` is marked `@deprecated` in TypeScript.

### Advisory preflights (fillability / fundability)

A signed commitment can be perfectly valid yet still revert at fill time because a wallet moved USDC or dropped an allowance. `match` and `submit` each run a **read-only, advisory** preflight before the write to catch this, and the two SDK primitives — `client.commitments.checkCommitmentFillability(...)` (taker side) and `client.commitments.checkSubmitFundability({ preview })` (maker side) — expose the same verdict shape programmatically: a discriminated `outcome` (`fillable`/`not-fillable`/`unknown` · `fundable`/`not-fundable`/`unknown`), a structured `reasons[]`, and `advisory: true` (the maker-side fundability verdict additionally carries a `scope` (`'visible-book-only'` | `'whole-book'`) marker and a `coverage: { visible, hidden, source }` object recording exactly what the aggregate included — see below). Both are **point-in-time, never a guarantee** — balances/allowances can change before the match/fill.

- **`commitments match` → fillability** ("can *I* fill *this* commitment now?"). Reads maker + taker USDC balances and the maker→PositionModule allowance (the gap the on-chain match path doesn't prove). It **refuses before sending** on a non-remediable reason — `MAKER_USDC_BALANCE_INSUFFICIENT`, `MAKER_POSITION_ALLOWANCE_INSUFFICIENT`, `MAKER_TREASURY_ALLOWANCE_INSUFFICIENT`, `TAKER_USDC_BALANCE_INSUFFICIENT`, `LINE_TICKS_OUT_OF_RANGE`, or a liveness/`SPECULATION_CLOSED` reason. The **taker's own** allowance shortfalls do NOT block (the command's approve-loop remediates them); `FILLABILITY_UNKNOWN` (a read failed) warns and proceeds. Also available standalone, read-only: `ospex commitments fillability <hash> [--taker …] [--risk-usdc …] [--json]`.
  - **`LINE_TICKS_OUT_OF_RANGE`** is the client-side mirror of the protocol's `MAX_LINE_TICKS` magnitude bound (`|lineTicks| ≤ 1,000,000`, i.e. ±100,000.0 points). A line larger than that overflows the spread scorer, so once the contest is scored settlement reverts forever and **both** sides' escrowed USDC are permanently locked with no recovery. It is a property of the signed commitment (no chain read, no funding question) and is **never fillable** for any taker. The SDK enforces the same bound at the source: `commitments.submit` / `submitRaw` (maker) and `commitments.match` (taker) raise `OspexValidationError({ field: 'lineTicks' })` rather than sign or fill such a commitment. The two paths surface it differently: in the `commitments match` **command** the throw fires inside `prepareMatch` at preview-build time, *ahead of and instead of* the fillability preflight (so the output is a thrown `field: 'lineTicks'` validation error, not a preflight refusal envelope); called directly as an advisory (the SDK `checkCommitmentFillability` or `ospex commitments fillability`), the same condition is reported as the `not-fillable` reason `LINE_TICKS_OUT_OF_RANGE` with no chain read. (`MAX_LINE_TICKS` is exported from `@ospex/sdk` for callers that want to screen lines themselves.)
- **`commitments submit` → fundability** ("can I back what I'm about to sign?"). Reads the maker's USDC balance + PositionModule/TreasuryModule allowance and the maker's open-commitment book, then checks the **whole visible book** (existing open risk + this commitment + lazy creation fees) — `submit`'s approve-loop only ever covers *this* commitment's allowance and reads no balance, so this is what catches whole-visible-book over-commitment. It **refuses before signing** ONLY on `MAKER_USDC_BALANCE_INSUFFICIENT` (you can't approve USDC into existence). Maker **allowance** shortfalls (`MAKER_POSITION_ALLOWANCE_INSUFFICIENT` / `MAKER_TREASURY_ALLOWANCE_INSUFFICIENT`) are remediable (the approve-loop, or a manual `approve`) so they **warn, not block**; `EXISTING_LAZY_FEE_UNDETERMINED` (existing open commitments might owe creation fees that can't be confirmed without per-speculation lookups) and `FUNDABILITY_UNKNOWN` (a read failed) warn and proceed. By default the sum is **visible-book-only** (the verdict carries `scope: 'visible-book-only'`, `coverage.hidden: 'excluded'`): the public list filters `book_visible=true`, so book-hidden but still-on-chain-matchable rows — e.g. left live by the default off-chain `commitments cancel` — are NOT counted and do NOT degrade the verdict, so a default `fundable` verdict means "fundable against the visible book" and real exposure can be higher. **Opt into a whole-book verdict** with `checkSubmitFundability({ preview, bookScope: 'whole-book' })`: it sources the maker's ENTIRE live book (visible + hidden, unredacted) from a fully-drained owner-auth own-state snapshot (one consistent source — no public-list/own-state skew or double-count), so the hidden rows ARE counted (`scope: 'whole-book'`, `coverage.hidden: 'included'`, plus `existingVisible*`/`existingHidden*` breakdown on `requirement`). Whole-book mode requires a signer matching `preview.raw.maker` and mints one EIP-712 stream-auth token for the read — **it signs no transaction and consumes no nonce**. It **never reports a false `fundable`**: if the signer is missing/mismatched or the own-state read can't fully drain, a definite visible/new shortfall still returns `not-fundable`, otherwise the verdict degrades to `outcome: 'unknown'` with reason **`HIDDEN_EXPOSURE_UNKNOWN`** and `coverage.hidden: 'unknown'` (the achieved `scope` stays `'visible-book-only'`). Hidden exposure is never exposed through anonymous/public reads — only the owner-authenticated own-state surface. (A market-maker should rely on its own per-tick funding guard for book-hidden exposure rather than route this per tick; whole-book mode is for standalone SDK/CLI makers and operator diagnostics.) From the CLI, select the scope with **`ospex commitments submit … --fundability-scope <visible-book-only|whole-book>`** (default `visible-book-only`). `whole-book` performs the owner-auth read with your configured signer — it may sign an EIP-712 stream-auth challenge but submits **no transaction and consumes no nonce**, and only on the execute path (`--yes` / interactive), never on a `--json`-only preview. The verdict (incl. `scope` + `coverage`) rides `payload.fundability` on the execute envelope; `HIDDEN_EXPOSURE_UNKNOWN` is advisory (warn-and-proceed), only a definite balance shortfall refuses.

Both preflights run on the **execute path** by default (not on a `--json`-only preview); bypass with **`--force`** (alias for **`--skip-fillability-preflight`** / **`--skip-fundability-preflight`**). JSON contract:

- A **refusal** is an `ok: false`, `stage: 'execute'` envelope. The blocking reason(s) are surfaced as `severity: 'blocking'` `warnings[]` (`blockingFor: ['match']` / `['submit']`), the full verdict + a marker sit in the payload (`{ preflight, action: 'refused-before-send' }` for match / `{ fundability, action: 'refused-before-sign' }` for submit), and `effects` is empty (nothing was signed or sent).
- A **proceeding** (executed) write carries the **effective send-time verdict** — including its `reasons[]` — under `payload.fillability` (match) / `payload.fundability` (submit), **always present** and **`null` when the preflight was skipped**. When the auto-approve loop confirmed at least one tx, the verdict is a **post-approval re-check** (a fresh `checkCommitmentFillability` / `checkSubmitFundability` ran between the approve loop and the send), and the original pre-approval verdict is preserved under `payload.preflightFillability` / `payload.preflightFundability` (only present in that case). A `payload.approvalRemediation: { remediatedReasonCodes, approvalPurposes }` block accompanies the re-check, listing the reason codes the loop resolved and which `ApprovalPurpose` rows confirmed. If the re-check itself failed (RPC blip), `payload.<verdict>.outcome` is `'unknown'` with a `FILLABILITY_UNKNOWN` / `FUNDABILITY_UNKNOWN` reason — the write still proceeded, but the envelope refuses to fabricate a clean verdict from stale data. The verdict's non-blocking reasons are NOT duplicated into the proceed envelope's `warnings[]` — read them from `payload.<verdict>.reasons`; the human (non-`--json`) path prints them to stderr. A `--json`-only preview (no `--yes`) does not carry the verdict (the preflight is execute-path only). **Contract guarantee:** a `proceed` envelope (`ok: true` with a successful match/submit effect) MUST NOT carry a blocking `allowance-short` warning sourced from a stale pre-approval verdict; the shoulder warning is derived from the post-approval state.

The above are **per-fill / per-submit** checks. There is also a **book-wide read advisory**: `ospex commitments list --with-fillability` (SDK: `client.commitments.list({ includeFillability: true })`) attaches an advisory `fillability` object to each commitment, sourced from the indexer's ~30s maker-funding snapshot — no per-fill on-chain reads, so it's cheap to triage a whole book. Each object carries `makerFundingStatus` (`fully_backed` | `overcommitted` | `unknown` | `stale`), `orderIndividuallyBackedNow` (backing covers THIS order's remaining risk) vs `makerBookBackedNow` (backing covers the maker's *whole* visible book — a maker can be the former but not the latter, which is the "fake liquidity" signal), `makerBackingWei6` / `makerVisibleCommittedWei6` / `makerCoverageRatioBps`, `checkedAtBlock`, and `stale`. The `…BackedNow` booleans are `null` when `unknown`/`stale` (a "now" assertion can't be made from a missing/old snapshot). Advisory + point-in-time, **never folded into `status`**. Under `--json` each commitment in the `commitments.list` payload simply gains the `fillability` field; it's omitted entirely without the flag. For a definitive go/no-go on a *single* fill, use the `match` preflight / `checkCommitmentFillability` above.

### Numeric-field rule

Every value that may exceed `Number.MAX_SAFE_INTEGER` is a **decimal string** (`'1000000'`, never `1000000`). This includes:

- `riskWei6`, `riskAmount`, `nonce`, `expiry`
- `blockNumber`, `takerRiskWei6`, `fillMakerRiskWei6`
- `oddsTick` is a small int — emitted as a number, but adjacent USDC formatted strings (`riskUSDC: '1.000000'`) accompany it.

USDC formatted strings are six fractional digits: `'1.000000'`, `'0.250000'`. Round-trip with `usdcDecimalToWei6` / `wei6ToDecimalUSDC` from the SDK barrel.

### `--json` always goes to stdout

Stdout is reserved for the JSON payload. Anything else — passphrase prompts, "Resolved 0xabc → 0xabcdef…" prefix-resolution echoes, progress logs, allowance prompts — goes to **stderr**. `… --json | jq .` is therefore always parseable.

A non-TTY run that wants `--json` output and would otherwise prompt for a passphrase fails up-front with `OspexSignerResolutionError({ reason: 'non_interactive_password_required' })` rather than hanging on hidden-input read. The agent-friendly fixes (in order of preference): pass `--expected-address` to skip the unlock entirely; pin a Foundry account + password file via `ospex auth use-foundry`; or pass `--account` + `--password-file` per invocation. The legacy `ospex wallet unlock` cached session is kept for compatibility but is not the recommended posture — see §4 for the full surface.

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

**Other write commands sign and send WITHOUT requiring `--yes`** — including `commitments cancel`, `commitments cancel-onchain`, `commitments cancel-all`, top-level `claim`, `claim-all`, `settle` (registered at the program root for ergonomics, not under `positions`), `contests score`, and `contests create --game-id <uuid>`. For these, `--json` is an *output format only*, not a preview gate; the command may still send a transaction. Use `--dry-run` where available (`claim-all`, `commitments cancel-all`) for plan-only behavior.

**`--yes` does not auto-approve approvals.** When `--yes` is set on a preview-bearing command and an allowance is short, the command defaults to the **exact required** USDC amount, not unlimited. Pass `--approve-max` alongside `--yes` if you want unlimited.

**`--yes` is one-time consent.** Each invocation confirms via `--yes` once. There is no global "trust this agent for the next N minutes" mode — keep your call sites explicit.

---

## 4. Non-interactive signing

Agents can't answer interactive passphrase prompts. The CLI and SDK both expose a non-interactive signer surface that reads the passphrase from a file, stdin, or env var, decrypts the Foundry keystore in process memory for the duration of one command, and discards the decrypted material when the command returns. The legacy session-cache file (`~/.ospex/session`) is **not** written on this path.

The contract has four parts: a per-invocation flag group on every write command, a one-time pinning step via `ospex auth use-foundry`, a lazy-unlock guarantee for `--json` preview-only paths, and a diagnostic (`ospex auth check`) that mirrors the same resolution ladder a real write would walk.

### Flag group (every write command)

Every command that signs a transaction or an EIP-712 payload accepts the same six flags:

| Flag | Effect |
|---|---|
| `--account <name>` | Foundry keystore name. Resolves to `<foundryKeystoresDir>/<name>`. Mutually exclusive with `--keystore-path`. |
| `--keystore-path <path>` | Absolute path to a v3 keystore JSON. Mutually exclusive with `--account`. |
| `--password-file <path>` | Read the passphrase from a file (trailing newline trimmed, matching `cast`). Mutually exclusive with `--password-stdin`. |
| `--password-stdin` | Read the passphrase from stdin (first line). |
| `--expected-address <0x…>` | Refuse to sign if the unlocked keystore's address doesn't match. Comparison is case-insensitive. |
| `--foundry-keystores-dir <path>` | Override the Foundry keystores root. Default precedence: this flag → `$OSPEX_FOUNDRY_KEYSTORES_DIR` → `$FOUNDRY_DIR/keystores` → `~/.foundry/keystores`. |

The CLI **never** accepts a raw passphrase or a raw private key as a CLI argument or env var. There is intentionally no `--password <value>` flag and no `OSPEX_PASSWORD` env var — passphrases are file paths or piped stdin only.

### Env vars

| Var | Effect |
|---|---|
| `OSPEX_KEYSTORE_PATH` | Direct path to a v3 keystore JSON. Highest-precedence env keystore source. |
| `OSPEX_PASSWORD_FILE` | Path to a passphrase file. The file is the secret; only the path is in the env. |
| `OSPEX_FOUNDRY_KEYSTORES_DIR` | Override the Foundry keystores root. |
| `FOUNDRY_DIR` | Foundry's standard env var. The CLI appends `/keystores`. |
| `OSPEX_HOME` | Ospex home dir (default `~/.ospex`). Tests use this to point at a tmpdir. |

There is no env var that holds the passphrase itself — passing one through `/proc/<pid>/environ` is exactly the leak this surface exists to avoid.

### Precedence ladder

For each field, the highest source wins; lower sources are silently dropped.

| Field | Precedence (high → low) |
|---|---|
| Keystore | `--account` / `--keystore-path` flag → `OSPEX_KEYSTORE_PATH` env → `foundryAccount` / `foundryKeystorePath` in config (set by `auth use-foundry`) → legacy `keystorePath` in config (set by `ospex init`) → default `~/.ospex/keystore.json` |
| Passphrase | `--password-file` / `--password-stdin` flag → `OSPEX_PASSWORD_FILE` env → `passwordFile` in config → cached session (`~/.ospex/session`, only when the keystore is a legacy source — see subtlety #3) → interactive prompt |
| Expected address | `--expected-address` flag → `expectedAddress` in config (only when the resolved keystore corresponds to the configured source) → no pin |
| Foundry keystores dir | `--foundry-keystores-dir` flag → `OSPEX_FOUNDRY_KEYSTORES_DIR` env → `$FOUNDRY_DIR/keystores` env → `foundryKeystoresDir` in config → default `~/.foundry/keystores` |

Three precedence subtleties carved out by the regression tests in `tests/auth-check.test.ts`:

1. **Config-pinned `expectedAddress` does not apply to env `OSPEX_KEYSTORE_PATH` overrides** unless the env path equals `config.foundryKeystorePath` exactly. A pin set by `auth use-foundry --account X` is for X; pointing env at a different keystore does not inherit the pin.

2. **Legacy keystore paths (`config.keystorePath` from `ospex init`, default `~/.ospex/keystore.json`) ignore flag / env / config password sources.** The legacy code path is interactive only — it either reads the cached session or prompts. To get non-interactive unlocking on the legacy keystore, migrate with `ospex auth use-foundry --keystore-path <legacy-path>`. This is why `auth check` reports `password.provenance: 'none'` (would prompt) when only `config.passwordFile` is set on a legacy keystore — the runtime cannot consume it.

3. **An explicit keystore source never falls back to the cached session.** When the keystore is selected via `--account` / `--keystore-path` flag, `OSPEX_KEYSTORE_PATH` env, or a config-pinned `foundryAccount` / `foundryKeystorePath`, the legacy session cache (`~/.ospex/session`) is **excluded** from the passphrase ladder entirely — `auth check` reports `password.provenance: 'none'` even when a fresh session exists. Without this guardrail, an agent's `--account maker-a --sign-challenge` could happily sign with a stale session for an entirely different wallet. Mirrors `loadSigner`'s "path-1 explicit skips path-2 session" rule; `auth check` is required to enforce the same.

### Pinning a default signer

```bash
ospex auth use-foundry --account ospex-stage-maker-a --password-file ~/.ospex/secrets/maker-a.pass
```

Decrypts the keystore once to validate the passphrase, captures the unlocked address, and writes the following to `~/.ospex/config.json`:

```jsonc
{
  "foundryAccount": "ospex-stage-maker-a",
  "passwordFile": "/home/agent/.ospex/secrets/maker-a.pass",
  "foundryKeystoresDir": "/home/agent/.foundry/keystores",
  "expectedAddress": "0xab12…34cd"
}
```

Subsequent write commands resolve these as the keystore source, password source, and address guardrail. Re-running `auth use-foundry` overwrites the pin; pass `--no-pin-address` to opt out of the address pin (useful when intentionally rotating keys under the same account name).

For the explicit-path variant, pass `--keystore-path` instead of `--account` — it writes `foundryKeystorePath`, a distinct field from the legacy `keystorePath` set by `ospex init`. The split is intentional: `auth use-foundry` never overwrites the field `ospex init` populated, so users with only an `init` setup keep today's behavior.

### Clearing a pinned signer

```bash
ospex auth clear-foundry --all
```

Removes every Foundry signer field (`foundryAccount`, `foundryKeystorePath`, `passwordFile`, `foundryKeystoresDir`, `expectedAddress`) but **preserves** the legacy `keystorePath` from `ospex init`. Targeted flags clear individual fields: `--account`, `--keystore-path`, `--password-file`, `--expected-address`, `--foundry-keystores-dir`. Non-destructive when nothing is set.

### Lazy-unlock for `--json` previews

The two preview-bearing commands — `commitments submit --json` and `commitments match --json` (each without `--yes`) — must derive a maker / taker address to render the preview but must NOT surprise-unlock when no agent-friendly credentials are configured. The contract:

1. If `--expected-address <addr>` is set, use it directly. No I/O on the keystore.
2. Else if a non-interactive password source is configured (flag, env, config, or a cached session), unlock silently and derive the address.
3. Else throw `OspexSignerResolutionError({ reason: 'non_interactive_password_required' })` with a three-path remediation message:

```
Preview-only `--json` mode needs a non-interactive signer source.
Pass --expected-address <0x...>, or --account <name> --password-file <path>,
or run `ospex wallet unlock` first.
```

Agents that want the preview without unlocking should pass `--expected-address`. The actual unlock-and-sign branch fires only after the user / agent confirms with `--yes`.

### `ospex auth check`

A diagnostic command that walks the same resolution ladder a real write command would, reports the provenance of every field, optionally unlocks + verifies, and optionally signs a static EIP-712 challenge — without sending a transaction or mutating any API state.

```bash
ospex auth check                            # walk + report
ospex auth check --strict                   # promote loose password-file perms to a hard error
ospex auth check --sign-challenge           # also sign a deterministic challenge to prove end-to-end signing
ospex auth check --json                     # machine-readable AgentEnvelope<AuthCheckPayload>
```

It also accepts the full signer flag group (`--account`, `--keystore-path`, etc.) so agents can validate a candidate configuration before committing it via `auth use-foundry`.

#### Envelope shape: `AgentEnvelope<AuthCheckPayload>`

The `--json` output is the v2 wrapper around an `AuthCheckPayload`. The shoulder block (`schemaVersion: 2`, `ok`, `action: 'auth.check'`, `stage: 'read'`, `warnings`, `errors`, `nextCommands`, etc.) follows the rules in [`AGENT_ENVELOPE_SPEC.md`](./AGENT_ENVELOPE_SPEC.md). The payload carries the diagnostic detail:

```ts
interface AuthCheckPayload {
  strict: boolean;
  resolution: {
    keystore: {
      provenance: KeystoreProvenance;
      path: string;
      account: string | null;
      exists: boolean;
    };
    password: {
      provenance: PasswordProvenance;
      path: string | null;
      exists: boolean | null;
    };
    expectedAddress: {
      provenance: 'flag' | 'config' | 'none';
      value: `0x${string}` | null;
    };
    foundryKeystoresDir: {
      provenance:
        | 'flag'
        | 'env-OSPEX_FOUNDRY_KEYSTORES_DIR'
        | 'env-FOUNDRY_DIR'
        | 'config'
        | 'default';
      value: string;
    };
  };
  unlock: {
    attempted: boolean;
    succeeded: boolean | null;
    address: `0x${string}` | null;
    skippedReason: 'no_non_interactive_password' | null;
  };
  passwordFilePermissions: {
    checked: boolean;
    platformSkipped: boolean;     // true on Windows — POSIX semantics don't apply
    mode: number | null;          // POSIX mode bits (lower 9)
    octal: string | null;         // '600', '644', ...
    loose: boolean | null;        // (mode & 0o077) !== 0
  };
  challenge: {
    requested: boolean;
    signed: boolean;
    signature: `0x${string}` | null;
  };
}

type KeystoreProvenance =
  | 'flag-account'
  | 'flag-keystore-path'
  | 'env-OSPEX_KEYSTORE_PATH'
  | 'config-foundryAccount'
  | 'config-foundryKeystorePath'
  | 'config-keystorePath-legacy'    // set by `ospex init`, NOT by `auth use-foundry`
  | 'default-legacy';               // ~/.ospex/keystore.json

type PasswordProvenance =
  | 'flag-password-file'
  | 'flag-password-stdin'
  | 'env-OSPEX_PASSWORD_FILE'
  | 'config-passwordFile'
  | 'session-cache'
  | 'none';
```

Shoulder-block notes specific to this command:

- Top-level `ok` mirrors the diagnostic verdict — `true` when the resolved signer is usable for the requested check (unlock or sign-challenge, when set).
- `warnings[]` follows the structured `AgentWarning` shape; loose password-file permissions surface as `code: 'password-file-permissions-loose'` (severity `warning`, promoted to `blocking` under `--strict`).
- `errors[]` uses the `OspexError.code` taxonomy (see §7).

Provenance enum values are stable; new values may be added (forward-compatible — log + ignore unknown). Authoritative source: [`packages/cli/src/commands/auth/check.ts`](../packages/cli/src/commands/auth/check.ts).

Exit code: `0` if `ok === true`, `1` otherwise.

#### `--sign-challenge` payload

Deterministic EIP-712 typed-data. Same key → same signature, forever. Agents can recreate this domain to verify a signature out-of-band:

```ts
const AUTH_CHALLENGE = {
  domain: { name: 'Ospex Auth Check', version: '1' },
  types: {
    AuthChallenge: [
      { name: 'product', type: 'string' },
      { name: 'purpose', type: 'string' },
    ],
  },
  primaryType: 'AuthChallenge',
  message: {
    product: 'ospex',
    purpose: 'auth-check signing self-test',
  },
} as const;
```

The domain intentionally omits `chainId` and `verifyingContract` — this is a self-test, not a protocol message; binding to a chain would make Amoy vs mainnet checks produce different signatures for the same key. `auth check --sign-challenge` requires a non-interactive password source; absent one it errors with `reason: 'non_interactive_password_required'`.

### `ospex doctor --strict`

`doctor` gained the same `--strict` flag as `auth check`. A group/other-readable password file (`mode & 0o077 !== 0`) becomes a hard `password_file_permissions_loose` error before any chain calls run — useful as a CI gate ahead of a batch of writes. Default `doctor` still emits a stderr warning and proceeds.

### SDK equivalents

The CLI flag surface delegates to two SDK constructors that any programmatic consumer can use directly:

```ts
import { KeystoreSigner } from '@ospex/sdk/signers/keystore';

const signer = await KeystoreSigner.fromFoundryAccount({
  account: 'ospex-stage-maker-a',
  passwordFile: '/home/agent/.ospex/secrets/maker-a.pass',
  foundryKeystoresDir: '/home/agent/.foundry/keystores',  // optional
  expectedAddress: '0xab12…34cd',                          // optional guardrail
  strict: true,                                            // optional: hard-fail on loose pw-file perms
});

// Or by direct path:
const signer2 = await KeystoreSigner.fromKeystoreFile({
  keystorePath: '/path/to/v3-keystore.json',
  passwordFile: '/path/to/pw',
});
```

Both helpers throw `OspexSignerResolutionError` with one of the documented `reason` codes on failure (see §7). They never re-encrypt or copy the key — the decrypted material lives in the returned `KeystoreSigner` instance and is discarded when it goes out of scope.

For callers that need fine-grained control, the lower-level resolver and reader are also exported from the same subpath:

```ts
import {
  resolveKeystoreSource,
  readPassphrase,
  checkPasswordFilePermissions,
  type OspexEnv,
} from '@ospex/sdk/signers/keystore';
```

These are pure compositional pieces with no implicit env/config layering — the CLI does its env/config layering before calling them. The structural `OspexEnv = Record<string, string | undefined>` is the env-vars type; it's compatible with `process.env` without dragging `@types/node` into consumers that haven't installed it.

---

## 5. CLI: the streaming contract (`odds watch` + `own-state watch`)

Two CLI commands stream line-delimited JSON (NDJSON) under `--json` instead of a single v2 envelope: `odds watch` (public upstream odds) and `own-state watch` (owner-authenticated maker state). Both emit one independently-parseable JSON object per line, keep stdout reserved for the data lines (banners / status to stderr in human mode), and are deliberately outside the v2-envelope surface (`AGENT_ENVELOPE_SPEC.md §4.4`) — wrapping every line in the full envelope would balloon the stream.

### 5.1 `ospex odds watch`

`ospex odds watch <contestId> --json` is the agent-facing streaming primitive. It opens a core-api Server-Sent Events stream for each of the contest's three markets and emits one JSON object per line, NDJSON. The per-market `odds` shape is the same market-specific shape `ospex odds show` returns (authoritative source: [`packages/sdk/src/types/odds.ts`](../packages/sdk/src/types/odds.ts)) — provider-neutral, no upstream id.

### Wire shape per line

```ts
type WatchLine =
  | {
      kind: 'snapshot' | 'change' | 'refresh';
      market: 'moneyline' | 'spread' | 'total';
      // The market-specific odds shape, or null on a `snapshot` line when the
      // writer has no odds for this market yet. `change` / `refresh` always carry odds.
      //   moneyline → { market, awayOddsAmerican, homeOddsAmerican, ...timestamps }
      //   spread    → { market, awayLine, homeLine, awayOddsAmerican, homeOddsAmerican, ...timestamps }
      //   total     → { market, line, overOddsAmerican, underOddsAmerican, ...timestamps }
      odds: MarketOdds | null;
    }
  | {
      kind: 'status';
      market: 'moneyline' | 'spread' | 'total';
      status: 'connected' | 'reconnecting' | 'degraded';
    };
```

All odds and line fields are **numbers**, not strings — `-3.5`, `150`, `-180`; `null` when not populated. Example lines (formatted for legibility — actual output is single-line):

```jsonl
{"kind":"snapshot","market":"spread","odds":{"market":"spread","awayLine":1.5,"homeLine":-1.5,"awayOddsAmerican":-147,"homeOddsAmerican":127,"upstreamLastUpdated":"2026-05-21T01:02:38Z","pollCapturedAt":"2026-05-21T01:04:27Z","changedAt":"2026-05-21T00:59:26Z"}}
{"kind":"change","market":"moneyline","odds":{"market":"moneyline","awayOddsAmerican":150,"homeOddsAmerican":-180,"upstreamLastUpdated":"2026-05-21T01:02:38Z","pollCapturedAt":"2026-05-21T01:04:27Z","changedAt":"2026-05-21T01:05:00Z"}}
{"kind":"status","market":"moneyline","status":"degraded"}
```

### Promises

- **Each line is independently parseable JSON.** No multi-line objects.
- `kind` is one of: `snapshot` (the current baseline, emitted on connect and again after a `degraded` recovery), `change` (a real price move), `refresh` (a re-poll with no price move — only emitted with `--include-refreshes`), or `status` (a connection-lifecycle transition).
- The per-market `odds` object matches `ospex odds show`'s market shape exactly. `odds` is `null` only on a `snapshot` line when the market has no odds yet.
- Lines stream until SIGINT (Ctrl+C) or SIGTERM. The handler unsubscribes the streams and exits with code `0`.
- `--json` writes **only** these lines to stdout. The "Watching contest …, Ctrl+C to stop" banner is on stderr.
- A contest with no upstream linkage exits `1` with a single stderr message — do not retry; this contest cannot be watched.

### Non-promises

- **No replay of missed events.** Odds is latest-state, not a durable log. The transport reconnects automatically (full-jitter backoff) and re-emits a fresh `snapshot` on recovery — treat each event as the current value and the post-reconnect `snapshot` as your known-good baseline. There is no cursor and no catch-up.
- **No ordering guarantee across markets.** A `spread` change for contest X may arrive before a `moneyline` change for the same contest even if upstream ordered them the other way. Order is reliable per-market, not across markets.

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

### 5.2 `ospex own-state watch`

`ospex own-state watch [--address <wallet>] --json` is the owner-authenticated streaming primitive — the operator/agent view of a maker's own commitments, fills, and position transitions over the composite own-state SSE stream (`client.ownState.subscribe`). It is the read-only observability companion to the market-maker's own subscription: same backend stream, but redacted and bounded for capture into a (public) artifact.

**Auth + scope.** The stream is owner-authenticated (EIP-712 challenge → bearer token), so a signer is required. It resolves non-interactively via the standard Foundry signer flag group (§4). `--address` is the wallet the stream is scoped to and **defaults to the resolved signer address**; supplying an `--address` the signer does not own is refused up-front with `OspexValidationError({ field: 'address' })` (the server would reject the challenge anyway — failing fast is friendlier). The `--expected-address` guard from the signer flag group still applies to keystore resolution.

#### Wire shape per line

```ts
type OwnStateWatchLine =
  | { kind: 'snapshot'; at: string; address: string; cursor: string; truncated: boolean;
      positionsTruncated: boolean; commitmentCount: number; positionCount: number;
      // Omitted under --counts-only. Commitments are REDACTED by default (see below).
      commitments?: Array<RedactedOwnerCommitment | OwnerCommitment>; positions?: OwnerPosition[]; }
  | { kind: 'ready'; at: string; address: string; cursor: string }                 // "safe to trade" boundary
  | { kind: 'commitment'; at: string; address: string; cursor: string;
      commitment: RedactedOwnerCommitment | OwnerCommitment }
  | { kind: 'fill'; at: string; address: string; cursor: string; fill: Fill }
  | { kind: 'positionStatus'; at: string; address: string; cursor: string; event: PositionStatusEvent }
  | { kind: 'status'; at: string; address: string;
      status: 'connected' | 'reconnecting' | 'degraded' | 'resync' }
  | { kind: 'heartbeat'; at: string; address: string; liveCommitmentCount: number } // freshness pulse (~20s); count recomputed vs the heartbeat clock
  | { kind: 'error'; at: string; address: string; reason: 'connection_failed' | 'capacity_exceeded' | 'fatal';
      phase: string | null; status: number | null; message: string }
  | { kind: 'summary'; at: string; address: string;
      exitReason: 'until-ready' | 'ready-timeout' | 'duration' | 'max-events' | 'signal' | 'fatal';
      readyObserved: boolean; counts: { snapshot; ready; commitment; fill; positionStatus; status; heartbeat; error };
      liveCommitmentCount: number; lastStatus: string | null; lastCursor: string | null };
```

`at` is the CLI's ISO-8601 observation time on every line (the freshness signal; on a `heartbeat` line it is the SSE frame's receive time). `cursor` is the opaque own-state cursor AFTER the event (empty string on REST snapshot pages).

#### Redaction (output is artifact-safe by default)

Owner-auth bodies carry the maker's full matchable payload. By default, every owner commitment emitted by `own-state watch` has its EIP-712 **`signature`** and **`signedPayload`** struct removed — those are the only fields that would let a third party act on-chain against the maker's orders — and replaced with two markers:

```ts
type RedactedOwnerCommitment = Omit<OwnerCommitment, 'signature' | 'signedPayload' | 'redacted'> & {
  signatureRedacted: true;       // the signing material was stripped from THIS output
  signedPayloadPresent: boolean; // whether the owner row carried a cancel-ready signed payload
};
```

Every economic / lifecycle / identity field (`commitmentHash`, `maker`, `visibility`, `status`, `storedStatus`, `riskAmount`, `filledRiskAmount`, `remainingRiskAmount`, `nonce`, `oddsTick`, `expiry`, `isLive`, `speculationId`, teams, …) is preserved, so the line is fully usable for soak validation. The struct fields that remain are inert without the signature. Pass **`--include-signed`** to emit the full unredacted `OwnerCommitment` (`signature` + `signedPayload`) for local-only debugging — **never** feed that output into a public artifact. `fill` and `positionStatus` bodies carry no signing material and pass through unchanged.

#### Bounded run (for artifact capture)

| Flag | Effect |
|---|---|
| `--until-ready` | Exit `0` after the first `ready` event. Pair with `--ready-timeout <seconds>` (default 120) — exit `1` if no `ready` arrives in that window. |
| `--duration <seconds>` | Run for N seconds, then clean exit `0`. |
| `--max-events <n>` | Exit `0` after N delta events (`commitment` / `fill` / `positionStatus`; snapshot/ready/status/heartbeat do not count). |
| `--counts-only` | On `snapshot` lines, emit counts only — omit the `commitments` / `positions` arrays (terse runs). |

With none of these, the command runs until SIGINT (Ctrl+C) / SIGTERM. On any clean exit it emits a final `summary` line (event counts + `liveCommitmentCount`). `liveCommitmentCount` is **recomputed against the current wall clock** — at summary time and on every `heartbeat` line — from each tracked row's `storedStatus` / `remainingRiskAmount` / `expiry` / `nonceInvalidated`, NOT from the server's last-received `isLive` boolean. Because commitment expiry is passive (no SSE delta crosses it), this is what lets a long-running watcher age a passively-expired row out of the count without a fresh snapshot or reconnect — watch the `heartbeat` lines' `liveCommitmentCount` fall to zero as short-lived quotes expire.

#### Promises

- **Each line is independently parseable JSON.** No multi-line objects. The `summary` line is always last.
- `--json` writes **only** these lines to stdout; the "Watching own-state for …" banner and (in human mode) `status` / `heartbeat` / `error` / `summary` go to stderr.
- The default (no `--include-signed`) output **never** contains an EIP-712 signature or a `signedPayload` struct — safe to capture into a public artifact.
- Exit codes: `0` on a clean bounded exit or SIGINT; `1` on `--until-ready` timeout, a `fatal` stream error, or up-front validation failure (bad `--address`, signer mismatch).

#### Non-promises

- **Not a v2 envelope.** This is NDJSON, like `odds watch` (`AGENT_ENVELOPE_SPEC.md §4.4`). Switch on `kind`; treat unknown `kind` / enum values as forward-compatible (log + ignore).
- **Advisory `liveCommitmentCount`.** It is recomputed against the wall clock from the lifecycle state the watcher has observed (snapshot pages + commitment deltas) — so it correctly ages out passively-expired rows — but it is still NOT a reconciled chain/orderbook read: a lifecycle change the indexer hasn't streamed yet (e.g. an on-chain cancel observed only after the fact) won't be reflected until its delta arrives. Use `commitments list --maker` / the orderbook for an authoritative "open commitments == 0" gate.
- **No trading.** `own-state watch` is read-only observability; it never signs a transaction or mutates protocol state. (The owner-auth signer is used only for the stream-auth challenge.)

---

## 6. CLI: exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Generic failure (unhandled exception, validation error in argument parse). |
| `130` | User declined a confirmation prompt (`Cancelled.` printed to stderr). Equivalent to SIGINT in the shell convention. |

The SDK's typed errors that surface to the CLI all currently exit `1`. If you need to distinguish error classes programmatically, use `--json` and parse the result envelope OR catch the SDK error in a TypeScript caller — don't depend on richer exit codes.

`claim-all` is the one write that can report failure *without throwing*: it isolates per-entry failures into the result rather than aborting the sweep, so a partial or total failure exits `1` (envelope `ok: false`) while still reporting every entry's outcome in the same envelope. A sweep that finds everything already settled/claimed by other wallets is **not** a failure — it exits `0` (envelope `ok: true`) with `info` warnings (see §9).

---

## 7. SDK: typed error contract

Every error the SDK itself throws extends `OspexError` and carries a discriminable `code` field. Switch on `code` for routing; switch on `reason` (sub-class) for finer dispatch. (The CLI `--json` envelope adds one non-SDK fallback code, `UNKNOWN_ERROR`, for unclassified throws — see the Catalog.)

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
  OspexStreamError,
  OspexSignerResolutionError,
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
| `CONFIG_ERROR` | `OspexConfigError` | — | Missing signer / `rpcUrl` for a write. |
| `VALIDATION_ERROR` | `OspexValidationError` | `field` | Caller-supplied argument failed a shape / range / regex check. |
| `SIGNING_ERROR` | `OspexSigningError` | — | Keystore decrypt failed (wrong passphrase), EIP-712 sign failed. |
| `ALLOWANCE_INSUFFICIENT` | `OspexAllowanceError` | `required: bigint`, `current: bigint`, `spender`, `token` | Pre-flight allowance shortfall. SDK never auto-approves. |
| `CHAIN_ERROR` | `OspexChainError` | `reason?`, `revertReason?`, `txHash?`, `receiptStatus?`, `receiptBlockNumber?`, `causeChain?` | RPC error, revert, receipt status reverted. `txHash` is present whenever a tx was broadcast — a revert, a confirmed-but-post-parse-failed send, OR a receipt-wait timeout — so it is **not** by itself proof of a revert. `receiptStatus` (`'success'` \| `'reverted'`) is the discriminator: `'reverted'` = the tx reverted on-chain; `'success'` = the tx CONFIRMED but a post-send step (e.g. event parse) failed; **absent** = no receipt was observed (the broadcast landed a hash but the wait timed out / dropped — on-chain status UNKNOWN). `causeChain[]` (when present) surfaces the underlying viem / transport error with `name` / `status` / `shortMessage` so agents can classify rate-limit vs timeout vs underpriced without parsing the wrapper message. |
| `SCRIPT_APPROVAL_INVALID` | `OspexScriptApprovalError` | `reason: 'hash_mismatch' \| 'expired' \| 'not_configured'`, `expectedHash?`, `actualHash?` | Chainlink Functions ScriptApproval is unusable. |
| `SUBSCRIPTION_ERROR` | `OspexSubscriptionError` | `reason: 'link_balance_insufficient' \| 'consumer_not_registered' \| 'subscription_id_missing'`, `subscriptionId?` | Chainlink Functions subscription unusable. |
| `STREAM_ERROR` | `OspexStreamError` | `reason: 'connection_failed' \| 'capacity_exceeded' \| 'fatal'`, `status?`, `phase?: 'token-mint' \| 'token-refresh' \| 'connect' \| 'snapshot-page' \| 'decode' \| 'dispatch'` | An Ospex SSE stream failed (odds or a protocol `subscribe`). `reason` discriminates retry-vs-stop (`connection_failed` / `capacity_exceeded` retried; `fatal` ends the subscription). `phase` (v0.5.2+) is populated by `client.ownState.subscribe` so composite-health-gate consumers can latch on the failure phase without parsing messages; other resource streams leave it undefined. Delivered to `onError`. |
| `SIGNER_RESOLUTION_ERROR` | `OspexSignerResolutionError` | `reason`, `path?`, `expectedAddress?`, `actualAddress?`, `mode?` | Non-interactive Foundry-keystore signer resolution failed (missing path / file, wrong passphrase, address mismatch, conflicting flags, or — under `--strict` — loose password-file perms). See §4. |
| `UNKNOWN_ERROR` | — (CLI `--json` envelope fallback; **not** an `OspexError`) | `causeChain?` | The CLI caught a thrown value that was not an `OspexError` — a native `Error`, or a non-`Error` throw. The `--json` envelope's `errors[]` falls back to this code (with the sanitized `message`) so the structured-error contract holds even on an unexpected throw. Indicates an unanticipated failure, not a routed SDK error. |

### `OspexChainError.reason` enum

Stable strings:

- `'NotCommitmentMaker'` — caller is not the maker of the cancelled commitment.
- `'NonceMustIncrease'` — `raiseMinNonce` / `cancelAllOnSpeculation` called with `newMinNonce` ≤ current floor.

Other reverts surface with `reason` undefined and a free-form `revertReason` string when the SDK can decode it. New typed reasons are additive (forward-compatible).

### `OspexSignerResolutionError.reason` enum

Stable strings. Switch on this for fine dispatch in the non-interactive signing flow:

- `'keystore_not_found'` — the resolved keystore file doesn't exist on disk. `error.path` is the resolved path (so error renderers can say "looked at /home/agent/.foundry/keystores/maker-a").
- `'password_file_not_found'` — `--password-file` / `OSPEX_PASSWORD_FILE` / `config.passwordFile` points at a missing file. `error.path` is the resolved path.
- `'decryption_failed'` — the passphrase didn't decrypt the keystore. Most common cause is a typo in the `.pass` file.
- `'address_mismatch'` — the unlocked keystore's address differs from `--expected-address` or the config-pinned `expectedAddress`. `error.expectedAddress` and `error.actualAddress` carry the diff (both lowercased).
- `'non_interactive_password_required'` — a preview-only `--json` path or `auth check --sign-challenge` needs a non-interactive password source and none is configured.
- `'password_file_permissions_loose'` — emitted only under `--strict` (e.g. `auth check --strict` / `doctor --strict`). `error.mode` carries the POSIX mode bits; `error.path` is the file.
- `'account_and_path_conflict'` — both `--account` and `--keystore-path` were supplied for one resolve call. Caller bug.
- `'password_source_conflict'` — multiple passphrase sources were supplied to the SDK (e.g. `passwordFile` AND `fromStdin`). Caller bug.

New reason codes are additive (forward-compatible).

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
| `CHAIN_ERROR` with `txHash` + `receiptStatus: 'reverted'` | No — the tx landed and reverted on-chain (gas spent). Inspect on-chain; fix the cause before re-issuing. |
| `CHAIN_ERROR` with `txHash` + `receiptStatus: 'success'` | No — the tx CONFIRMED on-chain; only a post-send step (e.g. event parse) failed. The on-chain effect already happened — reconcile state, do **not** re-send. |
| `CHAIN_ERROR` with `txHash`, no `receiptStatus` | Not without polling first — the tx was broadcast but its receipt wasn't observed (wait timeout / transport drop) and it MAY still be mined. Poll the chain for `txHash` before any retry. |
| `CHAIN_ERROR` without `txHash` | Sometimes — see "Safe retry rule" below. |
| `SCRIPT_APPROVAL_INVALID` with `reason === 'expired'` | Wait for re-sign + redeploy of `ospex-core-api`. |
| `SUBSCRIPTION_ERROR` with `reason === 'link_balance_insufficient'` | Yes after funding the wallet with LINK. |
| `SIGNER_RESOLUTION_ERROR` (any `reason`) | No — fix the configuration. Surface to the operator rather than retrying. |
| `UNKNOWN_ERROR` | No automatic retry — an unexpected throw the SDK did not classify. Inspect `message` + `details.causeChain[]` and surface to the operator; do not blindly re-issue. |

The SDK does not retry for you. Build the retry loop in your agent.

### Safe retry rule for `CHAIN_ERROR` without `txHash`

A missing `txHash` means the SDK/CLI did **not** receive a transaction hash from the **broadcast** (`sendRawTransaction`) round-trip. As of the txHash/receipt-preservation fix, a receipt-wait timeout that happens AFTER a successful broadcast carries the `txHash` (the broadcast returned a hash; only the wait failed) — so a genuinely missing `txHash` now reliably means the broadcast call itself never returned one. It is still not proof that the raw transaction never reached a node or provider — a broadcast timeout / dropped-connection is genuinely ambiguous (the tx may have been accepted by a node before the response was lost). Treat `details.causeChain[0]` as a classifier, not as standalone retry permission; the predicate below is what actually decides.

With `details.causeChain[]` populated, agents can classify three sub-cases:

| Sub-case | Detected via | Retry safe? |
|---|---|---|
| Transport / rate-limit / gateway transient | `details.causeChain[0]` carries `name: 'HttpRequestError'`, `status: 429` / `>= 500`, or a timeout indicator (`name: 'TimeoutError'`, `code: 'ETIMEDOUT'`, etc.). | **Conditionally yes** — backoff and retry **only** when the safe-retry predicate below also holds. |
| Underpriced / replacement-underpriced | `details.causeChain[0].shortMessage` / `message` contains `'underpriced'`. The signer's pending nonce typically advances. | Sometimes — bump fees on retry; do not retry blindly. |
| Pre-send revert that didn't surface via `estimateGas` | No transport markers in `causeChain[0]`; the nested error looks like a viem revert decoder result. | No — fix the request. |

For write commands whose failure envelope reflects no side effect (`effects: []`), the agent-level safe-retry predicate is:

```
errors[0].code === 'CHAIN_ERROR'
  && errors[0].details?.txHash === undefined
  && effects.length === 0
  && envelope.signer !== null
  && the signer's (envelope.signer) pending nonce is unchanged since before the failed call
  && the target row's pre-write state has not advanced
     (e.g. contests.create — the game still has contestCreated === false)
```

If all conditions hold, ONE retry is safe. If a `txHash` exists OR the signer's pending nonce moved, do NOT retry without first polling the chain — the original tx may already be landing.

**If the failure envelope does not identify a signer (`envelope.signer === null`), the agent cannot perform the pending-nonce check and MUST NOT auto-retry.** Surface to the operator instead. Every write-command failure envelope carries `signer` (and `wallet`) for the broadcasting wallet — `signer: null` reliably means "this envelope is not a broadcast attempt" (e.g. a read scoped via `--maker`, or `claim-all --dry-run --address`), and those are never retry candidates here.

The pending-nonce check protects against the underpriced case: a tx that was accepted into the mempool but underpriced still moves the signer's pending nonce; a tx whose broadcast was dropped does not. **Use `envelope.signer`** (not the maker, not the taker, not the contest creator) — for `commitments match` the signer is the taker, for `contests create` the signer is the operator, for `claim` / `settle` the signer is the claimant / settler, etc. Routing by `envelope.signer` is the only nonce check that holds across all write commands. The "row state unchanged" check is the second line of defense — even if the signer / caller only-half-saw the broadcast succeed, the indexer-projected state catches up via the on-chain receipt.

This pattern was first surfaced during a live `contests create` smoke (see the `2026-05-28-mlb-col-lad-contest-27-d2-solvency-lifecycle` run artifact in `ospex-org/ospex-artifacts`): two bundled-CLI calls failed with opaque `CHAIN_ERROR` (no tx hash, signer's nonce unchanged); a direct SDK call ~52s later with the same signer / env succeeded. Until `details.causeChain[]` was added (see the `CHAIN_ERROR` row in §7 catalog), the failure shape carried no breadcrumb to distinguish "rate-limited" from "underpriced" from "request was malformed." With the cause chain populated, the same scenario today emits a structured `details.causeChain[0]` that lets the agent route via the table above.

---

## 8. SDK: trust boundaries

The SDK's threat model is "the host machine is honest, the user's wallet is sovereign." From that, the contract:

| Surface | Promise |
|---|---|
| Private keys (SDK) | The SDK never asks for a raw private key in its public `Signer` interface, never logs one, and never persists one. Signing is delegated to whichever `Signer` you supply (typed-data + raw-tx). |
| `KeystoreSigner` | `KeystoreSigner.unlock(json, passphrase)` decrypts a v3 keystore (Foundry- or ethers-produced) **once** and stores a `viem.PrivateKeyAccount` on the signer instance. Subsequent `signTypedData` / `signTransaction` calls reuse that account — they do **not** re-decrypt. The decrypted material lives for the lifetime of the `KeystoreSigner` instance, not "the duration of the call". `KeystoreSigner.fromPrivateKey(pk)` constructs from a raw key directly (no decrypt). |
| `KeystoreSigner.fromFoundryAccount` / `fromKeystoreFile` | Non-interactive helpers used by both the CLI and direct SDK consumers. They read the keystore file, read the passphrase from `passwordFile` / `fromStdin` / `passphrase` (literal) / `OSPEX_PASSWORD_FILE` env, decrypt in process memory, optionally verify `expectedAddress`, and return a `KeystoreSigner`. They never re-encrypt or copy the key; the decrypted material lives only inside the returned instance. The decryption never touches the session cache (`~/.ospex/session`). See §4 for the full surface. |
| **CLI session cache (`ospex wallet unlock`)** | Writes the **decrypted private key** to `~/.ospex/session` as plain JSON, mode `0600`, 15-minute TTL (parent dir mode `0700`). Mode `0600` makes the file unreadable by *other* users on the host but does NOT protect against any process running as the same user — those can read it for the duration of the unlock. The Foundry-keystore path with non-interactive credentials (flag / env / `auth use-foundry`-pinned `passwordFile`) avoids this trade-off entirely; the legacy session-cache path is kept for backwards compatibility but is not the recommended posture. New `wallet unlock` users should consider `ospex auth use-foundry --account <name> --password-file <path>` instead — same passphrase storage on disk (the `.pass` file), no decrypted key on disk. |
| RPC URL | **Caller-supplied.** No public-RPC default; `ospex init` prompts for one. The SDK uses the URL only as a viem `PublicClient` transport. |
| Live odds + protocol streams | Core-api Server-Sent Events over the configured API base URL — no separate credentials, no database access. The SDK opens the SSE endpoints directly and never holds a database key. |
| Chainlink Functions encrypted secrets | Fetched from a public alias (`secrets.ospex.org`) and passed verbatim into `OracleModule.createContestFromOracle`. The SDK never sees the plaintext. |
| API base URL | Defaults to `https://api.ospex.org`. Override at construction. |

The SDK has no module-level state. Multiple `OspexClient` instances are fully isolated — including per-instance nonce counters (see §10).

---

## 9. SDK: idempotency contracts

| Operation | Idempotent? | Notes |
|---|---|---|
| `commitments.submit` with **identical inputs** | Yes | Server-side dedup on `commitmentHash`. Same hash returned, no duplicate row. |
| `commitments.cancel(hash)` (off-chain DELETE) | Yes | Re-cancel on a cancelled row returns `200`. |
| `commitments.cancelOnchain({ hash } \| { signedCommitment })` / `commitments.cancelOnchainSigned(payload)` | Yes | The contract has **no `AlreadyCancelled` revert path** — the second `cancelCommitment` succeeds. Don't infer "first cancel" from tx success; check off-chain status if you need that signal. |
| `commitments.raiseMinNonce` / `cancelAllOnSpeculation` with `newMinNonce` ≤ current floor | No | Reverts `NonceMustIncrease`. Read the current floor with `commitments.getNonceFloor(...)` and pass `max(thatFloor, anyHigherNonceYouSigned) + 1` as the explicit `newMinNonce` — the SDK no longer auto-computes (anonymous reads cannot enumerate the maker's hidden book, so any default would be a fail-open guarantee). |
| `positions.claim(speculationId, type)` re-claim | No | Strict primitive — reverts `AlreadyClaimed`. Surface as `OspexChainError`. Use `ensurePositionClaimed` when you want idempotent "make this claimed" semantics instead. |
| `positions.settleSpeculation(speculationId)` re-settle | No | Strict primitive — reverts `AlreadySettled`. Surface as `OspexChainError`. Use `ensureSpeculationSettled` when you want idempotent "make this settled" semantics instead. |
| `positions.ensureSpeculationSettled(speculationId)` | Yes | Resolves to success whenever the speculation IS settled — `{ outcome: 'settled' \| 'alreadySettled' \| 'recovered' }`. Skips the tx on a pre-flight read showing it already closed; recovers from a concurrent settle that reverts mid-flight. The recovery decision is an authoritative on-chain re-read, so it's safe under core-API projection lag. `alreadySettled` sends no tx. `recovered` sends no tx **only** when recovery came via the pre-flight read or a pre-send (`estimateGas`) revert; if this wallet had already broadcast a settle that then reverted on inclusion (lost the race, spent gas), the result carries `revertedTxHash` **and `revertedReceipt`** (the reverted tx's receipt, re-fetched so consumers can account the POL gas it spent — gas budgets must include reverted txs), and `claim-all` emits a `status:'reverted'` settle effect. The confirmed-settle `txHash` is present only on `settled`. The `ospex settle <id>` CLI and `claim-all`'s settle leg both route through this (not the strict primitive). The `ospex settle` CLI additionally surfaces an additive structured `winSideContext` (Team Identity — team name + favorite/underdog role; [`AGENT_ENVELOPE_SPEC.md` §2.7](./AGENT_ENVELOPE_SPEC.md)), resolved best-effort and non-blocking (a metadata-fetch failure degrades the context + adds a warning, never fails the settle). Route on the bare `winSide`, never the context's `display`. |
| `positions.ensurePositionClaimed(speculationId, type)` | Yes | Resolves to success whenever the position IS claimed — `{ outcome: 'claimed' \| 'alreadyClaimed' \| 'recovered' }`. Skips the tx on a pre-flight read showing `claimed`; recovers from a benign already-claimed that reverts mid-flight (a concurrent caller, a rerun, `claimable`-projection lag). The recovery decision is an authoritative on-chain `getPosition.claimed` re-read, so it's safe under projection lag. **Payout is event-sourced and present ONLY on `claimed`** — the contract zeroes `riskAmount`/`profitAmount` once claimed, so `alreadyClaimed`/`recovered` carry NO payout (the SDK never derives one from a post-claim read). `recovered` carries `revertedTxHash` **and `revertedReceipt`** only when this wallet broadcast a claim that then reverted on inclusion (gas spent — account it). Only `AlreadyClaimed` is benign: `NotSettled` / `NoPayout` / RPC errors stay loud. The `ospex claim <id>` CLI and `claim-all`'s claim leg both route through this (not the strict primitive). The `ospex claim` CLI additionally surfaces an additive structured `positionSideContext` (Team Identity for the side the held `positionType` represents; [`AGENT_ENVELOPE_SPEC.md` §2.7](./AGENT_ENVELOPE_SPEC.md)), resolved best-effort and non-blocking (`null` + a warning if metadata can't be fetched, never fails the claim). Route on the bare `positionType`, never the context's `display`. |
| `positions.claimAll(...)` (live) | Yes (both legs) | Routes each row's settle leg through `ensureSpeculationSettled` and claim leg through `ensurePositionClaimed`. When multiple wallets sweep close together, at most one settle/claim tx lands per position; the rest skip/recover. Each entry carries an explicit `steps[]`; settle skips/recoveries surface as `settle-skipped-already-settled` / `projection-lag-recovered`, and claim skips/recoveries as `claim-skipped-already-claimed` / `claim-recovered-already-claimed` info warnings (not failures). An already-claimed entry counts as success with **no payout** — `totals.totalPayoutWei6` is fresh successful claims only, and `totals.{claimedFresh,alreadyClaimed,recoveredAlreadyClaimed}` (claim leg) plus `totals.{settledFresh,alreadySettled,recoveredAlreadySettled}` (settle leg — the multi-wallet-contended one, where peers race to settle the same speculation) break down the per-leg outcomes. A genuine `NotSettled`/`NoPayout`/RPC failure still fails that entry clearly. The CLI exits `0` when every entry succeeded, was skipped, or recovered (incl. a multi-wallet sweep where peers already did the work — `totals.failed === 0`, `ok: true`, with `info` warnings) and exits `1` when `totals.failed > 0` (`ok: false`). To classify each position without coordinating across wallets, read `totals.{claimedFresh,alreadyClaimed,recoveredAlreadyClaimed}` (claim leg) and `totals.{settledFresh,alreadySettled,recoveredAlreadySettled}` (settle leg) plus the per-entry `steps[].outcome` and `warnings[].code` (the four idempotent codes are cataloged in [`AGENT_ENVELOPE_SPEC.md` §2.4](./AGENT_ENVELOPE_SPEC.md)). Each entry's settle-resolved `winSide` (and the settle-leg warning `details`) also carries an additive structured `winSideContext` (Team Identity — see [`AGENT_ENVELOPE_SPEC.md` §2.7](./AGENT_ENVELOPE_SPEC.md)); claim-all reuses only entry data, so a team-bearing side is `status:'unavailable'` there (the human-readable team is in `description`) — single `settle`/`claim` resolve the full context. Route on the bare `winSide`, never on the context's `display`. |
| `commitments.approve` re-approval | Yes | Standard ERC-20 — repeated approve calls just overwrite. |

For long-running agents, the safe retry pattern after a transient failure is: re-fetch state via the API, then re-issue. Don't replay the original arguments blindly — block timing, allowance state, and nonce floor may have moved.

For postgame sweeps specifically, `claimAll` is the boring path: run it (or `--dry-run` first) and let it absorb projection lag. Multiple agents can claim concurrently without coordinating settle.

---

## 10. SDK: nonce semantics

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
2. **Clients across processes need coordination.** An external `nonceProvider` injection is planned but not yet implemented. Until then, agents distributing submits across hosts must serialize nonce assignment themselves — typically by routing all submits for a given `(maker, speculationKey)` through a single host.

`commitments.cancelAllOnSpeculation` (and the underlying `commitments.raiseMinNonce`) raises the on-chain nonce floor, which **invalidates every commitment with `nonce < newMinNonce`**. Use this carefully: it doesn't just cancel, it pre-emptively rejects all such commitments at match time on chain.

After the on-chain call returns, the SDK calls `nonceCounter.observe(maker, speculationKey, newMinNonce)` so the per-instance counter is bumped to at least `newMinNonce`. Subsequent submits in the same process pick a nonce strictly above the new floor without an extra `eth_call` to refresh from chain — but a *different* process / `OspexClient` instance will not see the bump until it reads the on-chain floor.

---

## 11. SDK: odds streaming contract (`client.odds.subscribe`)

`client.odds.subscribe({ contestId, market }, handlers)` opens a core-api Server-Sent Events stream for one `(contest, market)` and resolves to a `Subscription` (a single `unsubscribe(): Promise<void>`). Contest-id native — the upstream game is resolved server-side, so no upstream id is needed. The handler payload is the market-specific shape (`MoneylineOdds` / `SpreadOdds` / `TotalOdds`, keyed off `market`) — the same shape `client.odds.snapshot` returns. No realtime credentials to configure or bootstrap.

Handlers:

- `onSnapshot?(odds | null)` — the current baseline, delivered once the stream is live and again after every `degraded` recovery. `null` means live but the writer has no odds for this market yet.
- `onChange(odds)` — a real price move (a line / per-side American-odds column changed, or the upstream's own change timestamp advanced). The signal most consumers want.
- `onRefresh?(odds)` — a re-poll with no price change (liveness only); gated behind `--include-refreshes` in the CLI.
- `onStatus?(status)` — connection lifecycle: `connected` (live, baseline delivered), `reconnecting` (dropped, retrying with backoff), `degraded` (upstream source behind — updates paused until the next snapshot). Never `resync` (that's the protocol streams).
- `onError?(err)` — an `OspexStreamError`. `reason` discriminates retry (`connection_failed` / `capacity_exceeded` — the transport keeps reconnecting) from stop (`fatal`).

Promises:

- The transport reconnects on a drop with full-jitter backoff and re-emits a fresh `snapshot` on recovery. A stalled stream (no event or heartbeat within ~60s) is treated as a drop.
- Once you `unsubscribe()` — including from inside a handler — no further handler fires.

Non-promises:

- **No replay / no cursor.** Odds is latest-state. Events that arrived while disconnected are not replayed; treat each event as the current value and the post-reconnect `snapshot` as your baseline. For a point-in-time read use `client.odds.snapshot(contestId)`.
- **No ordering across markets.** Per-market ordering is reliable; cross-market is not (see §5).

The CLI's `ospex odds watch` opens one stream per market (all three) and is the canonical agent shape. For SDK use, subscribe per market.

---

## 12. What is NOT promised

Explicit non-guarantees, listed so you don't accidentally depend on them:

- **Human-readable CLI output.** The pretty preview blocks, table formatting, color codes, ordering of fields, and exact wording of every stderr line are subject to change without notice. Use `--json`.
- **Exact `error.message` text.** The structured `code`, `reason`, and other typed fields are stable; the human message that accompanies them is not.
- **stderr log lines.** Anything written to stderr is informational. Don't grep it.
- **`dist/` file paths.** Importing from `@ospex/sdk/dist/...` directly is unsupported. Import from the package barrel (`@ospex/sdk`) or the documented subpath (`@ospex/sdk/signers/keystore`).
- **Field order in JSON envelopes.** Treat the envelope as an unordered object (which it is, per JSON spec).
- **Network behavior.** Block timing, RPC latency, gas prices, and Chainlink callback latency are external. The SDK does not promise any specific timing — bake your own SLOs around the calls.
- **Indexer projection latency.** A successful on-chain write does not mean the corresponding API row is visible *yet*. Poll the API row's status (or wait ~30s for a typical projection) before downstream actions that depend on the row.
- **Order-book completeness in streams.** A stream delivers *deltas* (odds, or protocol rows via the `subscribe` methods), not a guaranteed-complete point-in-time book. For a full orderbook snapshot, re-list via `commitments.list` / `speculations.get`.

---

## 13. Versioning + migration

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
"@ospex/cli": "file:./vendor/ospex-cli-0.2.0.tgz"
```

Re-vendor when you choose to upgrade — there is no auto-update story for tarballs.

---

## 14. Where to look when something doesn't match this doc

If you observe a runtime difference between this contract and the SDK:

1. **The contract is the source of truth for promises**, but the code is the source of truth for behavior. If they conflict, treat the contract as the bug — open an issue with a minimal repro.
2. The authoritative source files for shapes:
   - Envelope wrapper + shoulder types: [`packages/sdk/src/types/agentEnvelope.ts`](../packages/sdk/src/types/agentEnvelope.ts)
   - Envelope field-by-field rules + per-command matrix: [`AGENT_ENVELOPE_SPEC.md`](./AGENT_ENVELOPE_SPEC.md)
   - Error codes: [`packages/sdk/src/errors.ts`](../packages/sdk/src/errors.ts)
   - Submit payload: [`packages/sdk/src/types/preview.ts`](../packages/sdk/src/types/preview.ts)
   - Match payload: [`packages/sdk/src/types/matchPreview.ts`](../packages/sdk/src/types/matchPreview.ts)
   - Odds wire shapes (watch + show): [`packages/sdk/src/types/odds.ts`](../packages/sdk/src/types/odds.ts)
   - Public types barrel: [`packages/sdk/src/types/index.ts`](../packages/sdk/src/types/index.ts)
   - `auth check` payload + resolution walker: [`packages/cli/src/commands/auth/check.ts`](../packages/cli/src/commands/auth/check.ts)
   - Non-interactive signer helpers + reason codes: [`packages/sdk/src/signers/foundry.ts`](../packages/sdk/src/signers/foundry.ts) and [`packages/sdk/src/signers/keystore.ts`](../packages/sdk/src/signers/keystore.ts)
3. The integration playbook (which exercises every promise here against the live testnet) is [`MANUAL_INTEGRATION_TESTING.md`](./MANUAL_INTEGRATION_TESTING.md).

---

## Quick reference

```
schemaVersion === 2                    Locked envelope contract (AgentEnvelope<TPayload>)
field-by-field envelope rules          See docs/AGENT_ENVELOPE_SPEC.md
--json alone (preview-bearing cmds)    Preview only, no signing/tx (submit, match, approvals setup)
--json (other write cmds)              Output format only — may still send a tx (cancel, claim, settle, …)
--yes --json                           Execute and emit (preview-bearing cmds)
--yes for non-TTY                      Required only for preview-bearing commands (see §3)
--json on stdout                       Always parseable; logs/prompts go to stderr
NDJSON for `odds watch`                One JSON object per line, numbers (not strings) for line/odds, SIGINT clean exit
single envelope for `odds show`        AgentEnvelope<OddsShowEnvelope>; NOT NDJSON
non-interactive signing                --account + --password-file (or auth use-foundry pin); see §4
auth check                             Diagnostic that mirrors loadSigner's resolution ladder; emits AgentEnvelope<AuthCheckPayload>
err.code                               Switch on this for routing
err.reason                             Switch on this for fine dispatch (chain/script-approval/subscription/signer-resolution)
schemaVersion: 3                       Will signal the next breaking envelope change (not before v1.0.0)
```
