# Agent envelope specification — `schemaVersion: 2`

Authoritative specification for the `AgentEnvelope<TPayload>` wrapper emitted by every Class A `--json` invocation in `@ospex/cli` and consumed by integrators of `@ospex/sdk`. Field-by-field rules, per-stage shape obligations, per-command population matrix, failure envelope contract, and the JSON cleanliness acceptance criteria.

> **Audience.** Authors of programmatic Ospex consumers — market-maker bots, settlement watchdogs, monitoring stacks, downstream LLM tools — who need to read the envelope without learning each command's bespoke output shape. For the broader integration contract (signing, error catalog, idempotency, trust boundary, streaming, versioning) see [`AGENT_CONTRACT.md`](./AGENT_CONTRACT.md).

The contract is **load-bearing**. Once an agent depends on a field documented here, breaking it is treated as an emergency. Anything not specified here is implementation detail and may change without notice.

Additive changes inside `schemaVersion: 2` (new optional fields, new enum values) are explicitly allowed without a schema bump. Consumers **must** treat unknown fields and unknown enum values as forward-compatible — log + ignore, never crash.

---

## 1. The wrapper

Every Class A command's `--json` output is a single object matching this shape:

```ts
interface AgentEnvelope<TPayload> {
  schemaVersion: 2;

  // Status
  ok: boolean;
  action: string;                                       // e.g. 'commitments.submit'
  stage: 'read' | 'preview' | 'execute' | 'dry-run';

  // Network + provenance
  network: 'polygon' | 'amoy';
  chainId: number;
  generatedAt: string;                                  // ISO-8601 UTC
  cliVersion: string;                                   // @ospex/cli package.json version
  sdkVersion: string;                                   // @ospex/sdk package.json version

  // Wallet context
  wallet: `0x${string}` | null;
  walletRole: 'signer' | 'subject' | 'filter' | 'none';
  signer: `0x${string}` | null;

  // Action preflight (preview-bearing stages and execute stages)
  requiresSignature: boolean;
  requiresTransaction: boolean;
  approvalRequirements: ApprovalRequirement[];          // empty when none

  // Economics + identity (populated when a single clear context applies)
  estimatedCosts: EstimatedCosts | null;
  risk: PerspectiveAmount | null;
  payout: AgentPayout | null;
  contest: PreviewContest | null;
  speculation: SpeculationMode | null;
  commitment: Commitment | null;
  sideSummary: string | null;

  // Outcomes + structured signals
  warnings: AgentWarning[];
  errors: AgentError[];
  effects: AgentEffect[];                               // post-execute: what happened
  nextCommands: AgentNextCommand[];                     // capped at 3

  // Command-specific data — type varies per command
  payload: TPayload;
}
```

The top-level field order in the TypeScript declaration is by section; JSON consumers must not depend on field order (it is not part of the contract).

The `wallet` / `walletRole` / `signer` split intentionally avoids the "can I sign for this?" ambiguity that single-field designs collapse:

- `walletRole === 'signer'` — the invocation is asking that wallet to sign.
- `walletRole === 'subject'` — the invocation is *querying* the wallet's data without asking it to sign.
- `walletRole === 'filter'` — the wallet was supplied as a list-filter predicate (`--maker`).
- `walletRole === 'none'` — no wallet context at all (e.g. `contests list`).

The distinction prevents an agent from assuming it can sign for an address it is merely inspecting.

Authoritative type source: [`packages/sdk/src/types/agentEnvelope.ts`](../packages/sdk/src/types/agentEnvelope.ts).

---

## 2. Shoulder-field types

### 2.1 `ApprovalRequirement`

```ts
interface ApprovalRequirement {
  token: `0x${string}`;
  tokenSymbol: 'USDC';                  // USDC is the only Ospex approval token (R5/CRE)
  spender: `0x${string}`;
  spenderLabel: 'PositionModule' | 'TreasuryModule';
  purpose: ApprovalPurpose;
  requiredWei: string;                  // decimal string (bigint-safe)
  requiredHuman: string;                // formatted with token's native decimals
  currentWei: string;
  currentHuman: string;
  needsApproval: boolean;
}

type ApprovalPurpose =
  | 'commitment-risk'                   // USDC → PositionModule
  | 'lazy-creation-fee'                 // USDC → TreasuryModule (lazy match)
  | 'contest-creation-usdc';            // USDC → TreasuryModule (contest create)
```

`spenderLabel` is mandatory — agents and humans should never need their own module address book to interpret an approval row.

### 2.2 `EstimatedCosts`

```ts
interface EstimatedCosts {
  // Gas: always null today. A future `--estimate-gas` opt-in (see §8) will
  // populate this block; it adds an RPC roundtrip and may surface revert
  // reasons earlier than execution.
  gas: {
    nativeToken: 'POL';                   // Polygon's native asset
    estimatedWei: string;                 // decimal string
    estimatedPOL: string;                 // formatted, 18dp
    source: 'rpc-estimateGas';
  } | null;

  // Deterministic protocol fees (included by default when applicable)
  usdcFees: Array<{
    purpose: 'lazy-creation-fee' | 'contest-creation-fee';
    amountWei6: string;                   // 6dp USDC, decimal string
    amountUSDC: string;                   // formatted, 6 fractional digits
    conditional: boolean;                 // true for lazy-creation (race condition)
    note?: string;                        // optional human one-liner
  }>;
}
```

