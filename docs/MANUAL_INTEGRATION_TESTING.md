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
| 1.2 | `ospex contests list --sport nba --limit 5` | Up to 5 NBA contests with `speculations[]` arrays | `client.contests.list`. |
| 1.3 | `ospex contests show <contestId>` (pick one from 1.2) | Detail with `speculations[].orderbook` populated when commitments exist | `client.contests.get` + `fetchOpenCommitmentsByContestId` join. |
| 1.4 | `ospex speculations list --contest <contestId>` (use 1.2's id) | Bare speculation rows for that contest, each carrying `contestId` | `client.speculations.list`. |
| 1.5 | `ospex speculations show <speculationId>` (pick one from 1.4) | Single speculation with `orderbook[]` + 5-field parent `contest` block | `client.speculations.get`. |
| 1.6 | `ospex commitments list --limit 10` | Open + partially_filled rows; `riskAmount` printed as a string | List pagination + bigint serialization. |
| 1.7 | `ospex commitments list --speculation <speculationId>` (use 1.4's id) | Subset filtered to that speculation only | `--speculation` filter end-to-end (resolves speculation_key server-side). |
| 1.8 | `ospex commitments list --maker 0x… --status filled` | Subset for that maker | Multi-filter query path. |
| 1.9 | `ospex commitments show <hash>` (pick one from 1.6) | Single commitment row with all canonical fields | `client.commitments.get`. |
| 1.10 | `ospex positions list <address>` (pick a known active maker) | Position rows for the wallet | `client.positions.byAddress`. |
| 1.11 | `ospex positions status <address>` | Aggregate active vs. claimable totals | `client.positions.status`. |
| 1.12 | `ospex leaderboard show` | Top entries on the active leaderboard | `client.leaderboard.list`. |

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
| 3.1 | Pick a contest from `ospex contests list` whose `jsonoddsId` is non-null and start time is in the next 24h. | A contest id you can pass to `odds watch`. | — |
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
| 4.2 | `ospex commitments submit-raw <contestId> <scorerAddr> <lineTicks> upper 250 1000` | Prints commitment hash + `status: open` | Nonce-floor read + EIP-712 typed-data + sign + hash + POST + idempotency. (Raw form is used here because the test exercises the canonical-tuple surface directly; production users should prefer the high-level `submit`.) |
| 4.3 | `ospex commitments list --maker <walletA>` | Row appears with `status='open'` and the right risk/odds | Indexer-free read path. |
| 4.4 | Re-run 4.2 with **identical** inputs | Same commitment hash returned, no duplicate row | Server-side dedup on hash. |
| 4.5 | `ospex commitments cancel <hash>` | `{ ok: true }` | EIP-712 cancel typed-data + DELETE flow. |
| 4.6 | `ospex commitments list --maker <walletA>` | Row now `status='cancelled'` | Cancel propagation. |
| 4.7 | `ospex commitments cancel <hash>` again | `{ ok: true }` (idempotent) | API CAS guard. |

**Picking inputs for 4.2**: contest id from `ospex contests list --chain-id 80002` (assuming Amoy contests are seeded; otherwise ask ops to seed one). Scorer = one of the three Amoy scorer addresses (moneyline `0x2e6f…`, spread `0x0de8…`, total `0xac2e…`). `oddsTick=250` ⇒ 2.50 odds; `riskAmount=1000` ⇒ 0.001 USDC (lot-size aligned).

---

## Section 5 — M2 two-wallet match (Amoy)

The flow that proves funds actually move. Irreplaceable; this section is **non-negotiable** for an M2 release.

| # | Step | Expected | Validates |
|---|---|---|---|
| 5.1 | Both wallets A and B have allowance set (4.1 covered A; repeat for B). | Both `allowance` calls return `2^256-1` on Polygonscan. | Approve flow on a second wallet. |
| 5.2 | Wallet A: `ospex commitments submit-raw ...` (fresh inputs). Capture hash. | Hash printed. | Same as 4.2. |
| 5.3 | Wallet B: `ospex commitments match <hashFromA>` (or its 0x+8hex prefix) | Preview block prints to stderr with both `taker risks` and `maker fill` lines; prompt to confirm. After Y, if allowance was missing prompts to approve, prints both tx hashes; otherwise prints just the match tx hash. | Prefix resolution + `prepareMatch` preview + match math + tx broadcast. |
| 5.3a | Wallet B: `ospex commitments match <prefixFromA> --json` (no `--yes`) | Preview JSON envelope on stdout (`{ schemaVersion: 1, preview: {...} }`); no signer unlock, no tx. The "Resolved <prefix> → <fullHash>" echo (if prefix used) appears on stderr only — `... --json | jq .` parses cleanly. | `--json`-alone = preview-only contract. |
| 5.3b | Wallet B: `ospex commitments match <prefixFromA> --yes --json` | Result envelope on stdout (`{ schemaVersion: 1, preview: {...}, result: { txHash, status, blockNumber, takerRiskWei6, fillMakerRiskWei6 } }`). | `--yes --json` = execute + emit. |
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
| 6.1 | Wallet A submits a 1000-unit commitment at oddsTick=200 (2.00). | `ospex commitments submit-raw ... 200 1000` succeeds. | — |
| 6.2 | Wallet B: `ospex commitments match <hash> --risk-usdc 0.000400 --yes` | Match succeeds; `commitments list` shows `filled_risk_amount` of 400 wei6 = 0.000400 USDC (taker side risks 400 = (400×100)/(200-100) → makerFill 400, takerRisk 400). | Partial-fill math + indexer projection + `--risk-usdc` decimal parsing. |
| 6.3 | Wallet B again: `ospex commitments match <hash> --risk-usdc 0.000600 --yes` | Commitment now `filled`. | Remaining-capacity match. |
| 6.4 | `ospex commitments match <hash> --risk-usdc 0.000100 --yes` (any wallet) | SDK throws `OspexValidationError` ("commitment has no remaining capacity") OR contract reverts `CommitmentFullyFilled` and SDK surfaces `OspexChainError`. | Fully-filled guard. |

For other oddsTicks the math differs — work it through with `(takerDesired × 100 + (oddsTick - 100) - 1) / (oddsTick - 100)` to get the rounded maker fill.

---

## Section 6.5 — M2 match preview + lazy creation fee

Verifies the `commitments match` preview block, the lazy-creation-fee approval row, and the maker-allowance warning.

| # | Step | Expected | Validates |
|---|---|---|---|
| 6.5.1 | Wallet A: submit a fresh commitment on a contest where NO speculation exists yet at the chosen `(market, lineTicks)`. Capture hash. | `ospex commitments submit ...` succeeds. | Sets up a lazy-mode preview target. |
| 6.5.2 | Wallet B: `ospex commitments match <hash> --json` (no `--yes`) | JSON envelope on stdout. `preview.speculation.mode === 'lazy'`. `preview.approvals` has TWO entries — one `commitment-risk` (PositionModule) and one `lazy-creation-fee` (TreasuryModule). `preview.speculation.lazyCreation.takerShareWei6` equals one half of the total fee (250000n on Polygon mainnet/Amoy). | Lazy detection + lazy-creation-fee approval row + per-side fee math. |
| 6.5.3 | Wallet A: `ospex commitments match <hashFromOwnSubmit> --json` (self-match attempt) | `preview.selfMatch === true`; `preview.warnings` includes `'self-match'`. `preview.speculation.lazyCreation.takerShareWei6` equals the FULL fee (500000n) — same wallet pays both halves of `TreasuryModule.processSplitFee`. | Self-match flag + full-fee allowance for the same-wallet case. |
| 6.5.4 | Revoke wallet A's TreasuryModule allowance to 0 (`ospex commitments approve 0` against TreasuryModule, or via Polygonscan write-contract). Then Wallet B: `ospex commitments match <hashFromA> --json` | `preview.warnings` includes `'maker-treasury-allowance-insufficient'`; `preview.speculation.lazyCreation.makerTreasuryAllowanceSufficient === false`. The renderer prints "⚠ maker's TreasuryModule allowance ... below the maker's share". | Maker-allowance warning surfaces before signing so the taker doesn't waste gas on a guaranteed revert. |
| 6.5.5 | Match wallet B's commitment (full fill) so the speculation is now created. Then Wallet A submits a new commitment on the SAME `(market, lineTicks)` and Wallet B previews `--json`. | `preview.speculation.mode === 'existing'`; `preview.approvals` has ONLY ONE entry (`commitment-risk`); no lazy creation fee row. | Existing-mode detection after the spec is created on chain. |
| 6.5.6 | `echo "" \| ospex commitments match <hash>` (non-TTY without `--yes`) | Errors out with "--yes is required for non-interactive write commands"; no signer unlock, no tx. | Non-TTY refusal contract. |
| 6.5.7 | `ospex commitments match 0x` and `ospex commitments match 0xabc` | "prefix must be 0x followed by at least 8 hex chars" error. | Min-prefix-length validation. |
| 6.5.8 | Two open commitments share the same first 8 hex chars (rare but defensive — to test, find any two with overlapping prefix or list filtered to wallet A). `ospex commitments match <sharedPrefix>`. | "ambiguous prefix `<input>`; matches `<hashA>`, `<hashB>`" error listing both candidate full hashes. | Ambiguity detection. |

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

## Section 9 — M3 settle + claim flow

Verifies position lifecycle: `settleSpeculation` (permissionless) followed by `claimPosition` (permissioned to the holder, but no allowance needed — payout flows OUT of PositionModule, never in).

This section needs an actual settled-or-pending-settle position on Amoy (or a previously matched position whose contest has been scored). Two cases:

**Case A — A pendingSettle position already exists for your wallet.**

| # | Command | Expected | Validates |
|---|---|---|---|
| 9A.1 | `ospex positions status <walletA>` | `pendingSettle` count ≥ 1; predicted `result` and payout shown | Three-bucket categorization. |
| 9A.2 | `ospex claim-all --address <walletA> --dry-run` | Action plan prints with `would settle + claim` rows, total predicted payout summed | Dry-run path; multi-step txParams parse. |
| 9A.3 | `ospex claim-all --address <walletA>` | Per-row `[i/N] ✓ ... → payout $X.YZ (txs: ..., winSide=...)` | Live execution; settle then claim per entry. |
| 9A.4 | `ospex positions status <walletA>` | `pendingSettle` count = 0; `claimable` count = 0; just-claimed rows now show `claimed=true` in `ospex positions list` | Indexer projection of POSITION_CLAIMED. |
| 9A.5 | `cast call <PositionModule> "getPosition(uint256,address,uint8)(...)" <speculationId> <walletA> <positionType> --rpc-url <rpcUrl>` | `claimed=true` | Contract state matches Supabase. |

**Case B — Need to create a pendingSettle position from scratch.**

Requires the contest to be `Verified` and have `start_time` already in the past so `scoreContestFromOracle` is callable. The full create→submit→match→score→settle→claim cycle depends on contest creation (M4) and operator scoring access. If you have neither, document the run as "manual verification deferred" in the release ticket and revisit on the next operator scoring cycle.

For partial verification right now:

1. Use M2 to set up a matched position on a contest that is already scored on-chain. Confirm via `ospex contests show <contestId>` that the contest's `status` is `'scored'`.
2. Run 9A.2 then 9A.3.
3. If the speculation is already settled, the entry will appear in the `claimable` bucket instead of `pendingSettle` — same flow, single tx per entry.

**Standalone settle command** (separate from claim-all):

| # | Command | Expected | Validates |
|---|---|---|---|
| 9C.1 | `ospex settle <speculationId>` | Prints `txHash` + resolved `winSide` (`away \| home \| over \| under \| push \| void`) | `client.positions.settleSpeculation` end-to-end including event-log decode. |
| 9C.2 | Re-run 9C.1 with the same speculationId | `OspexChainError` with revert reason `AlreadySettled` | Idempotency / reversion handling. |

**Standalone single claim** (when you don't want claim-all to sweep everything):

| # | Command | Expected | Validates |
|---|---|---|---|
| 9D.1 | `ospex claim <speculationId> --type upper` (against a settled position you actually own and won) | Prints `txHash` + `payoutUSDC` | `client.positions.claim` end-to-end. |
| 9D.2 | Re-run 9D.1 | `OspexChainError` mentioning `AlreadyClaimed` | Already-claimed guard. |
| 9D.3 | `ospex claim <speculationIdNotYetSettled> --type upper` | CLI prints "This position requires settlement first. Run `ospex settle ...`" then surfaces `OspexChainError` (`NotSettled`) | Clear error path, no auto-settle. |

**Pass criterion**: at least one real settle + claim was executed end-to-end on Amoy via `ospex claim-all` (Case A or B), and the resulting `claimed=true` row is visible in Supabase via `ospex positions list <walletA>` plus on-chain via `cast call`. If no settled position exists at release time, this section is allowed to be marked "manual verification required at first real settlement" in the release ticket — the dry-run path (9A.2) can be exercised independently.

---

## Section 10 — M2.5 on-chain cancel (mainnet or Amoy)

Validates `commitments.cancelOnchain`, `commitments.raiseMinNonce`, `commitments.cancelAllOnSpeculation`, and `commitments.getNonceFloor`. The contract has no `AlreadyCancelled` revert path, so re-cancelling is a *success* — that's a deliberate observation point in 10.4.

Prereq: a funded test wallet (gas + a few USDC for the submits) on the chosen network. Mainnet contract addresses are in `packages/sdk/src/contracts/addresses.ts`; Amoy uses the same surface so the section runs on either.

| # | Step | Expected | Validates |
|---|---|---|---|
| 10.1 | `ospex commitments submit-raw <contestId> <scorer> <line> upper 250 1000` (any open speculation) — record the printed hash. | `hash`, `status='open'`. | M2 submit (smoke). |
| 10.2 | `ospex commitments cancel-onchain <hash>` | `txHash` printed; Polygonscan link; receipt status success. | `cancelOnchain` happy path. |
| 10.3 | `ospex commitments show <hash>` (poll up to 30s) | `status: cancelled`. | Indexer `COMMITMENT_CANCELLED` projection latency. |
| 10.4 | `ospex commitments cancel-onchain <hash>` (second time, same hash) | tx **succeeds** again — no `AlreadyCancelled` revert. | Idempotency expectation documented in `cancelOnchain` jsdoc. |
| 10.5 | Submit a second commitment, get it partially matched (use 5.x flow with a taker). Then `cancel-onchain <hash>`. | tx success; row eventually shows `status='cancelled'` while `filled_risk_amount > 0` is preserved. | Asymmetry between cancel and partial fill — contract is the arbiter. |
| 10.6 | Have a second wallet attempt `cancel-onchain <hash>` against the original wallet's commitment. | `OspexChainError` with `reason: 'NotCommitmentMaker'`; no gas wasted (estimate fails). | `NotCommitmentMaker` selector → typed `reason`. |
| 10.7 | Submit ≥2 commitments on the same speculation. Run `ospex commitments cancel-all --contest-id <id> --scorer <addr> --line <ticks> --dry-run`. | `invalidatedCount` matches the number of open rows. No tx sent. | Dry-run path + speculationKey filter. |
| 10.8 | Run 10.7 without `--dry-run`. | tx succeeds; `MinNonceUpdated` event in receipt; both rows show `nonceInvalidated=true` within 30s; `status` stays `'open'`. | `cancelAllOnSpeculation` end-to-end + indexer `nonce_invalidated` projection. |
| 10.9 | Run `cancel-all` again, this time passing `--new-min-nonce <n>` where `n` ≤ the floor printed by 10.10 (or the `newMinNonce` returned by 10.8). | `OspexChainError` with `reason: 'NonceMustIncrease'`. | `NonceMustIncrease` mapping. The default-path computation auto-bumps the floor by 1 every run, so the explicit override is needed to deterministically hit this revert. |
| 10.10 | `ospex commitments nonce-floor --maker <addr> --contest-id <id> --scorer <addr> --line <ticks>` | Prints the post-10.8 newMinNonce as `minNonce`. | `getNonceFloor` read utility. |
| 10.11 | Submit a fresh commitment, then `ospex commitments cancel <hash> --also-onchain`. | DELETE returns `200`; on-chain cancel emits `CommitmentCancelled`; `status='cancelled'`. | Composed off-chain + on-chain cancel — recommended pattern from `CANCEL_FLOW.md`. |

**Pass criterion**: 10.1–10.4, 10.7–10.10, and 10.11 succeed end-to-end. 10.5 (partial-fill cancel) and 10.6 (third-party reject) require additional wallets / takers — defer to "manual verification at next two-wallet test cycle" in the release ticket if not feasible at PR time.

A read-only automated smoke for `getNonceFloor` lives at `packages/sdk/tests/integration/onchain-cancel.test.ts` and runs under `OSPEX_INTEGRATION=1` with `OSPEX_TEST_RPC_URL`. Set `OSPEX_TEST_PRIVATE_KEY` + `OSPEX_TEST_LIVE_HASH` to additionally run 10.2 and 10.4 automatically.

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
[ ] Section 9 — M3 settle + claim (or manual-verification-deferred note)
[ ] Section 10 — M2.5 on-chain cancel (10.5 / 10.6 may defer to two-wallet cycle)
[ ] Section 8 — Cross-version smoke (post-publish only)

Operator: ____________
Date:     ____________
```

Skipping any section other than 8 (which only applies post-publish) requires a written exception in the release ticket. Section 5 is non-negotiable.
