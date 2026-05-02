# Manual integration testing — `@ospex/sdk` + `@ospex/cli`

The canonical pre-release validation for the SDK + CLI. Walk every section in order before tagging an M2 release; total runtime is 15-20 minutes. Each section names a prerequisite, a command, the expected output, and what to investigate if it fails.

Why manual: the integration surface spans on-chain testnet state, JsonOdds writes, and Supabase Realtime — three external systems whose state we don't own. A scripted suite that "passes" while one is degraded is worse than no suite. This playbook is also exactly what a third-party SDK consumer would use to verify their own setup.

A vitest harness lives at `packages/sdk/tests/integration/` (gated behind `OSPEX_INTEGRATION=1`) for regression-checking after a chain client refactor. It mirrors the *automatable* subset (chain ops only — no Realtime, no JsonOdds dependence). It is **not** a substitute for this playbook.

## Prereqs (one-time)

1. Build:
   ```bash
   yarn install
   yarn workspace @ospex/sdk build
   yarn workspace @ospex/cli build
   ```
   Either `yarn workspace @ospex/cli link` once, or invoke as `node packages/cli/dist/index.js <cmd>` throughout this doc.

2. Configure `~/.ospex/config.json` via `ospex init`:
   - `apiUrl` defaults to production.
   - **`rpcUrl` is required.** Use Alchemy / Infura / QuickNode for the test network. Public RPCs (`polygon-rpc.com`, `rpc-amoy.polygon.technology`) flake mid-test and `polygon-rpc.com` returns 401 since 2026-03.
   - `chainId`: `137` for mainnet, `80002` for Amoy. Sections 4-8 assume Amoy.

3. For the two-wallet match (Section 5): two funded Amoy wallets.
   - Each needs POL for gas (Polygon faucet).
   - Each needs mock USDC (mock token at `0xB1D1c0A8Cc8BB165b34735972E798f64A785eaF8`). If a public faucet/mint isn't exposed for that token, ask ops to seed the wallets.

4. Have `cast` (Foundry) installed for the on-chain validation queries in Section 5.

---

## Section 1 — M1 reads (no signer, no chain)

All read endpoints. Run against the prod core-api by default; override with `OSPEX_API_URL` if testing a staging deployment.

| # | Command | Expected | Validates |
|---|---|---|---|
| 1.1 | `ospex health` | `ok: true` plus a status object | API reachability + SDK transport. |
| 1.2 | `ospex markets list --sport nba --limit 5` | Up to 5 NBA contests with `speculations[]` arrays | `client.markets.list`. |
| 1.3 | `ospex markets show <contestId>` (pick one from 1.2) | Detail with `speculations[].orderbook` populated when commitments exist | `markets.get` + `fetchOpenCommitmentsByContestId` join. |
| 1.4 | `ospex commitments list --limit 10` | Open + partially_filled rows; `riskAmount` printed as a string | List pagination + bigint serialization. |
| 1.5 | `ospex commitments list --maker 0x… --status filled` | Subset for that maker | Multi-filter query path. |
| 1.6 | `ospex positions list <address>` (pick a known active maker) | Position rows for the wallet | `client.positions.byAddress`. |
| 1.7 | `ospex positions status <address>` | Aggregate active vs. claimable totals | `client.positions.status`. |
| 1.8 | `ospex leaderboard show` | Top entries on the active leaderboard | `client.leaderboard.list`. |

**Pass criterion**: every command returns 0, output is well-formed, and the `--json` variant is parseable JSON.

---

## Section 2 — M1 wallet lifecycle

Use a **fresh, throwaway test private key** — never a mainnet key.

| # | Command | Expected | Validates |
|---|---|---|---|
| 2.1 | `ospex wallet import` (paste fresh test key) | `~/.ospex/keystore.json` created (mode 0600) | `KeystoreSigner.encrypt`. |
| 2.2 | `ospex wallet address` | The address corresponding to the imported key | Keystore decrypts to the same key. |
| 2.3 | `ospex wallet unlock` (enter passphrase) | Exit 0; `~/.ospex/session` exists with mode 0600 | Session-cache write path. |
| 2.4 | `ospex wallet address` (no prompt this time) | Same address as 2.2 | Session reuse. |
| 2.5 | Wait 16 minutes OR `rm ~/.ospex/session`, then `ospex wallet address` | Prompts for passphrase | Session expiry. |
| 2.6 | `ospex wallet lock` | `~/.ospex/session` removed | Session teardown. |

