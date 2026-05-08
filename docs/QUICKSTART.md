# Ospex quickstart

Goal: zero to a placed commitment on Polygon mainnet in about ten minutes.

This is the minimum-friction path. The longer manual playbook at [`MANUAL_INTEGRATION_TESTING.md`](./MANUAL_INTEGRATION_TESTING.md) covers full release validation; you don't need it.

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

This guide assumes Polygon mainnet (chain id 137). For Polygon Amoy testnet substitute `chainId=80002`. Note: contest creation works on mainnet only — Amoy script approvals aren't shipped.

## 1. Install the CLI

Distribution is via [GitHub releases](https://github.com/ospex-org/ospex-sdk/releases). Once a release is tagged, download `ospex-sdk-<ver>.tgz` and `ospex-cli-<ver>.tgz` from the release page, then skip to the **Install** step below — substitute the downloaded paths in the `yarn add` command.

Until the first release is tagged, build the tarballs locally from a clone of the monorepo:

```bash
# In the ospex-sdk monorepo:
yarn install
yarn workspace @ospex/sdk build
yarn workspace @ospex/cli build
yarn workspace @ospex/sdk pack --filename ospex-sdk.tgz
yarn workspace @ospex/cli pack --filename ospex-cli.tgz
```

**Install** — in a working directory where you want to use the CLI:

```bash
cd /path/to/your/working-dir
yarn init -y                                          # creates a minimal package.json
yarn add file:/abs/path/to/ospex-sdk/packages/sdk/ospex-sdk.tgz \
         file:/abs/path/to/ospex-sdk/packages/cli/ospex-cli.tgz
npx ospex --version
```

(For the GitHub-release flow, swap the paths above for the downloaded tarballs — e.g. `file:./ospex-sdk-0.1.0.tgz`.)

You install **both** tarballs in the same `yarn add` command. The CLI uses the SDK at runtime but doesn't list it as a regular dependency — yarn 1 has a quirk that turns a transitive `@ospex/sdk` reference into a registry lookup, and we distribute through GitHub releases rather than npm by design.

The rest of the guide writes `ospex` for the binary; substitute `npx ospex` until it's on your PATH.

## 2. Create or import a wallet via Foundry

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

## 3. Configure Ospex

```bash
ospex init
```

Answer the prompts:

- **Network** — `137` for mainnet, `80002` for Amoy.
- **API URL** — accept the default (production).
- **RPC URL** — paste your Alchemy / Infura / QuickNode URL.
- **Keystore path** — paste `~/.foundry/keystores/ospex-test` (or whatever name you used in step 2). Leading `~/` is expanded.

The values land in `~/.ospex/config.json`. From this point on, every Ospex command uses your Foundry keystore — no env vars, no shell-profile editing.

If you'd rather not persist the keystore path (e.g. you're scripting against multiple wallets), leave it blank at the prompt and instead `export OSPEX_KEYSTORE_PATH=…` in the shell where you run Ospex. Env var beats config file when both are set.

## 4. Sanity check

```bash
ospex health                      # Should report ok: true.
ospex contests list --hours 168   # Should list upcoming contests.
ospex wallet address              # Prompts for the Foundry passphrase. Prints your address.
```

If `ospex wallet address` prompts you and prints the same address Foundry showed you in step 2, the wiring is correct. (Foundry-produced keystores omit the top-level `address` field, so Ospex derives it via the passphrase. Keystores produced by the legacy `ospex wallet import` flow include the field and skip the prompt.)

## 5. Place a commitment

Find an upcoming contest:

```bash
ospex contests list --hours 168
```

Check current upstream reference odds for the contest. These are JSONOdds / Sportspage market averages, not Ospex liquidity — but they're useful as a starting reference for the `--odds` you'll pass to `commitments submit`:

```bash
ospex odds show <contestId>
```

Output shows all three markets (moneyline / spread / total) in both American and decimal odds, with a relative "last updated" stamp. Pass `--json` for a single JSON envelope (suitable for piping into a script). On Ospex you set your own price — these reference odds are a sanity check, not a required match.