There is no `gasUSDC` field. Polygon gas is paid in POL; quoting it in USDC requires a price-oracle source the SDK does not currently maintain.

### 2.3 `AgentPayout`

```ts
interface AgentPayout {
  profit: PerspectiveAmount;             // { wei6, usdc }
  totalReturn: PerspectiveAmount;        // risk + profit
}
```

`PerspectiveAmount` is reused from `@ospex/sdk/types/preview` unchanged.

### 2.4 `AgentWarning` / `AgentError`

```ts
type WarningSeverity = 'info' | 'warning' | 'blocking';

type BlockingCapability =
  | 'submit'
  | 'match'
  | 'cancel-onchain'
  | 'claim'
  | 'settle'
  | 'contest-create'
  | 'contest-score'
  | 'market-maker';                      // generic operator-mode block

interface AgentWarning {
  code: string;                          // stable token; switch on this
  message: string;                       // human copy; may drift
  severity: WarningSeverity;
  blockingFor?: BlockingCapability[];    // operations this would block
  details?: unknown;
}

interface AgentError {
  code: string;                          // 'ALLOWANCE_INSUFFICIENT', etc.
  message: string;
  details?: unknown;
}

interface AgentErrorCauseEntry {
  name?: string;                         // constructor name, e.g. 'HttpRequestError'
  code?: string;                         // typed code if present
  message?: string;                      // sanitized
  shortMessage?: string;                 // viem's one-line summary, sanitized
  metaMessages?: readonly string[];      // viem's chain-of-explanation, sanitized
  status?: number;                       // HTTP status when applicable
  reason?: string;                       // nested OspexChainError reason
  revertReason?: string;                 // nested OspexChainError revert reason
  txHash?: string;                       // when the nested cause was tx-bound
}
```

When the thrown error carries an ES2022 `Error.cause`, the CLI walks the chain into `details.causeChain[]` of type `AgentErrorCauseEntry[]`. The list is ordered from immediate cause outward, capped at depth 4, and cycle-safe. String fields are sanitized — embedded RPC URLs and known credential-name pairs (`api_key`, `authorization: Bearer …`, `token=`, `password`, `passphrase`, `postgres://…`) are masked to `[redacted]` before they reach stdout. This is the only path that surfaces underlying viem / transport / API errors in `--json` mode — without it, a wrapped `OspexChainError("Transaction broadcast or inclusion failed.", { cause })` lands as opaque text with no breadcrumb back to "rate-limited" / "timeout" / "underpriced". Agents classify by `causeChain[0].name` + `code` + `status` (e.g. `name === 'HttpRequestError'` + `status === 429` → rate limit).

Initial stable `warning.code` catalog (additive — consumers log + ignore unknown):

| Code | Severity | Lifted from |
|---|---|---|
| `'self-match'` | `warning` | `MatchPreview.warnings` |
| `'expires-soon'` | `warning` | `MatchPreview.warnings` |
| `'expired'` | `blocking` | `MatchPreview.warnings` |
| `'partial-fill'` | `info` | `MatchPreview.warnings` |
| `'nonce-invalidated'` | `blocking` | `MatchPreview.warnings` |
| `'maker-treasury-allowance-insufficient'` | `blocking` | `MatchPreview.warnings` |
| `'expiry-after-match-time'` | `warning` | `SubmitPreview.expiry.afterMatchTime` |
| `'allowance-short'` | `blocking` | derived from any `approvalRequirements[].needsApproval` |
| `'nonce-floor-stale'` | `warning` | `nonce-floor` read when chain > supabase |
| `'password-file-permissions-loose'` | `warning` (`blocking` under `--strict`) | `auth check` |
| `'settle-skipped-already-settled'` | `info` | `claim-all` / `settle` — a pre-flight read found the speculation already settled, so the duplicate settle tx was skipped. `details: { speculationId, winSide, winSideContext, … }` (the structured Team Identity context — §2.7). |
| `'projection-lag-recovered'` | `info` | `claim-all` / `settle` — a concurrent settle won a race mid-flight, an on-chain re-read confirmed it, and the command proceeded (claim-all → claim; settle → done). `details: { speculationId, winSide, winSideContext, … }` (the structured Team Identity context — §2.7). |
| `'claim-skipped-already-claimed'` | `info` | `claim-all` / `claim` — a pre-flight `getPosition.claimed` read found the position already claimed, so the duplicate claim tx was skipped. **No payout** (the contract zeroes economic fields post-claim; never fabricated). `details: { speculationId, positionType / positionId, … }` (`claim` adds `positionSideContext`; `claim-all` adds `winSideContext` — §2.7). |
| `'claim-recovered-already-claimed'` | `info` | `claim-all` / `claim` — a benign already-claimed (concurrent caller, rerun, `claimable`-projection lag) won a race mid-flight; an on-chain re-read confirmed it and the command proceeded. **No payout.** A reverted-on-inclusion claim this wallet broadcast also emits a `status:'reverted'` `claim-position` effect (gas spent). `details: { speculationId, positionType / positionId, … }` (`claim` adds `positionSideContext`; `claim-all` adds `winSideContext` — §2.7). |

`errors[]` uses the existing `OspexError.code` taxonomy (`'API_ERROR'`, `'ALLOWANCE_INSUFFICIENT'`, `'CHAIN_ERROR'`, etc. — see [`AGENT_CONTRACT.md` §7](./AGENT_CONTRACT.md)). New codes are additive.

### 2.5 `AgentEffect`