Do NOT run `ospex wallet unlock` on a shared / multi-user host — mode 0600 only blocks *other users*; same-user processes can still read it.

---

## Section 3 — M1 Realtime odds

| # | Step | Expected | Validates |
|---|---|---|---|
| 3.1 | Pick a contest from `ospex markets list` whose `jsonoddsId` is non-null and start time is in the next 24h. | A contest id you can pass to `odds watch`. | — |
| 3.2 | `ospex odds watch <contestId>` | Within ~30s, see at least one `current_odds` event print. | `/v1/config/public` bootstrap + lazy Supabase client + channel subscription + payload routing. |
| 3.3 | Ctrl-C | Exits cleanly with no hanging promise. | Channel unsubscribe path. |
| 3.4 | `ospex odds watch <invalid-id>` | Channel opens, no events arrive, no error. | Documents expected silence vs. failure. |

If 3.2 produces nothing in 60s, check JsonOdds health and Supabase Realtime status before assuming a regression.

---

## Section 4 — M2 single-wallet chain ops (Amoy)

Wallet A only. Verifies `approve` + `submit` + off-chain `cancel` end-to-end before introducing a second wallet.

| # | Command | Expected | Validates |
|---|---|---|---|
| 4.1 | `ospex commitments approve max` | tx submitted, receipt confirmed; verify on Amoy Polygonscan that `allowance(walletA, PositionModule)` is `2^256-1` | Signer + chain client + ERC20 ABI + USDC + PositionModule address resolution. |
| 4.2 | `ospex commitments submit <contestId> <scorerAddr> <lineTicks> upper 250 1000` | Prints commitment hash + `status: open` | Nonce-floor read + EIP-712 typed-data + sign + hash + POST + idempotency. |
| 4.3 | `ospex commitments list --maker <walletA>` | Row appears with `status='open'` and the right risk/odds | Indexer-free read path. |
| 4.4 | Re-run 4.2 with **identical** inputs | Same commitment hash returned, no duplicate row | Server-side dedup on hash. |
| 4.5 | `ospex commitments cancel <hash>` | `{ ok: true }` | EIP-712 cancel typed-data + DELETE flow. |
| 4.6 | `ospex commitments list --maker <walletA>` | Row now `status='cancelled'` | Cancel propagation. |
| 4.7 | `ospex commitments cancel <hash>` again | `{ ok: true }` (idempotent) | API CAS guard. |

**Picking inputs for 4.2**: contest id from `ospex markets list --chain-id 80002` (assuming Amoy contests are seeded; otherwise ask ops to seed one). Scorer = one of the three Amoy scorer addresses (moneyline `0x2e6f…`, spread `0x0de8…`, total `0xac2e…`). `oddsTick=250` ⇒ 2.50 odds; `riskAmount=1000` ⇒ 0.001 USDC (lot-size aligned).

---

## Section 5 — M2 two-wallet match (Amoy)

The flow that proves funds actually move. Irreplaceable; this section is **non-negotiable** for an M2 release.

| # | Step | Expected | Validates |
|---|---|---|---|
| 5.1 | Both wallets A and B have allowance set (4.1 covered A; repeat for B). | Both `allowance` calls return `2^256-1` on Polygonscan. | Approve flow on a second wallet. |
| 5.2 | Wallet A: `ospex commitments submit ...` (fresh inputs). Capture hash. | Hash printed. | Same as 4.2. |
| 5.3 | Wallet B: `ospex commitments match <hashFromA>` | If allowance was missing, prompts to approve, prints both tx hashes; otherwise prints just the match tx hash. | `commitments.get(hash)` + match math + tx broadcast. |
| 5.4 | `cast call <MatchingModuleAmoy> "s_filledRisk(bytes32)(uint256)" <hashFromA> --rpc-url <rpcUrl>` | Non-zero, equal to `fillMakerRisk` from the match tx | Contract observed the fill. |
| 5.5 | `cast call <PositionModuleAmoy> "getPosition(uint256,address,uint8)(uint256,uint256,address,uint32,bool,uint8)" <speculationId> <walletA> <makerPositionType> --rpc-url <rpcUrl>` (verify exact signature against `IPositionModule.sol`) | Position with `riskAmount = fillMakerRisk` | Maker side recorded. |
| 5.6 | Same as 5.5 for wallet B with the **opposite** `positionType` | Position with `riskAmount = takerRisk` | Taker side recorded. |
| 5.7 | `ospex commitments list --maker <walletA>` | Row now `status='partially_filled'` (or `'filled'` if 5.3 took it all) and `filled_risk_amount` updated | Indexer projected the event (allow ~30s). |
| 5.8 | `ospex positions status <walletB>` | Reflects the new position. | `positions.status` post-match. |