> **`show` vs `watch`**: `ospex odds show` is the user-facing one-shot snapshot — single round-trip, exits. `ospex odds watch` is the agent-facing streaming primitive — opens a Realtime channel, prints line-delimited JSON in `--json` mode, runs until SIGINT. Use `show` to decide a price; use `watch` to react to upstream odds moves over time.

Submit a commitment in domain language — pick a side, decimal odds, and decimal USDC risk:

```bash
# Moneyline, away side, 2.50 odds, $1 stake
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

# Spread, home side at -3.5, $25 stake at 1.91 odds, by --contest (line implicit
# from the unique speculation, or pass --line to lazy-create on first match)
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
  side:         San Diego Padres (home)  [positionType=Lower, scorer=0xd846…, source=nickname]
  odds:         2.50  [oddsTick=250]
  risk:         1.000000 USDC
  to win:       1.500000 USDC  (return = 2.500000 USDC)

Outcomes:
  Padres win    → you win 1.500000 USDC
  Cardinals win → you lose 1.000000 USDC

Submit? [Y/n]
```

Confirm with Enter (or `y`) and the CLI signs (one Foundry passphrase prompt, even if a USDC approval has to land first), posts the EIP-712 commitment, and prints the hash plus `status: open`.

**Flag conventions:**

- **`--side`** — team name, last-token nickname (`lakers`), or any alias (`LAL`) for moneyline / spread; `over` or `under` for total.
- **`--odds`** — decimal odds string. `2.50`, `1.91`, etc. The protocol bound is `1.01 ≤ odds ≤ 101.00`.
- **`--risk-usdc`** — decimal USDC string. `1`, `0.001`, `25`. Must be a multiple of `$0.0001` per the contract's lot-size rule.
- **`--line`** — selected-side displayed line for spread / total. `--side padres --line -3.5` means "Padres -3.5" regardless of whether Padres are home or away; the resolver inverts to the protocol's away-side ticks under the hood. **Omit for `--market moneyline`** — moneyline is line-less, and the SDK errors (`OspexValidationError: --line is not valid for moneyline markets`) if `--line` is passed there.
- **`--yes`** skips the confirmation prompt and signs/posts. **`--json`** is output-format only and pairs with `--yes`:
  - `--json` alone → emits `SubmitPreviewEnvelope` (preview only, **no signing**). Use case: an agent inspects the resolved tuple before deciding whether to commit.
  - `--yes --json` → signs/posts and emits `SubmitJsonResult` (preview + result).
  - Any non-interactive run that would sign without `--yes` errors out rather than hanging on a prompt.
- **`--approve-max`** opts into unlimited USDC approval when an approval is needed before signing. The default is to approve **exactly the required amount** for this submit — explicit and one-shot rather than open-ended. Pass `--approve-max` when you'd rather grant a single unlimited approval and avoid future approval prompts; the CLI surfaces the policy in the preview block before the prompt either way.

You can see your commitment on the orderbook (replace `<yourAddress>` with the address Foundry printed in step 2):

```bash
ospex commitments list --maker <yourAddress>
```

If you've piped scripts in mind: `ospex wallet address --json` emits machine-readable JSON on stdout (`{"address":"0x..."}`) while the passphrase prompt goes to stderr, so `ospex wallet address --json | jq -r .address` works cleanly.

### Advanced: `commitments submit-raw` (escape hatch)

If you already hold canonical protocol values (raw scorer address, lineTicks at 10× scale, oddsTick at 100× scale, `riskAmount` in wei6) — say from a market-maker bot or a debugging session — there's a positional escape hatch:

```bash
ospex commitments submit-raw 42 0xd846… 0 upper 250 1000
```

Same arguments mirror the on-chain `OspexCommitment` struct. No preview block, no resolver. Use the high-level form unless you have a specific reason not to.

## What's next

The CLI separates **one-shot user actions** (request → reply → exits) from **streaming / agent primitives** (subscribe → events → runs until SIGINT). Most day-to-day usage lives in the first table; the second is what an automated agent would build on.