Unified record for every observable side-effect of a command. Empty on read / preview / dry-run envelopes; populated on execute envelopes.

```ts
type EffectType =
  | 'eip712-signature'                   // commitment signing, off-chain cancel auth
  | 'offchain-write'                     // off-chain DELETE / POST to core-api
  | 'transaction'                        // on-chain tx
  | 'contract-call';                     // synchronous read against chain (rare)

interface AgentEffect {
  type: EffectType;
  purpose: string;                       // e.g. 'submit-commitment', 'onchain-cancel', 'approve-usdc'
  ok: boolean;                           // did this effect complete successfully?
  txHash?: `0x${string}`;                // present when type === 'transaction'
  blockNumber?: string;                  // decimal bigint
  status?: 'submitted' | 'confirmed' | 'reverted';
  errorCode?: string;                    // when ok === false
}
```

There is **no** separate `transactions[]` field — consumers filter `effects` by `type === 'transaction'`.

Per-effect `ok` lets multi-phase commands surface partial success cleanly. Example: `cancel --also-onchain` where the off-chain DELETE landed but the on-chain tx **reverted on inclusion** — the `transaction` effect carries the `txHash` + `status: 'reverted'`, and `errors[0].details` carries the structured discriminators (`txHash` / `receiptStatus` / `causeChain`):

```jsonc
{
  "ok": false,
  "action": "commitments.cancel",
  "stage": "execute",
  "effects": [
    { "type": "offchain-write", "purpose": "offchain-cancel", "ok": true },
    { "type": "transaction", "purpose": "onchain-cancel", "ok": false, "txHash": "0x…", "blockNumber": "64200001", "status": "reverted", "errorCode": "CHAIN_ERROR" }
  ],
  "errors": [{ "code": "CHAIN_ERROR", "message": "Transaction reverted on-chain.", "details": { "txHash": "0x…", "receiptStatus": "reverted", "receiptBlockNumber": "64200001" } }]
}
```

`details.causeChain` is **not** present on a clean inclusion revert (the SDK attaches no `cause` to a reverted-receipt error). It appears when the underlying failure carried a cause — e.g. a pre-send RPC/transport error, or a decoded custom-error revert (`NotCommitmentMaker` / `NonceMustIncrease`), whose viem error is preserved on `cause` and walked into `causeChain[]`.

The on-chain leg has three envelope shapes — the `transaction` effect's `status` and `txHash` presence classify them; combined with the [`AGENT_CONTRACT.md` §7](./AGENT_CONTRACT.md) safe-retry rule, agents avoid blind-retrying a tx that may have already moved funds:

| On-chain leg outcome | effect `status` | effect `txHash` | Notes |
|---|---|---|---|
| Reverted on inclusion | `reverted` | present | tx mined + reverted (gas spent). `errors[].details.receiptStatus: 'reverted'`. |
| Broadcast, receipt-wait timed out | `submitted` | present | tx MAY still be mined — on-chain status UNKNOWN. No `receiptStatus`. Poll `txHash` before retrying. |
| No tx hash observed — a local preflight / `estimateGas`-decoded revert (e.g. `NotCommitmentMaker`) / signing error, **or** a `sendRawTransaction` broadcast round-trip that errored | omitted | omitted | **An absent hash is NOT proof a tx was never sent.** A local preflight / `estimateGas`-local failure genuinely broadcast nothing, but a failed broadcast round-trip is ambiguous — the raw tx may have reached a node before the response was lost (and could still land / revert). Do **not** blind-retry: apply the [`AGENT_CONTRACT.md` §7](./AGENT_CONTRACT.md) safe-retry rule (cause-chain classifier + signer pending-nonce + target-state) first. |

Top-level `ok` tracks the requested **domain outcome** — true when the command achieved what was asked. Exit code follows.