**JSON-RPC success alone does NOT count.** All four of 5.4–5.7 must hold. Addresses to use:
- Amoy MatchingModule: `0x36bc5693ee30cd65f8dce51bd48bc03815091a26`
- Amoy PositionModule: `0xb7e1c99bb4490be17c9bf4003c0ada6b3b3c6480`

---

## Section 6 — M2 partial fill + remaining-capacity match

Verifies the SDK's takerRisk math against the contract's revert-or-exact-fill rule (MatchingModule.sol:268-270).

| # | Step | Expected | Validates |
|---|---|---|---|
| 6.1 | Wallet A submits a 1000-unit commitment at oddsTick=200 (2.00). | `ospex commitments submit ... 200 1000` succeeds. | — |
| 6.2 | Wallet B: `ospex commitments match <hash> --risk 400` | Match succeeds; `commitments list` shows `filled_risk_amount` of 400 (taker side risks 400 = (400×100)/(200-100) → makerFill 400, takerRisk 400). | Partial-fill math + indexer projection. |
| 6.3 | Wallet B again: `ospex commitments match <hash> --risk 600` | Commitment now `filled`. | Remaining-capacity match. |
| 6.4 | `ospex commitments match <hash> --risk 100` (any wallet) | SDK throws `OspexValidationError` ("commitment has no remaining capacity") OR contract reverts `CommitmentFullyFilled` and SDK surfaces `OspexChainError`. | Fully-filled guard. |

For other oddsTicks the math differs — work it through with `(takerDesired × 100 + (oddsTick - 100) - 1) / (oddsTick - 100)` to get the rounded maker fill.

---

## Section 7 — Failure mode catalog (exercised, not just listed)

Deliberately trigger each error so the typed errors surface correctly through CLI text.

| # | Trigger | Expected error | Code |
|---|---|---|---|
| 7.1 | Submit without `rpcUrl` configured (`OSPEX_RPC_URL=` and remove from config.json) | "rpcUrl required for write operations" | `OspexConfigError` (CONFIG_ERROR) |
| 7.2 | Submit without sufficient USDC allowance | Structured allowance block printed; CLI prompts to approve | `OspexAllowanceError` (ALLOWANCE_INSUFFICIENT) |
| 7.3 | Submit with `--expiry` 1+ year in the future | "expiry is more than 1 year in the future" | `OspexValidationError` (or core-api `INVALID_PARAM` if it slips past local validation) |
| 7.4 | Match a hash that doesn't exist (random 32-byte value) | "Commitment 0x… not found." | `OspexAPIError` (status 404) |
| 7.5 | Match a fully-filled commitment | Contract revert wrapped as a readable message | `OspexChainError` (CHAIN_ERROR) |
| 7.6 | Cancel a hash whose commitment is `filled` | "Commitment is filled; off-chain cancel is not allowed once a match exists." | `OspexAPIError` (status 409, apiCode COMMITMENT_MATCHED) |

The error code is in `error (CODE): message` format — confirm both the message AND the code match expectations.

---

## Section 8 — Cross-version smoke (after npm publish only)

For when the SDK actually ships to npm. Run from a fresh shell with no SDK in `node_modules`:

```bash
mv ~/.ospex ~/.ospex.bak    # so we can verify init from scratch
npx @ospex/cli@latest health
npx @ospex/cli@latest init
# ...walk Sections 1.1, 1.2, 4.1, 4.2 from a fresh ~/.ospex
mv ~/.ospex.bak ~/.ospex     # restore
```

Catches missing `files` entries in `package.json`, ESM/CJS interop bugs, missing JSON artifact in `dist`, etc.

---

## Pass / fail checklist

Copy this into the release ticket:

```
[ ] Section 1 — Reads
[ ] Section 2 — Wallet lifecycle
[ ] Section 3 — Realtime odds
[ ] Section 4 — Single-wallet chain ops (Amoy)
[ ] Section 5 — Two-wallet match (Amoy) — NON-NEGOTIABLE
[ ] Section 6 — Partial fill
[ ] Section 7 — Failure modes
[ ] Section 8 — Cross-version smoke (post-publish only)

Operator: ____________
Date:     ____________
```

Skipping any section other than 8 (which only applies post-publish) requires a written exception in the release ticket. Section 5 is non-negotiable.
