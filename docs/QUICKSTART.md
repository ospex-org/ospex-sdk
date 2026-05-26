# Ospex quickstart

From zero to your first bet on Polygon mainnet in about ten minutes. The shared setup (install, wallet, config, sanity-check) is six commands. After that, pick the path that matches what you want to do:

- **[Match an existing commitment](#match-an-existing-commitment)** — fastest. You take the other side of a bet someone else has posted. Read this first if you're a casual bettor.
- **[Submit your own commitments](#submit-your-own-commitments)** — set the price yourself; wait for someone to fill it.
- **[Create a contest](#create-a-contest)** — advanced. Mainnet only today (Amoy contracts are wired but script approvals aren't yet committed — see that section). Requires LINK.

After matching or submitting, see **[After the game: score, settle, claim](#after-the-game-score-settle-claim)** to collect winnings.

The longer manual playbook at [`MANUAL_INTEGRATION_TESTING.md`](./MANUAL_INTEGRATION_TESTING.md) covers full release validation; you don't need it.

## Philosophy

Ospex never asks for your private key. You manage your wallet entirely via Foundry's keystore — Ospex just borrows it for signing. You also bring your own RPC URL. If either is missing, Ospex won't run. That's deliberate: we don't take on key-handling liability you can manage better yourself.

## What you need

- **Foundry** — `forge --version` should work. Install: <https://getfoundry.sh>.
- **Polygon RPC URL** — Alchemy, Infura, or QuickNode. The public Polygon RPC has been returning 401 since 2026-03; don't use it.
- **A wallet** funded with:
  - **POL** — gas.
  - **USDC** — the risk you're committing.
  - **LINK** — only required if you want to *create* a contest. You don't need LINK to bet on contests someone else created.
- **Node.js** ≥ 20.

This guide assumes Polygon mainnet (chain id 137). For Polygon Amoy testnet substitute `chainId=80002`. The bettor and maker paths (commitments, positions, leaderboard, odds) work on both networks. `contests create` / `contests score` are mainnet-only today — the Amoy contracts are deployed but the EIP-712 script approvals served by `ospex-core-api` haven't been generated against the current `OracleModule` deploy. **Most agents don't need to test create/score** — validate end-to-end by matching an open commitment whose preview shows `tradeAction: 'trade-only'` (the speculation already exists), where your only costs are gas and the commitment risk you commit. If the preview shows `trade-and-create-speculation` instead, the SDK preflight will quote the TreasuryModule creation-fee approval before signing.

## Vocabulary

If you've used a sportsbook before, here's how Ospex's protocol terms map to the more familiar ones. The Ospex vocabulary matches the on-chain struct names; you'll see both in the wild.

| Sportsbook            | Ospex          | Notes |
|-----------------------|----------------|-------|
| game / event          | contest        | A specific scheduled game (Padres @ Cardinals, 2026-05-08). |
| market / line         | speculation    | A bettable line on a contest (moneyline, -3.5 spread, over 8.5 total). |
| open offer / order    | commitment     | A signed EIP-712 order on the orderbook. |
| placed bet            | position       | Your filled bet on chain (created when a commitment is matched). |
| take the other side   | match          | Fill an existing commitment as the taker. |

The rest of this guide uses the Ospex terms.

## Install the CLI

The CLI ships as a **single self-contained bundle** — one file with every dependency inlined — distributed via [GitHub releases](https://github.com/ospex-org/ospex-sdk/releases) (not npm). Install it globally and the `ospex` command is on your PATH; there's nothing else to resolve.

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

Prefer downloading first? Grab `ospex-cli-<ver>.tgz` from the [releases page](https://github.com/ospex-org/ospex-sdk/releases) and install the local path instead: `npm install -g ./ospex-cli-<ver>.tgz` (or `yarn global add ./ospex-cli-<ver>.tgz`).

The rest of this guide writes `ospex` for the command.

> **Building from source** (contributors): from a clone of the monorepo, `yarn install && yarn workspace @ospex/cli build` produces the bundle at `packages/cli/dist/index.js`, and `yarn workspace @ospex/cli pack` makes the tarball. The `@ospex/sdk` tarball (`yarn workspace @ospex/sdk pack`) is a separate, unbundled library for programmatic consumers — CLI users don't need it.

## Create or import a wallet via Foundry

**Brand-new wallet** — Foundry generates the key in memory and never displays it. The first arg is the keystores *directory*; the second is the file name:

```bash
mkdir -p ~/.foundry/keystores
cast wallet new ~/.foundry/keystores ospex-test
# Prompts for a passphrase. Prints only the address. Writes to ~/.foundry/keystores/ospex-test.
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.foundry\keystores" | Out-Null
cast wallet new "$env:USERPROFILE\.foundry\keystores" ospex-test
```

**Existing private key** — Foundry takes the key over hidden input, encrypts it with your passphrase, and never shows it again:

```bash
cast wallet import ospex-test --interactive
# Hidden prompt for the PK, then a passphrase. Prints the address.
# Auto-resolves to ~/.foundry/keystores/ospex-test.
```

Either way, Foundry now owns an encrypted v3 keystore at `~/.foundry/keystores/ospex-test`.

Fund the printed address with POL (gas), USDC (your stake), and — if you plan to create a contest — LINK.

## Configure Ospex

```bash
ospex init
```

Answer the prompts:

- **Network** — `137` for mainnet, `80002` for Amoy.
- **API URL** — accept the default (production).
- **RPC URL** — paste your Alchemy / Infura / QuickNode URL.
- **Keystore path** — paste `~/.foundry/keystores/ospex-test` (or whatever name you used in the previous step). Leading `~/` is expanded.

The values land in `~/.ospex/config.json`. From this point on, every Ospex command uses your Foundry keystore — no env vars, no shell-profile editing.

If you'd rather not persist the keystore path (e.g. you're scripting against multiple wallets), leave it blank at the prompt and instead `export OSPEX_KEYSTORE_PATH=…` in the shell where you run Ospex. Env var beats config file when both are set.

## Optional: pin a non-interactive signer (recommended for agents)

The default `ospex init` flow prompts for the Foundry passphrase every time you sign. For agent flows — or just to skip the prompt yourself — save the passphrase to a `0600` file and pin it once via `ospex auth use-foundry`:

```bash
# 1. Save the passphrase to a file readable only by you.
mkdir -p ~/.ospex/secrets
printf '%s' 'your-passphrase' > ~/.ospex/secrets/ospex-test.pass
chmod 600 ~/.ospex/secrets/ospex-test.pass

# 2. Validate + pin (decrypts once, captures the address, writes config).
ospex auth use-foundry \
  --account ospex-test \
  --password-file ~/.ospex/secrets/ospex-test.pass
# Validated: 0xab12…34cd
# Wrote ~/.ospex/config.json with the Foundry signer defaults: ...

# 3. (Recommended) verify the resolution end-to-end.
ospex auth check --sign-challenge
```

From this point on every write command (`submit`, `match`, `claim`, ...) unlocks non-interactively without prompting. The decrypted key lives in process memory for the duration of one command — it's never written to disk. (Compare with `ospex wallet unlock`, the legacy flow, which writes the decrypted private key to `~/.ospex/session` for 15 minutes.)

The address pin in step 2 also catches surprise key rotations: if the keystore later decrypts to a different address than the one validated here, the next sign refuses with `address_mismatch`. Use `--no-pin-address` to opt out, or `ospex auth clear-foundry --expected-address` to remove the pin later. `ospex auth clear-foundry --all` removes every Foundry-signer field and reverts to the prompt-on-every-sign behavior (the legacy `keystorePath` from `ospex init` is preserved).

PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ospex\secrets" | Out-Null
$Pass = Read-Host -AsSecureString
[System.IO.File]::WriteAllText(
  "$env:USERPROFILE\.ospex\secrets\ospex-test.pass",
  [System.Net.NetworkCredential]::new('', $Pass).Password,
)
# (Windows has no POSIX 0600 — rely on user-folder ACLs.)
ospex auth use-foundry --account ospex-test --password-file "$env:USERPROFILE\.ospex\secrets\ospex-test.pass"
ospex auth check --sign-challenge
```

## Verify readiness

```bash
ospex doctor
```

Reports network status, balances (POL/USDC/LINK), allowances, and a "Ready to" matrix. Exit 0 means the wallet is **baseline-ready** to match commitments; each specific match still preflights exact balance, allowance, expiry, and fee requirements at submit/match time. The report's bottom **Next step** line points at exactly the command that unlocks the next capability when something's missing.

Re-run after each step in the path sections below to confirm progress; it's also the canonical agent guard:

```bash
ospex doctor && ospex commitments match $hash
```

If `ospex doctor` prompts you for the Foundry passphrase to derive your address, that's expected on fresh setups — pass `--address <0x…>` to inspect any wallet read-only without touching the keystore.

---

## Match an existing commitment

The shortest path to your first bet — three or four commands once setup is done.

### 1. Set up approvals

One-line bulk approve, with sensible defaults:

```bash
ospex approvals setup --risk-usdc 50 --yes
```

This approves **PositionModule** for 50 USDC (your bet risk pool — the contract pulls from this allowance both when you match someone else's commitment and when one of your own commitments is filled). When `--risk-usdc` is set alone, a small `--fee-usdc` budget is auto-included so the next match doesn't trigger a mid-bet approval prompt for the lazy speculation creation fee; pass `--fee-usdc 0` to opt out, or run `ospex approvals show` to verify what landed.

### 2. Find a commitment

```bash
ospex contests list --hours 168                    # upcoming contests in the next week
ospex commitments list --contest-id <contestId>    # open orderbook for one contest
```

The hash column in the output truncates to 8 hex chars (`0xe900c6dd…`). The truncated form is enough — every command that takes a commitment hash also accepts a unique 0x-prefixed prefix.

(Optional) See current upstream reference odds for a contest:

```bash
ospex odds show <contestId>
```

These are NOT Ospex liquidity — they're a sanity-check from external markets, not a price you need to match.

### 3. Match it

```bash
ospex commitments match 0xe900c6dd
```

Renders a first-person preview block — `You back: <team> at <american>`, `Counterparty: <team> at <american> — maker 0x…`, `Your risk:`, `Your profit: +N USDC if <team> wins`, and `Maker fill: X of Y remaining (full|partial fill)` so you can verify both sides of the trade at a glance (at +260 odds, e.g., a taker risking 1.6 USDC fully fills a maker risking 1 USDC). Self-matches replace the `You back / Counterparty` lines with a dual-stake block and an explicit `Position stake from your wallet:` total. The preview ALSO carries an explicit `Speculation:` / `Action:` block that says either `trade only` (no creation fee — speculation already exists) or `trade + speculation creation` (a per-side 0.25 USDC creation fee may be pulled if your tx is still the first match at execution time). Pass `--raw` if you need the pre-perspective-view dual maker/taker layout for protocol debugging.

Confirm with Enter (or `y`) to sign and send. The CLI prompts for your Foundry passphrase once; the resulting position appears in `ospex positions status <yourAddress>`.

To take a partial fill, pass `--risk-usdc <n>`:

```bash
ospex commitments match 0xe900c6dd --risk-usdc 0.5
```

Pass `--yes` to skip the confirmation prompt for scripted use; pass `--json` (without `--yes`) to emit the preview envelope without signing.

That's the bettor loop. After the game finishes, jump to [After the game](#after-the-game-score-settle-claim).

---

## Submit your own commitments

Set the price yourself; wait for a taker to fill the other side. The maker path uses the same setup, plus a slightly bigger USDC budget if you plan to keep multiple commitments in flight.

### 1. Set up approvals

Same one-liner as the bettor path; size the risk budget for the total liability you're willing to have on the orderbook at once:

```bash
ospex approvals setup --risk-usdc 200 --yes
```

### 2. Pick a price

```bash
ospex odds show <contestId>
```

Shows all three markets (moneyline / spread / total) in both American and decimal odds with a relative "last updated" stamp. Pass `--json` for a single envelope you can pipe.

> **`show` vs `watch`**: `show` is the user-facing one-shot snapshot; `watch` opens a live SSE stream and prints line-delimited JSON, runs until SIGINT. Use `show` to decide a price; use `watch` to react to upstream odds moves over time.

### 3. Submit a commitment

```bash
# Moneyline, 2.50 odds, $1 stake
ospex commitments submit \
  --speculation <speculationId> \
  --side lakers \
  --odds 2.50 \
  --risk-usdc 1

# Same moneyline by --contest (no --line — moneyline is line-less)
ospex commitments submit \
  --contest <contestId> --market moneyline \
  --side lakers \
  --odds 2.50 --risk-usdc 1

# Spread, home side at -3.5, $25 stake at 1.91 odds
ospex commitments submit \
  --contest <contestId> --market spread \
  --side padres --line -3.5 \
  --odds 1.91 --risk-usdc 25

# Total, over 8.5 at 1.95 odds, $10 stake
ospex commitments submit \
  --contest <contestId> --market total \
  --side over --line 8.5 \
  --odds 1.95 --risk-usdc 10
```

The CLI prints a preview block before signing — contest, market, side, odds, risk, win/lose/push outcomes in plain language, and the raw protocol fields for verification:

```
Resolved commitment:
  contest:      Cardinals @ Padres, 2026-05-08 — MLB
  market:       moneyline (#123)
  side:         San Diego Padres (home)  [scorer=0xd846…, source=nickname]
  odds:         2.50 decimal / +150 american  [oddsTick=250]
  risk:         1.000000 USDC
  to win:       1.500000 USDC  (return = 2.500000 USDC)

Outcomes:
  Padres win    → you win 1.500000 USDC
  Cardinals win → you lose 1.000000 USDC

Submit? [Y/n]
```

(The `odds` line shows both decimal and American formats so the value you signed is unambiguous regardless of which format you typed.)

Confirm with Enter (or `y`) and the CLI signs and posts the EIP-712 commitment. The hash plus `status: open` prints. List your active orders with:

```bash
ospex commitments list --maker <yourAddress>
```

If the speculation already exists (a prior commitment has been matched on the same `(contestId, scorer, lineTicks)` tuple), the preview spells out that **no creation fee applies** on this submit:

```
speculation:  already created (#123) — no creation fee on match
              → trade-only submit
```

If the speculation hasn't been created yet, the preview surfaces the per-side speculation creation fee — paid only if YOUR commitment turns out to be the first match:

```
speculation:  not yet created — lazily created on first match
              speculationKey=0x3b7b…
              → trade + speculation creation IF your commitment is the first to match
              your share (maker): 0.250000 USDC via TreasuryModule
              counterparty (taker): 0.250000 USDC via TreasuryModule
              (not pulled if a prior match has already created the speculation by match time)
```

### Key flags

- **`--side`** — team name, last-token nickname (`lakers`), or any alias (`LAL`) for moneyline / spread; `over` or `under` for total.
- **`--odds`** — decimal (`"2.50"`, `"1.91"`) **or** American with an explicit sign (`"+150"`, `"-110"`). Format detected from input shape:
  - signed integer (no decimal point) → American
  - decimal with no sign → decimal
  - both signed AND decimal (`"+101.0"`) → ambiguous, rejected
  - integer with neither sign nor decimal point (`"101"`) → ambiguous, rejected — use `"+101"` for American or `"101.0"` for decimal

  Protocol bound is `1.01 ≤ decimal ≤ 101.00`, equivalent to American `[-10000, -100]` ∪ `[+100, +10000]`. The preview echoes both formats so you can verify before signing; negative-American values round to the protocol's 2-decimal precision (e.g. `-113` → decimal `1.88` → re-displayed as `-114`).
- **`--risk-usdc`** — decimal USDC string. `1`, `0.001`, `25`. Must be a multiple of `$0.0001` per the contract's lot-size rule.
- **`--line`** — selected-side displayed line for spread / total. `--side padres --line -3.5` means "Padres -3.5" regardless of whether Padres are home or away; the resolver inverts to the protocol's away-side ticks under the hood. **Omit for `--market moneyline`** — moneyline is line-less, and the SDK errors if `--line` is passed there.
- **`--yes`** skips the confirmation prompt and signs/posts. **`--json`** is output-format only and pairs with `--yes`:
  - `--json` alone → emits a v2 `AgentEnvelope` (`stage: 'preview'`, `payload: SubmitPreview`, **no signing**). Use case: an agent inspects the resolved tuple before deciding whether to commit.
  - `--yes --json` → signs/posts and emits a v2 `AgentEnvelope` (`stage: 'execute'`, `payload: { preview, result, fundability }`).
  - Any non-interactive run that would sign without `--yes` errors out rather than hanging on a prompt.
- **`--expiry`** — when the signed commitment stops being matchable. Three accepted forms:
  - **duration** — `30m`, `4h`, `1d`, `1w`. Sets expiry to `now + duration`.
  - **ISO-8601 / RFC3339** — `2026-05-09T20:00:00Z`. Use `Z` or an explicit `±HH:MM` offset.
  - **unix-seconds** — `1715299200`.

  **Default**: contest's scheduled match time. A pregame commitment expires at tip-off by default — this protects you from a stale pregame price being filled minutes after the game starts. If you want post-start exposure, pass `--expiry` explicitly; the preview block warns when `expiry > matchTime`. If the contest has no match time on file, the default falls back to `now + 1h`. If the match time has already passed, omitting `--expiry` errors out — pass it explicitly to opt into a live commitment. Validation: `now < expiry ≤ now + 1y` (protocol cap).
- **`--approve-max`** — non-interactive shortcut, only applied with `--yes`. Sends an unlimited USDC approval if approval is needed. Without it, `--yes` defaults to the exact required amount. Ignored in interactive mode (the CLI prompts for the approval amount; type `max` if you want unlimited at that step). Mostly redundant once you've run `ospex approvals setup` up front.

### Cancel a commitment

Off-chain cancel (cheap, no gas):

```bash
ospex commitments cancel 0xe900c6dd
```

Authoritative on-chain cancel (gas, can't be undone):

```bash
ospex commitments cancel-onchain 0xe900c6dd
```

Bulk cancel everything from your wallet on one speculation:

```bash
ospex commitments cancel-all --contest-id <id> --scorer <addr> --line <ticks>
```

### Advanced: `commitments submit-raw` (escape hatch)

If you already hold canonical protocol values (raw scorer address, lineTicks at 10× scale, oddsTick at 100× scale, `riskAmount` in wei6) — say from a market-maker bot or a debugging session — there's a positional escape hatch:

```bash
ospex commitments submit-raw 42 0xd846… 0 upper 250 1000
```

Same arguments mirror the on-chain `OspexCommitment` struct. No preview block, no resolver. Use the high-level form unless you have a specific reason not to.

---

## Create a contest

Permissionless contest creation. Anyone can create a contest, but it requires LINK (for the Chainlink Functions verification call) and a USDC fee read from `TreasuryModule.s_feeRates(0)` at runtime (1 USDC on Polygon mainnet at time of writing). **Mainnet only today** — the Amoy contracts are deployed but the script approvals that `OracleModule.createContestFromOracle` requires haven't been signed against the current deploy and committed to `ospex-core-api`. The SDK's allowance preflight quotes the exact LINK and USDC amounts you need to fund before signing. **Skip this section if you just want to bet** — the bettor and maker paths above don't need any of this, and most integrations can validate end-to-end against existing contests.

### 1. Set up the operator-grade approvals

Add LINK + Oracle approval on top of the bettor setup:

```bash
ospex approvals setup --risk-usdc 200 --fee-usdc 5 --link 2 --yes
```

This approves PositionModule (bets), TreasuryModule (contest creation + lazy spec creation fees), and OracleModule (LINK for Chainlink Functions). `ospex approvals show` will reflect all three.

### 2. Pick a game

```bash
ospex games list --sport mlb --hours 24
```

Look for a row whose `creatable` column is `yes`. You can pass either the gameId (the stable UUID) or the slug — the resolver accepts both:

```bash
ospex contests create --game-id <pasted-gameId>
ospex contests create --game stl-sd-2026-05-08      # alias: slug or UUID
```

The slug is mutable (the writer renames doubleheaders), so for anything you persist between sessions stick with `--game-id`. Multiple matches or no match fail closed.

### 3. (Optional) Submit the first commitment

Once `contests create` returns a `contestId`, the writer populates current_odds within ~30s. You can use those reference odds as a starting price for your first commitment on the new contest — see [Submit your own commitments](#submit-your-own-commitments).

`ospex contests create` waits for the Chainlink Functions verification callback by default and prints the new `contestId` only after `contestStatus=Verified` lands on chain (typically 10–30s). Pass `--no-wait` if you'd rather get the txHash immediately and poll separately with `ospex contests wait-verified <contestId>` — useful for scripted flows.

The three external IDs the contract requires (rundown / sportspage / jsonodds) are resolved server-side from the gameId; you never deal with them directly.

---

## After the game: score, settle, claim

Once the underlying game ends, three permissionless on-chain steps move funds back to the winners. Anyone can run any of them — they're not gated to the maker / taker / contest creator.

### 1. Score the contest

```bash
ospex contests score <contestId>
```

Submits an `OracleModule.scoreContestFromOracle` tx. Burns LINK + Chainlink Functions; usually whoever cares about settling first runs this. (If you only ever bet on contests other people created, you may never need to do this — operators or other players typically score them.)

### 2. Settle each scored speculation

```bash
ospex settle <speculationId>
```

After `score` lands, each speculation's outcome is resolved. `settle` writes that outcome to chain so positions can be claimed. It's idempotent — if the speculation is already settled (e.g. someone else settled it first), `settle` reports that as success (no transaction, no error).

### 3. Claim winning positions

```bash
ospex claim-all                                    # sweep every claimable position on this wallet
ospex claim <speculationId> --type upper|lower    # one specific position
```

`ospex positions status <yourAddress>` shows what's `active`, `claimable`, or `pendingSettle` (a winner waiting on `settle`) at any time. `claim-all` is the day-to-day shortcut; the typed form is for one-off claims when you want to be explicit. Both are **idempotent**: `claim-all` is safe to run even if a `pendingSettle` speculation was already settled by someone else (it skips the redundant settle), and re-running either after a position is already claimed reports success (`outcome: alreadyClaimed`, no transaction) instead of an `AlreadyClaimed` error — so a rerun or a wallet someone else already swept never errors out. (Only `AlreadyClaimed` is treated this way; claiming before the speculation is settled still errors with a pointer to `ospex settle`.)

---

## Agent / scripting flow

> The full integration contract — JSON envelope shapes, typed error codes, idempotency rules, and what's stable across releases — lives in [`AGENT_CONTRACT.md`](./AGENT_CONTRACT.md). Read it before depending on any output shape in production.

Agents skip the human flow where commands provide explicit preview/execute modes. For **preview-capable flows** (`commitments submit`, `commitments match`, `approvals setup`), `--json` alone is preview-only and `--yes --json` executes and emits the result envelope. For **other write commands** (`contests score`, `settle`, `claim`, `claim-all`, `commitments cancel`, `commitments cancel-onchain`), `--json` is only an output format and the command may still send a transaction — check the command help and use `--dry-run` where available (e.g. `claim-all --dry-run`).

```bash
# Discover a candidate.
HASH=$(ospex commitments list --contest-id 8 --json | jq -r '.[0].commitmentHash')

# Preview without signing — inspect the resolved tuple, fee profile, warnings.
ospex commitments match "$HASH" --json

# When ready, execute. --yes --json emits the result envelope.
ospex commitments match "$HASH" --yes --json
```

For `commitments match --json` specifically: no transaction is signed or sent. The preview needs a taker address (for the `selfMatch` flag and the allowance preflight); the lazy-unlock contract resolves it in this order, falling back only when the preceding option is absent:

1. `--expected-address <0x…>` — no unlock at all; the agent asserts the address.
2. Any non-interactive password source — flag (`--account` + `--password-file` / `--password-stdin`), env (`OSPEX_PASSWORD_FILE`), or config (set via `ospex auth use-foundry`). The keystore unlocks silently to derive the address.
3. The legacy cached session (`ospex wallet unlock`) — kept for compatibility but not the recommended posture.

If none of those resolve, the command errors out with `non_interactive_password_required` rather than hanging on a prompt. For new scripts the preferred preamble is one of `--expected-address` or `auth use-foundry`; `wallet unlock` should be treated as a legacy fallback only.

`--yes --json` runs the full flow and emits `{ schemaVersion, …, payload: { preview, result, fundability } }` on stdout (`fundability` is the advisory submit-preflight verdict, `null` when skipped with `--force` / `--skip-fundability-preflight`; `match` carries `fillability` likewise). The "Resolved <prefix> → <fullHash>" echo (when a prefix is passed) goes to stderr so stdout stays parseable JSON.

`--approve-max` is the non-interactive shortcut for unlimited USDC approval; without it, `--yes` approves the exact amount needed. (Mostly redundant if the agent runs `ospex approvals setup --risk-usdc <n> --yes` once during init.)

For machine-readable wallet/readiness state:

```bash
ospex wallet address --json | jq -r .address      # passphrase prompt goes to stderr
ospex doctor --address $WALLET --json             # full readiness envelope
ospex approvals show --address $WALLET --json
```

---

## Advanced / automation

Not part of the happy path — these are for CI runners, multi-wallet agents, and similar non-interactive setups. Most users should pin a default signer via `ospex auth use-foundry` (covered above) instead of reaching for env vars and flags every time.

### Per-invocation signer overrides

Every write command accepts the same six flags. They beat env vars; env vars beat `~/.ospex/config.json`:

- `--account <name>` — Foundry account name. Resolves to `<foundryKeystoresDir>/<name>`. Mutually exclusive with `--keystore-path`.
- `--keystore-path <path>` — Explicit path to a v3 keystore JSON.
- `--password-file <path>` — Read passphrase from a file (trailing newline trimmed, matching `cast`).
- `--password-stdin` — Read passphrase from stdin (first line). Useful for password-manager pipes: `pass show foo | ospex commitments submit ... --password-stdin --yes`.
- `--expected-address <0x…>` — Refuse to sign if the unlocked address differs (agent guardrail).
- `--foundry-keystores-dir <path>` — Override Foundry keystores root.

There is intentionally no `--password <value>` flag — passphrases on the CLI would leak into shell history and process listings.

### Env vars

| Var | Effect |
|---|---|
| `OSPEX_KEYSTORE_PATH` | Direct path to a v3 keystore JSON. |
| `OSPEX_PASSWORD_FILE` | Path to a passphrase file. The file contents are the secret; the path may be in env. Never put a passphrase itself in an env var — env is leaky (`/proc/<pid>/environ`, child processes, debuggers). |
| `OSPEX_FOUNDRY_KEYSTORES_DIR` | Override the Foundry keystores root. |
| `FOUNDRY_DIR` | Foundry's standard env var. The CLI appends `/keystores`. |
| `OSPEX_HOME` | Override `~/.ospex` (useful for tests / parallel agent instances). |

The full precedence ladder for every field is **flag > env > config > default**. `ospex auth check` walks the ladder and reports the resolved source for each field — pair with `--json` for machine-readable output.

### Verifying a setup in CI

```bash
ospex auth check --strict --sign-challenge --json
```

Exits 0 only if the keystore actually unlocks AND signs a deterministic EIP-712 challenge — the strongest one-shot proof that the agent can sign. `--strict` additionally rejects a group/other-readable password file (mode `& 0o077 != 0`). The lighter-weight `ospex auth check --strict --json` (no `--sign-challenge`) validates the resolution + permission gate but **passes** with `unlock.attempted: false` when no password source is configured — useful for config sanity but not a proof of signing capability. If you want that lighter form, also assert `unlock.succeeded === true` in the JSON envelope.

`ospex doctor --strict` applies the same loose-perm gate before the chain-side readiness checks — useful as a one-shot guard ahead of a batch of writes.

For the full machine-readable contract — envelope shapes, error reason codes, the lazy-unlock contract for `--json` previews — see [`AGENT_CONTRACT.md` §4](./AGENT_CONTRACT.md).

---

## What's next

The CLI separates **one-shot user actions** (request → reply → exits) from **streaming / agent primitives** (subscribe → events → runs until SIGINT). Most day-to-day usage lives in the first table; the second is what an automated agent would build on.

### One-shot actions (user)

| Goal | Command |
|---|---|
| Check setup readiness for a wallet | `ospex doctor [--address <addr>]` |
| Bulk-approve USDC + LINK budgets | `ospex approvals setup --risk-usdc <n> [--fee-usdc <n>] [--link <n>]` |
| Inspect approvals for any wallet | `ospex approvals show [--address <addr>]` |
| See current upstream reference odds for a contest | `ospex odds show <contestId>` |
| Take an open commitment as the counterparty | `ospex commitments match <hash-or-prefix>` |
| See your active and claimable positions | `ospex positions status <yourAddress>` |
| Cancel an open commitment off-chain | `ospex commitments cancel <hash-or-prefix>` |
| Cancel authoritatively on-chain | `ospex commitments cancel-onchain <hash-or-prefix>` |
| Bulk-cancel all your orders on a speculation | `ospex commitments cancel-all --contest-id <id> --scorer <addr> --line <ticks>` |
| Claim a winning position after settlement | `ospex claim <speculationId> --type upper\|lower` |
| Claim everything claimable for a wallet | `ospex claim-all` |
| Settle a scored speculation (permissionless) | `ospex settle <speculationId>` |

### Streaming / subscription (agent)

| Goal | Command |
|---|---|
| Subscribe to upstream odds changes (NDJSON in `--json` mode) | `ospex odds watch <contestId>` |

The full command reference is in the [README](../README.md).

---

## Troubleshooting

**`No keystore found at <path>`** — neither `~/.ospex/config.json` has a `keystorePath` nor `OSPEX_KEYSTORE_PATH` is set, or one of them points at a missing file. Run `ospex init` and supply the path when prompted (it persists across shells). For a per-shell override use `export OSPEX_KEYSTORE_PATH=…` instead.

**`Failed to decrypt keystore`** — wrong passphrase, or the file is not a v3 keystore. Foundry always produces v3; this is almost always the passphrase.

**`OspexAllowanceError: insufficient allowance`** — `ospex commitments submit` (high-level) prompts for an approval and runs it before signing, so this should be rare. Interactive runs default the amount prompt to the exact-required value — type `max` instead if you want unlimited. Non-interactive runs (`--yes`) default to exact-required; pass `--approve-max` alongside `--yes` for unlimited. For scripted flows that approve out-of-band, run `ospex approvals setup --risk-usdc <n>` (decimal USDC) for the multi-spender path, or `ospex commitments approve <decimal-usdc|max>` for the single-spender shortcut (use `commitments approve-raw <wei6>` if you already have 6-decimal-units integers). If you're creating contests, the LINK and USDC allowances target different modules (OracleModule and TreasuryModule, respectively); the CLI prompts on demand.

**`OspexChainError: <selector>`** — a transaction reverted. The selector usually decodes to a known contract error (e.g., `MatchingModule__NonceMustIncrease`). Read the printed reason; if unclear, file an issue with the tx hash.

**`ospex doctor` says "Core API unreachable"** — every Ospex write goes through the public API (commitment posting, contest script approvals). Wallet state on-chain is fine; retry shortly. If it persists, the API may be temporarily down.

**Public RPC errors / 401s** — you're using a public Polygon RPC. Switch to Alchemy / Infura / QuickNode in `ospex init`.