`ok` is NOT a simple "every effect succeeded" roll-up. An idempotent "ensure" command (`settle`, `claim`, `claim-all`) can legitimately report `ok: true` alongside a **failed/reverted effect** when the goal was reached anyway: e.g. a duplicate settle/claim this wallet broadcast lost a race and reverted on-chain (gas spent → surfaced as an `ok:false, status:'reverted'` effect), but a concurrent tx already achieved the target state. Such a recovery carries an `info`-severity warning (`projection-lag-recovered` / `claim-recovered-already-claimed`) explaining it. Conversely, an effect's `status:'confirmed'` does not force `ok:true` at the effect level — a claim tx that confirmed on-chain but whose result the SDK couldn't parse is a `ok:false, status:'confirmed'` effect (the tx landed; the operation didn't complete). Agents should read per-effect `ok`/`status` for on-chain truth and top-level `ok` for "did the command achieve its goal."

### 2.6 `AgentNextCommand`

```ts
type NextCommandIntent = 'verify' | 'complete' | 'remediate';

interface AgentNextCommand {
  id: string;                            // stable, e.g. 'verify-commitment', 'approve-commitment-risk'
  description: string;                   // human-readable one-liner
  suggestedFor: NextCommandIntent;
  command: string;                       // copy-pasteable shell line
  argv: string[];                        // argv-array form, agent-safe execution
  safeToAutoRun: boolean;                // true only for read-only verifies
}
```

Hard rules — codified in `packages/cli/src/lib/nextCommands.ts`:

- At most three suggestions per envelope. Ordered: `verify` → `complete` → `remediate`.
- Only local follow-ups. No strategic suggestions ("make another market", "take this quote", "raise odds"). Strategic suggestions have no registered `id`.
- `safeToAutoRun: true` only when the suggested command's `stage === 'read'`. All writes are `false` even when they look obviously correct.
- The registry is a typed map `id → AgentNextCommandTemplate`. Tests assert every registered template's `argv` parses cleanly through the CLI's commander chain, so suggestions never drift out of sync with the actual flag surface.

Examples:

```jsonc
// After successful `commitments submit --yes --json`
{
  "id": "verify-commitment",
  "description": "Verify the submitted commitment",
  "suggestedFor": "verify",
  "command": "ospex commitments show 0xabc...",
  "argv": ["commitments", "show", "0xabc...", "--json"],
  "safeToAutoRun": true
}

// After a preview returns `allowance-short`
{
  "id": "approve-commitment-risk",
  "description": "Approve USDC risk allowance for PositionModule",
  "suggestedFor": "remediate",
  "command": "ospex commitments approve 25 --yes --json",
  "argv": ["commitments", "approve", "25", "--yes", "--json"],
  "safeToAutoRun": false
}

// After `claim-all --dry-run` (re-run the sweep for real; the address is the
// swept wallet from the dry-run). claim-all has no `--yes` flag — it never
// prompts, so `--json` alone executes.
{
  "id": "complete-claim-all",
  "description": "Execute the planned claim sweep.",
  "suggestedFor": "complete",
  "command": "ospex claim-all --address 0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd --json",
  "argv": ["claim-all", "--address", "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", "--json"],
  "safeToAutoRun": false
}
```

---

### 2.7 `SideContext` (`winSideContext` / `positionSideContext`)

**Additive Team Identity context** for the position-lifecycle commands. The protocol surfaces a bare side enum — `winSide` (`away|home|over|under|push|void|tbd`) on `settle` / `claim-all` settle outcomes, and `positionType` (`0|1`) on `claim` — which names a side without the actual team or its favorite/underdog role. `SideContext` travels **next to** that bare field (the field at `…Context` is suffixed onto the existing key: `winSideContext` where the bare field is `winSide`, `positionSideContext` where it is `positionType`). It is **additive and never replaces the bare field** — agents MUST route on the bare `winSide` / `positionType`; `display` is human-facing only.

```ts
interface SideContext {
  side: 'away' | 'home' | 'over' | 'under' | 'push' | 'void' | 'tbd';
  marketType: 'moneyline' | 'spread' | 'total' | null;
  team: { name: string; alignment: 'away' | 'home' } | null;   // null for totals / push / void / tbd, or when unresolved
  role: 'favorite' | 'underdog' | 'even' | 'unknown' | 'not_applicable';
  display: string;                                              // human-facing, e.g. "away (New York Yankees, favorite)"
  status: 'complete' | 'partial' | 'unavailable' | 'not_applicable';
  source: {
    team: 'speculation-detail' | 'claim-params-description' | 'unavailable' | 'not_applicable';
    role: 'moneyline-odds' | 'spread-line' | 'spread-odds' | 'unavailable' | 'not_applicable';
  };
}
```

Rules:

- **Never fabricated.** A team name / role that can't be resolved degrades honestly (`team: null`, `role: 'unknown'`, `status: 'unavailable'|'partial'`, `source.*: 'unavailable'`) — it is never invented.
- **Role derivation.** `moneyline` → American-odds sign (more-negative = favorite); `spread` → line sign (negative = favorite, positive = underdog, zero = even), falling back to spread American odds; `total` and `push`/`void`/`tbd` → `not_applicable`; missing inputs → `unknown`.
- **`status`.** `complete` (team + role resolved) · `partial` (team resolved, role `unknown`) · `unavailable` (team unresolved) · `not_applicable` (totals / no-winner sides).
- **Enrichment is non-blocking.** The settle/claim transaction resolves first; enrichment is post-hoc display metadata. If a metadata fetch fails the command still emits its normal envelope (and exit code) for the underlying operation — the context degrades (`status: 'unavailable'`, or a `null` context on `claim`) and a warning is added; it NEVER blocks or fails a valid transaction.
- **Degradation warnings.** When enrichment can't fully resolve, a `warning`-severity warning is appended next to the outcome warnings: `side-context-unavailable` (team couldn't be resolved → `status: 'unavailable'`, or a `null` `positionSideContext` on `claim`) or `side-role-unavailable` (team resolved but favorite/underdog couldn't be derived → `status: 'partial'`).
- **Availability.** Emitted by **`claim-all`**, **`settle`**, and **`claim`**:
  - **`claim-all`** — `winSideContext` on each entry payload + the settle-leg warning `details` (`settle-skipped-already-settled` / `projection-lag-recovered`, §2.4), next to the bare `winSide`. It reuses only per-entry data (no per-entry fetch), so a team-bearing side is `status: 'unavailable'` there (the human-readable team is in the entry `description`).
  - **`settle`** — `winSideContext` on the payload + the settle-leg warning `details`, resolved from `speculations.get` (team + market + spread line) and, only when a role needs odds (moneyline always; a spread with no line), `odds.snapshot`.
  - **`claim`** — `positionSideContext` (the side the held `positionType` represents, derived from `positionType` + market) on the payload + the claim-leg warning `details`. `null` when the speculation fetch fails (the held side can't be derived without the market).

---

## 3. Field-population rules

### 3.1 Per-stage rules

| Stage | `requiresSignature` | `requiresTransaction` | `approvalRequirements` | `effects` | `payload` |
|---|---|---|---|---|---|
| `read` | always `false` | always `false` | always `[]` | always `[]` | the read result |
| `preview` | `true` if execution would sign | `true` if execution would dispatch a tx | populated from the preflight | always `[]` | the bespoke preview model (e.g. `SubmitPreview`) |
| `execute` | `false` (already signed) | `false` (already sent) | `[]` (consumed during execution) | populated per effect | result-bearing payload; varies per command. Dual-mode preview-bearing commands (`commitments submit`, `commitments match`) emit `{ preview, result, <preflight verdict>, preflight<Verdict>?, approvalRemediation? }` — submit adds `fundability`, match adds `fillability` (the **effective** send-time advisory preflight verdict — post-approval re-check when the auto-approve loop confirmed, always present, `null` when skipped). When the loop confirmed at least one tx, `preflight<Verdict>` preserves the pre-approval verdict and `approvalRemediation` lists which reason codes the loop resolved and which `ApprovalPurpose` rows confirmed — so agents can audit what got executed against the preview they accepted. `approvals setup --yes` emits `{ plan, results }`. Fire-and-forget writes (`claim`, `settle`, `cancel*`, `contests {create, score}`) emit bare command-specific result models. See per-command shapes in §5. |
| `dry-run` | `true` (would sign if executed) | `true` (would send) | populated | always `[]` | plan model (e.g. `ClaimAllPlan`) |

### 3.2 `wallet` / `walletRole` / `signer`

| Command shape | `wallet` | `walletRole` | `signer` |
|---|---|---|---|
| Signing write (e.g. `commitments submit --yes`) | signer address | `'signer'` | same as `wallet` |
| Preview-only sign (e.g. `commitments submit --json` without `--yes`) | resolved-without-unlock address (or `null`) | `'signer'` | same as `wallet` (or `null`) |
| Read scoped to a wallet via `--address` flag | the flag value | `'subject'` | `null` |
| Read scoped to the implicit signer's address | the signer address | `'subject'` | the signer address |
| Read with a `--maker` filter (e.g. `commitments list --maker`) | the filter value | `'filter'` | `null` |
| Read with no wallet context (e.g. `contests list`) | `null` | `'none'` | `null` |
| `wallet address` | the resolved keystore address | `'subject'` | same as `wallet` |

### 3.3 `risk` / `payout`

- Single-action previews (`submit`, `match`): pull from `preview.you.risk` and `preview.you.profit/totalReturn`.
- Single-position commands (`positions claim`, `commitments show`): pull from the single position / commitment.
- List commands with a wallet context (`positions status`): use totals; per-row stays inside `payload`.
- List commands without a wallet context: `null`.
- Action commands without risk/payout semantics (`approve`, `settle`, `cancel`, `contests create`): `null`.

### 3.4 `contest` / `speculation` / `commitment`

- Single clear context → populate the top-level field.
- Multi-object list → top-level `null`; rows carry IDs/details inside `payload`.
- Detail-fetch commands (`contests show <id>`, `speculations show <id>`, `commitments show <hash>`) still populate the top-level summary even though the full object is also in `payload`. Generic agents render context from the shoulder block without inspecting the payload shape.
- `commitment` is the discriminated union `PublicVisibleCommitment | PublicHiddenCommitment` (see AGENT_CONTRACT.md §1.5). Both variants carry the `visibility` / `redacted` discriminants; a hidden body carries only the allow-list fields (`commitmentHash`, `maker`, `contestId`, `positionType`, `status`, `storedStatus`, `filledRiskAmount`, `expiry`, `bookVisible: false`, `nonceInvalidated`). Agents narrow on `redacted` before reading matchable fields (`signature`, `nonce`, `oddsTick`, `riskAmount`, `scorer`, `lineTicks`, `marketType`, `speculationKey`) — those keys are absent on a hidden body. Preview-bearing write commands (`commitments submit --yes`, `commitments match --yes`) only ever carry a visible commitment because the preview itself refuses redacted input upstream.

### 3.5 `sideSummary`

Display helper only. Never load-bearing. Canonical sided data stays under `payload`.

---

## 4. Class A command list

Commands listed below adopt the wrapper. Anything not listed either does not have a `--json` mode or is deliberately excluded (see §4.4).

### 4.1 Reads

`health`, `doctor`, `auth check`, `approvals show`, `wallet address`, `commitments list`, `commitments show`, `commitments fillability`, `commitments nonce-floor`, `contests list`, `contests show`, `contests scripts`, `contests wait-verified`, `games list`, `leaderboard show`, `odds show`, `positions list`, `positions status`, `positions history`, `speculations list`, `speculations show`.

### 4.2 Preview-bearing writes

`commitments submit`, `commitments match`, `commitments approve`, `commitments approve-raw`, `approvals setup`.

`commitments approve` is execute-only (`--yes` required). The submit/match preview already exposes `approvalRequirements[]`; a separate preview mode for `approve` would be redundant.

### 4.3 Fire-and-forget writes

`commitments cancel`, `commitments cancel-onchain`, `commitments cancel-all`, `claim`, `claim-all`, `settle`, `contests create`, `contests score`, `contests update-markets`.

### 4.4 Not in scope (intentionally)

- `odds watch` — NDJSON stream with its own per-line contract (the `{ kind, market, odds }` / `{ kind: 'status', … }` shape; see [`AGENT_CONTRACT.md` §5.1](./AGENT_CONTRACT.md)). Wrapping every line in the v2 envelope would balloon the stream pointlessly.
- `own-state watch` — NDJSON stream with its own per-line contract (`{ kind: 'snapshot' | 'ready' | 'commitment' | 'fill' | 'positionStatus' | 'status' | 'heartbeat' | 'error' | 'summary', … }`; see [`AGENT_CONTRACT.md` §5.2](./AGENT_CONTRACT.md)). Same NDJSON carve-out rationale as `odds watch`. Owner-commitment lines are signature-redacted by default so the stream is safe to capture into a public artifact.
- `init`, `wallet import`, `wallet unlock`, `wallet lock` — one-shot human config commands with no `--json` mode.
- `auth use-foundry`, `auth clear-foundry` — one-shot config commands; their `schemaVersion: 1` envelope is preserved (agents do not run them in a loop).

---

## 5. Per-command matrix

Legend: `✓` populated · `∅` `null` / `[]` (does not apply) · `+` populated only in the noted condition.

### 5.1 Preview-bearing writes

| Command (with `--json`) | stage | wallet/role/signer | reqSig | reqTx | approvalRequirements | risk | payout | contest | speculation | commitment | sideSummary | warnings | effects | nextCommands |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `commitments submit` (no `--yes`) | preview | signer (resolved-no-unlock or null) | true | false | ✓ | ✓ | ✓ | ✓ | ✓ | ∅ (not signed yet) | ✓ | ✓ | ∅ | ✓ (verify/remediate) |
| `commitments submit --yes` | execute | signer | false | false | ∅ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (eip712-signature + offchain-write) | ✓ (verify) |
| `commitments match` (no `--yes`) | preview | signer (resolved-no-unlock or null) | true | true | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (the maker commitment) | ✓ | ✓ | ∅ | ✓ |
| `commitments match --yes` | execute | signer | false | false | ∅ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (transaction) | ✓ |
| `commitments approve --yes` | execute | signer | false | false | ∅ (consumed) | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ✓ (transaction) | ✓ (verify allowance via `approvals show`) |
| `commitments approve-raw --yes` | execute | signer | false | false | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ✓ | ✓ |
| `approvals setup` (no `--yes`) | preview | signer | true[^1] | true[^1] | ✓ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ∅ | ✓ |
| `approvals setup --yes` | execute | signer | false | false | ∅ (consumed) | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ✓ (one tx per approval) | ✓ |

### 5.2 Fire-and-forget writes

| Command | stage | wallet/role/signer | reqSig | reqTx | approvalRequirements | risk | payout | contest | speculation | commitment | sideSummary | warnings | effects | nextCommands |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `commitments cancel <hash>` | execute | signer | false | false (off-chain DELETE; auth via signature) | ∅ | ✓ (from commitment) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (eip712-signature + offchain-write) | ✓ (suggest `--also-onchain` if pending invalidation) |
| `commitments cancel <hash> --also-onchain` | execute | signer | false | false | ∅ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (both phases) | ✓ |
| `commitments cancel-onchain <hash>` | execute | signer | false | false | ∅ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (transaction) | ✓ |
| `commitments cancel-all` | execute | signer | false | false | ∅ | ∅ | ∅ | ✓ (parent contest) | ✓ | ∅ (multi) | ∅ | ✓ | ✓ (transaction) | ✓ |
| `claim <id> --type <…>` | execute | signer | false | false | ∅ | ∅ | ✓ (claimed only; ∅ when already-claimed / recovered) | ✓ | ✓ | ∅ | ✓ | ✓ (info: already-claimed / recovered) | ✓ (claim tx; ∅ when already-claimed / pre-send recovery; reverted effect on inclusion-race recovery) | ✓ (verify via `positions status`) |
| `claim-all --dry-run` | dry-run | subject | true | true | ∅ | ∅ | ✓ (planned total) | ∅ | ∅ | ∅ | ∅ | ✓ | ∅ | ✓ (execute form, `safeToAutoRun: false`) |
| `claim-all` (live) | execute | signer | false | false | ∅ | ∅ | ✓ (summed; **fresh successful claims only**) | ∅ | ∅ | ∅ | ∅ | ✓ (info: settle + claim skips/recoveries) | ✓ (one transaction per landed leg, ordered; skipped/recovered legs emit no effect, a reverted-on-inclusion leg emits a `status:'reverted'` effect) | ✓ (verify via `positions status`) |
| `settle <id>` | execute | signer | false | false | ∅ | ∅ | ∅ | ✓ | ✓ | ∅ | ∅ | ✓ (info: already-settled / projection-lag-recovered) | ✓ (settle tx; ∅ when already-settled / pre-send recovery) | ✓ (next: `claim`) |
| `contests create --game-id <…>` | execute | signer | false | false | ✓ (USDC creation fee; consumed when ok=true) | ∅ | ∅ | ✓ (created) | ∅ | ∅ | ∅ | ✓ | ✓ (transaction) | ✓ (next: `wait-verified`) |
| `contests score <id>` | execute | signer | false | false | ∅ (free; no approvals) | ∅ | ∅ | ✓ | ✓ | ∅ | ∅ | ✓ | ✓ (transaction) | ✓ |
| `contests update-markets <id>` | execute | signer | false | false | ∅ (free; no approvals) | ∅ | ∅ | ✓ | ✓ | ∅ | ∅ | ✓ | ✓ (transaction) | ✓ (next: `odds show`) |

### 5.3 Reads

| Command | stage | wallet/role/signer | risk | payout | contest | speculation | commitment | warnings | nextCommands | payload type |
|---|---|---|---|---|---|---|---|---|---|---|
| `health` | read | ∅/none/∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ∅ | API health snapshot |
| `doctor` | read | resolved/subject/∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ✓ (e.g. `auth check`) | `DoctorReport` |
| `auth check` | read | resolved/subject/∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ (lifted from `auth check.warnings[]`) | ✓ (e.g. `auth use-foundry`) | `AuthCheckPayload` |
| `approvals show` | read | resolved/subject/∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ✓ (`approvals setup` when any short) | `ApprovalsSnapshot` |
| `wallet address` | read | resolved/subject/∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ | `{ address }` |
| `commitments list` | read | filter (if `--maker`) or none | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ✓ | `Commitment[]` |
| `commitments show <hash>` | read | maker/subject/∅ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (e.g. `cancel`) | `Commitment` |
| `commitments fillability <hash>` | read | taker/subject/∅ | ∅ | ∅ | ∅ | ∅ | ✓ (the maker commitment) | ∅ | ∅ | `CheckCommitmentFillabilityResult` |
| `commitments nonce-floor` | read | maker/subject/∅ | ∅ | ∅ | ✓ | ✓ | ∅ | ✓ | ✓ | `{ maker, contestId, scorer, lineTicks, minNonce }` |
| `contests list` | read | none | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ✓ (e.g. `contests create`) | `Contest[]` |
| `contests show <id>` | read | none | ∅ | ∅ | ✓ | ∅ | ∅ | ✓ | ✓ | `Contest` |
| `contests wait-verified` | read | none | ∅ | ∅ | ✓ | ∅ | ∅ | ✓ (timeout warning) | ✓ (next: `contests show`) | `{ contestId, status }` |
| `games list` | read | none | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ✓ (e.g. `contests create --game-id`) | `Game[]` |
| `leaderboard show` | read | none | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ (`window-too-short`) | ∅ | `LeaderboardEntry[]` |
| `odds show <id>` | read | none | ∅ | ∅ | ✓ | ∅ | ∅ | ✓ (stale data, no jsonoddsId) | ✓ (next: `odds watch`) | `OddsShowEnvelope` |
| `positions list` | read | resolved or `--address`/subject/∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ✓ (e.g. `claim-all`) | `Position[]` |
| `positions status` | read | resolved or `--address`/subject/∅ | ✓ (totals) | ✓ (claimable total) | ∅ | ∅ | ∅ | ✓ | ✓ (`claim-all --dry-run`) | bucketed status |
| `positions history` | read | resolved or `--address`/subject/∅ | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ∅ | `Position[]` |
| `speculations list` | read | none | ∅ | ∅ | ∅ | ∅ | ∅ | ✓ | ∅ | `Speculation[]` |
| `speculations show <id>` | read | none | ∅ | ∅ | ✓ | ✓ | ∅ | ✓ | ✓ | `Speculation` (with orderbook) |

---

## 6. Failure envelope contract

Class A commands emit a valid envelope on failure wherever possible:

```jsonc
{
  "schemaVersion": 2,
  "ok": false,
  "action": "commitments.match",
  "stage": "preview",
  "network": "polygon",
  "chainId": 137,
  "generatedAt": "2026-05-17T15:00:00Z",
  "cliVersion": "0.2.0",
  "sdkVersion": "0.2.0",
  "wallet": "0xabc...",
  "walletRole": "signer",
  "signer": "0xabc...",
  "requiresSignature": true,
  "requiresTransaction": true,
  "approvalRequirements": [],
  "estimatedCosts": null,
  "risk": null,
  "payout": null,
  "contest": null,
  "speculation": null,
  "commitment": null,
  "sideSummary": null,
  "warnings": [],
  "errors": [
    {
      "code": "ALLOWANCE_INSUFFICIENT",
      "message": "USDC allowance for PositionModule is below required risk amount",
      "details": { "required": "25000000", "current": "0", "spender": "0x...", "token": "0x..." }
    }
  ],
  "effects": [],
  "nextCommands": [
    {
      "id": "approve-commitment-risk",
      "description": "Approve USDC risk allowance for PositionModule",
      "suggestedFor": "remediate",
      "command": "ospex commitments approve 25 --yes --json",
      "argv": ["commitments", "approve", "25", "--yes", "--json"],
      "safeToAutoRun": false
    }
  ],
  "payload": null
}
```

Rules:

- Exit code is nonzero when `ok: false`.
- `errors[]` is populated using the `OspexError.code` taxonomy from [`AGENT_CONTRACT.md` §7](./AGENT_CONTRACT.md).
- `nextCommands[]` may include a `remediate` suggestion when the error has a known local fix.
- `payload: null` when the command could not produce a payload.
- Errors that prevent envelope construction at all (e.g. failure before SDK init) fall back to `error: <code>: <message>` on stderr with exit `1`. This is a narrow window: anything after `getClient()` succeeds emits a structured failure envelope.
- Validation errors thrown before `getClient()` (`OspexValidationError` on argument parse) also fall back to stderr.
- **Failure-envelope intent flags are path-specific.** `requiresSignature: true` is set when the failed code path would have produced an EIP-712 signature or signed a tx had it succeeded — for every write command (sign-based or tx-based) this is always true. `requiresTransaction: true` is set ONLY when the failed code path would have sent or attempted an on-chain tx. The two are independent:
  - Pure on-chain writes (`commitments {match, cancel-onchain, cancel-all, approve, approve-raw}`, `contests {create, score}`, `positions {claim, settle, claim-all}`, `approvals setup`): both flags `true`.
  - `commitments submit`: `requiresSignature: true` always; `requiresTransaction: true` ONLY when an approval tx was required/attempted in this run (the EIP-712-then-POST core is off-chain, so a pre-approval or no-approval-needed failure keeps `requiresTransaction: false`).
  - `commitments cancel`: `requiresSignature: true` always (EIP-712 cancel-auth); `requiresTransaction: true` ONLY when `--also-onchain` was passed.
  - `positions claim-all --dry-run`: both flags `true` regardless of signer presence (the dry-run plan describes a write that WOULD have been sig + tx); `--dry-run --address <addr>` is signer-free, so `signer: null` and `walletRole: 'subject'` with `wallet` carrying the explicit address.
  Same `wallet` / `signer` rule applies: when the signer was resolved before the failure, the failure envelope MUST carry the resolved address (`null` is reserved for "signer never came into scope" failures). The address-only dry-run shape above is the one exception — `wallet` carries the explicit subject address with role `'subject'`, `signer` stays `null`.
- **Advisory-preflight refusals are a distinct `ok: false` shape, not an `errors[]` failure.** When `match`/`submit`'s fillability/fundability preflight refuses before the write (see [`AGENT_CONTRACT.md` §2 "Advisory preflights"](./AGENT_CONTRACT.md)), the envelope is `ok: false`, `stage: 'execute'`, `errors: []`, with the blocking reasons as `severity: 'blocking'` `warnings[]` (`blockingFor: ['match'|'submit']`) and the verdict + a `refused-before-send` / `refused-before-sign` marker in `payload` (`{ preflight, action }` / `{ fundability, action }`). Exit code is still nonzero; `--force` / `--skip-*-preflight` bypasses it.

---

## 7. JSON cleanliness — acceptance criteria

Every Class A `--json` invocation must satisfy:

- **stdout is parseable JSON, single envelope.** No prefix, no suffix, no spinners, no progress bars.
- **All diagnostics go to stderr.** Allowance prompts, "Resolved `0xabc → …`" address echoes, log lines, stack traces — stderr only.
- **No interactive prompts in `--json` mode.** Preview-bearing commands without `--yes` emit the preview and exit `0`; with `--yes` they execute non-interactively. Anything that would prompt under interactive mode either uses a configured non-interactive credential or errors out structurally with `errors: [{ code: 'non_interactive_password_required', ... }]`.
- **No secrets in any output.** Keystore content, passphrases, decrypted private keys never appear on stdout *or* stderr.
- **`--json | jq .` always works** for both success and failure envelopes.

---

## 8. Future additive minors

These extensions are explicitly **not** part of `schemaVersion: 2` but are designed to be additive — when shipped, consumers that ignore unknown fields keep working unchanged.

- **`apiFreshness` / `blockNumber` on reads.** Requires `ospex-core-api` to expose per-row freshness timestamps. Not all routes do today.
- **`--estimate-gas` flag.** Gas-estimation opt-in. Adds an RPC roundtrip per preview-bearing command; the resulting `EstimatedCosts.gas` block is already specified above.
- **`commitments approve --json` preview-only mode.** A true plan-only preview if operator tooling needs it; today the submit/match preview's `approvalRequirements[]` covers the preflight.
- **NDJSON envelope additions for `odds watch`.** Per-line `network` / `chainId` enrichment would be additive within the existing line shape.
- **`auth use-foundry`, `auth clear-foundry`, `init`, `wallet import/unlock/lock`** to `schemaVersion: 2`. One-shot config commands; agents do not run them in a loop, so migrating them is a cleanup, not a blocker.

---

## 9. Out of scope

Explicit non-goals — the envelope will not grow to accommodate any of the following:

- Frontend UI changes.
- `ospex-core-api` envelope changes (separate spec).
- Per-row envelopes inside list payloads — would double payload size for no agent benefit; consumers iterate the array.
- Stable richer exit codes — the existing `0 | 1 | 130` set is preserved; agents parse `--json` for structure.
- Auto-execution of `nextCommands` by the CLI. The CLI emits the suggestion; the agent decides whether and when to run it.

---

## 10. Where shapes live

- Envelope types: [`packages/sdk/src/types/agentEnvelope.ts`](../packages/sdk/src/types/agentEnvelope.ts) (re-exported from the package barrel).
- Envelope builders (CLI): [`packages/cli/src/lib/agentEnvelope.ts`](../packages/cli/src/lib/agentEnvelope.ts).
- Next-command registry: [`packages/cli/src/lib/nextCommands.ts`](../packages/cli/src/lib/nextCommands.ts).
- Preview payloads (submit / match): [`packages/sdk/src/types/preview.ts`](../packages/sdk/src/types/preview.ts) and [`packages/sdk/src/types/matchPreview.ts`](../packages/sdk/src/types/matchPreview.ts).
- Error taxonomy: [`packages/sdk/src/errors.ts`](../packages/sdk/src/errors.ts).

When the runtime and this document disagree, treat the document as the bug and open an issue with a minimal repro.

[^1]: `approvals setup` preview emits `requiresSignature` and `requiresTransaction` as `true` only when the resolved plan has at least one approval to send (`plan.willSendCount > 0`) — the typical case. On an idempotent re-run where every required allowance is already in place, both fields emit `false` and the envelope is effectively a no-op confirmation. Agents should branch on the emitted values rather than the typical-case row above.
