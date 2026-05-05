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

One-time USDC approval to PositionModule. (This calls `approve(2^256-1)`; rerun with a smaller amount if you'd rather cap it.)

```bash
ospex commitments approve max
```

Find a contest and a speculation:

```bash
ospex contests list --hours 168
ospex speculations list --contest <contestId>
```

Submit:

```bash
ospex commitments submit \
  <contestId> \
  <scorerAddress> \
  <lineTicks> \
  <upper|lower> \
  <oddsTick> \
  <riskAmount>
```

Concrete example — moneyline scorer, line 0, betting upper at 2.50 odds, $0.001 USDC:

```bash
ospex commitments submit \
  0xab12... \
  0x2e6f... \
  0 upper 250 1000
```

Units:

- `riskAmount` — USDC has 6 decimals, so `1000` = $0.001 USDC.
- `oddsTick` — uses 2 decimal places, so `250` = 2.50.
- `lineTicks` — also 2-decimal; `0` for moneyline, signed for spread/total.

The CLI signs the EIP-712 commitment with your Foundry passphrase, POSTs it to the API, and prints the commitment hash plus `status: open`.

You can now see your commitment on the orderbook (replace `<yourAddress>` with the address Foundry printed in step 2):

```bash
ospex commitments list --maker <yourAddress>
```

If you've piped scripts in mind: `ospex wallet address --json` emits machine-readable JSON on stdout (`{"address":"0x..."}`) while the passphrase prompt goes to stderr, so `ospex wallet address --json | jq -r .address` works cleanly.

## What's next

| Goal | Command |
|---|---|
| Take an open commitment as the counterparty | `ospex commitments match <hash>` |
| See your active and claimable positions | `ospex positions status <yourAddress>` |
| Cancel an open commitment off-chain | `ospex commitments cancel <hash>` |
| Cancel authoritatively on-chain | `ospex commitments cancel-onchain <hash>` |
| Bulk-cancel all your orders on a speculation | `ospex commitments cancel-all --contest-id <id> --scorer <addr> --line <ticks>` |
| Stream live odds | `ospex odds watch <contestId>` |
| Claim a winning position after settlement | `ospex positions claim <contestId> <speculationId> <positionType>` |

The full command reference is in the [README](../README.md).

## Creating a contest (advanced, mainnet-only)

Anyone can create a contest — the protocol is permissionless. It's not part of the typical betting flow, but if you want to seed your own market:

```bash
ospex contests scripts                # Verify mainnet script approvals are reachable.
ospex contests create <args>          # Burns LINK + a USDC fee.
ospex contests wait-verified <id>     # Wait for the Chainlink Functions verification callback.
```

`ospex contests create --help` lists the inputs (rundown id, sportspage id, jsonodds id). Be aware that this burns real LINK on every call; the operator side of contest creation is documented further in the SDK CLAUDE.md.

## Troubleshooting

**`No keystore found at <path>`** — `OSPEX_KEYSTORE_PATH` isn't set, or it points at a file that doesn't exist. Re-export the variable in the same shell you're running `ospex` from.

**`Failed to decrypt keystore`** — wrong passphrase, or the file is not a v3 keystore. Foundry always produces v3; this is almost always the passphrase.

**`OspexAllowanceError: insufficient allowance`** — run `ospex commitments approve max` first. If you're creating contests, the LINK and USDC allowances target different modules (OracleModule and TreasuryModule, respectively); the CLI prompts on demand.

**`OspexChainError: <selector>`** — a transaction reverted. The selector usually decodes to a known contract error (e.g., `MatchingModule__NonceMustIncrease`). Read the printed reason; if unclear, file an issue with the tx hash.

**Public RPC errors / 401s** — you're using a public Polygon RPC. Switch to Alchemy / Infura / QuickNode in `ospex init`.