### One-shot actions (user)

| Goal | Command |
|---|---|
| See current upstream reference odds for a contest | `ospex odds show <contestId>` |
| Take an open commitment as the counterparty | `ospex commitments match <hash>` |
| See your active and claimable positions | `ospex positions status <yourAddress>` |
| Cancel an open commitment off-chain | `ospex commitments cancel <hash>` |
| Cancel authoritatively on-chain | `ospex commitments cancel-onchain <hash>` |
| Bulk-cancel all your orders on a speculation | `ospex commitments cancel-all --contest-id <id> --scorer <addr> --line <ticks>` |
| Claim a winning position after settlement | `ospex claim <speculationId> --type upper\|lower` |
| Claim everything claimable for a wallet | `ospex claim-all` |
| Settle a scored speculation (permissionless) | `ospex settle <speculationId>` |

### Streaming / subscription (agent)

| Goal | Command |
|---|---|
| Subscribe to upstream odds changes (NDJSON in `--json` mode) | `ospex odds watch <contestId>` |

The full command reference is in the [README](../README.md).

## Creating a contest (advanced, mainnet-only)

Anyone can create a contest — the protocol is permissionless. It's not part of the typical betting flow, but if you want to seed your own market:

```bash
# 1. Find a game you'd like to make a contest for.
ospex games list --sport mlb --hours 24

# 2. Pick a row whose `creatable` column is `yes`. You can pass either
#    the gameId (the stable UUID) or the slug — the resolver accepts both.
ospex contests create --game-id <pasted-gameId>
ospex contests create --game stl-sd-2026-05-08      # alias: slug or UUID

# 3. (Optional) See the upstream reference odds for the contest you just
#    created. The writer populates current_odds within ~30s; you can use
#    these as a starting price when you submit the first commitment.
ospex odds show <contestId>
```

`--game` resolves a slug via `client.games.resolveGameId(input)`. The slug is mutable (the writer renames doubleheaders), so for anything you persist between sessions stick with `--game-id`. Multiple matches or no match fail closed.

`ospex contests create` waits for the Chainlink Functions verification callback by default and prints the new `contestId` only after `contestStatus=Verified` lands on chain (typically 10–30 s). Pass `--no-wait` if you'd rather get the txHash immediately and poll separately with `ospex contests wait-verified <contestId>` — useful for scripted flows.

It burns real LINK + a USDC fee on every call. The SDK pre-flights LINK→OracleModule and USDC→TreasuryModule allowances and prompts for them on demand. The three external IDs the contract requires (rundown / sportspage / jsonodds) are resolved server-side from the gameId; you never deal with them directly. Operator-side details on the M4 pipeline live in the SDK CLAUDE.md.

## Troubleshooting

**`No keystore found at <path>`** — neither `~/.ospex/config.json` has a `keystorePath` nor `OSPEX_KEYSTORE_PATH` is set, or one of them points at a missing file. Run `ospex init` and supply the path when prompted (it persists across shells). For a per-shell override use `export OSPEX_KEYSTORE_PATH=…` instead.

**`Failed to decrypt keystore`** — wrong passphrase, or the file is not a v3 keystore. Foundry always produces v3; this is almost always the passphrase.

**`OspexAllowanceError: insufficient allowance`** — `ospex commitments submit` (high-level) auto-approves exactly the required amount before signing, so this should be rare. Pass `--approve-max` to grant unlimited at the same step. For raw / scripted flows, run `ospex commitments approve <amount\|max>` separately. If you're creating contests, the LINK and USDC allowances target different modules (OracleModule and TreasuryModule, respectively); the CLI prompts on demand.

**`OspexChainError: <selector>`** — a transaction reverted. The selector usually decodes to a known contract error (e.g., `MatchingModule__NonceMustIncrease`). Read the printed reason; if unclear, file an issue with the tx hash.

**Public RPC errors / 401s** — you're using a public Polygon RPC. Switch to Alchemy / Infura / QuickNode in `ospex init`.
