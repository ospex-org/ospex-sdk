/**
 * `commitments.checkCommitmentFillability(args)` — an advisory, read-only
 * preflight answering "can a taker fill THIS commitment right now?" without
 * sending a transaction.
 *
 * Why it exists: a signed commitment can be visible, validly signed, unexpired,
 * and uncancelled, yet still revert at fill time because the maker (or taker)
 * moved USDC or dropped their PositionModule allowance. `matchFromPreview`
 * already re-checks liveness + the *taker's* approval rows before sending, but
 * it reads no balances and never proves the *maker's* PositionModule
 * allowance. This helper closes that gap and packages the verdict as a
 * structured advisory result — mirroring the `ensure*` family: a discriminated
 * `outcome`, fields present only when meaningful, and never a fabricated value.
 *
 * It is ADVISORY: "fillable now, based on the latest reads" — never a
 * guarantee. Balances/allowances can change between this read and the fill.
 *
 * AGGREGATE DEBIT MODEL (the load-bearing detail). `PositionModule.recordFill`
 * pulls USDC from BOTH sides via two separate transfers (maker: `fillMakerRisk`,
 * taker: `takerRisk`); when the speculation doesn't exist yet, a TreasuryModule
 * creation-fee is also pulled from each side. Independent per-side checks are
 * UNSAFE on a self-match (maker === taker): a 15-USDC wallet passes
 * `balance ≥ makerRisk` and `balance ≥ takerRisk` separately yet cannot cover
 * the 20-USDC combined debit. So every transfer is modelled as a debit row and
 * aggregated:
 *   - balance requirement   = Σ amount by (account)            [token is USDC]
 *   - allowance requirement = Σ amount by (account, spender)
 * A self-match collapses maker/taker into one account, so the combined debit is
 * checked correctly; the lazy creation fee folds into both totals.
 *
 * Resolution:
 *   1. Liveness from the fetched commitment (no chain read) — keyed off
 *      `storedStatus`/nonce/expiry/remaining, exactly `Commitment.isLive`. A
 *      dead order short-circuits to `not-fillable` with the specific reason(s).
 *   2. Price the fill via `prepareMatch` — reused for the lot-size math,
 *      self-match doubling, the lazy-fee split, and the closed-speculation
 *      check.
 *   3. Read the aggregate balance + allowance requirements on chain (including
 *      the maker → PositionModule allowance `prepareMatch` omits). A read that
 *      FAILS degrades to `unknown`, never a false `not-fillable` — a definite
 *      shortfall from a successful read still wins (we have proof it won't fill).
 *
 * Read-only: pass `taker` for a fully signer-free check (the recommended path
 * for agents). If omitted, the configured signer's address is used (which may
 * prompt for a Foundry passphrase). Requires an `rpcUrl` — throws
 * `OspexConfigError` otherwise.
 */

import type { PublicClient } from 'viem';
import { OspexAPIError, OspexConfigError, OspexValidationError } from '../errors.js';
import { commitmentLineTicksOutOfRange } from './validation.js';
import { readAllowance } from './allowance.js';
import { prepareMatch, type PrepareMatchArgs } from './prepareMatch.js';
import { erc20Abi } from '../contracts/abi/erc20.js';
import { CommitmentsApi } from '../api/commitments.js';
import type { CommitmentsContext } from './context.js';
import type { Commitment, PublicVisibleCommitment } from '../types/commitment.js';
import type { MatchPreview } from '../types/matchPreview.js';
import type { Hex } from '../types/signer.js';

export interface CheckCommitmentFillabilityArgs {
  /**
   * The commitment's full EIP-712 hash (fetched via `/v1/commitments/:hash`)
   * OR a pre-fetched `Commitment` (avoids the round trip when you already hold
   * the row). Pass exactly one.
   */
  hash?: Hex;
  commitment?: Commitment;
  /**
   * Taker's desired fill risk in USDC wei6. Defaults to the commitment's full
   * remaining capacity; clamped to it. An explicit value that can't form a
   * valid lot throws `OspexValidationError` (it's a caller-supplied size, not
   * a property of the order).
   */
  takerDesiredRiskWei6?: bigint;
  /**
   * Prospective taker address. Pass it for a fully read-only check (no signer
   * needed). When omitted, the configured signer's address is used (which may
   * prompt for a Foundry passphrase).
   */
  taker?: Hex;
}

export type FillabilityOutcome =
  /** Every checked requirement is satisfied at `checkedAtBlock`. */
  | 'fillable'
  /** A definite liveness or funding shortfall was found. */
  | 'not-fillable'
  /** A required on-chain read failed and nothing else was definitively short —
   * the verdict can't be asserted either way. */
  | 'unknown';

export type FillabilityReasonCode =
  // Funding (aggregate, USDC):
  | 'MAKER_USDC_BALANCE_INSUFFICIENT'
  | 'TAKER_USDC_BALANCE_INSUFFICIENT'
  | 'MAKER_POSITION_ALLOWANCE_INSUFFICIENT'
  | 'TAKER_POSITION_ALLOWANCE_INSUFFICIENT'
  | 'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT'
  | 'TAKER_TREASURY_ALLOWANCE_INSUFFICIENT'
  // Liveness / matchability:
  | 'NOT_LIVE'
  | 'EXPIRED'
  | 'NONCE_INVALIDATED'
  | 'NO_REMAINING_CAPACITY'
  | 'SPECULATION_CLOSED'
  /**
   * The commitment's `|lineTicks|` exceeds the protocol magnitude bound
   * (`MAX_LINE_TICKS`). A line this large overflows the spread scorer, so once
   * the contest is scored settlement reverts forever and BOTH sides' escrowed
   * USDC are permanently locked with no recovery. Filling it would lock the
   * taker's own funds — so it is definitively `not-fillable` for everyone,
   * independent of any balance/allowance. A property of the signed commitment,
   * decided with no chain read.
   */
  | 'LINE_TICKS_OUT_OF_RANGE'
  /**
   * The maker pulled the commitment off the public book (`book_visible=false`)
   * and the matchable payload (signature/nonce/odds/risk) is redacted from
   * anonymous reads per own-state SSE plan §2.3. An anonymous caller has no
   * path to fill the row — the maker recovers the payload via owner-auth
   * `client.ownState.snapshot({address, cursor?})` (returns ONE page; drain
   * via cursor loop while truncated:true) or
   * `client.ownState.getCommitment({address, hash})` for a single-row
   * snapshot-scope lookup.
   */
  | 'COMMITMENT_REDACTED'
  // Degraded:
  | 'FILLABILITY_UNKNOWN';

export interface FillabilityReason {
  code: FillabilityReasonCode;
  /**
   * Which party the shortfall is on. Absent for liveness reasons. On a
   * self-match (maker === taker) the single wallet is reported as `'maker'`,
   * and `requiredWei6` is the combined debit.
   */
  account?: 'maker' | 'taker';
  /** The ERC-20 token (USDC) the requirement is denominated in. Funding only. */
  token?: Hex;
  /**
   * The spender the allowance requirement targets (PositionModule or
   * TreasuryModule). Allowance reasons only.
   */
  spender?: Hex;
  /**
   * Aggregate required amount (wei6) for this (account[, spender]) — sums the
   * self-match and lazy-fee debits. Funding reasons only.
   */
  requiredWei6?: bigint;
  /** Current on-chain amount (wei6) that was read. Funding reasons only. */
  actualWei6?: bigint;
}

export interface FillabilityFill {
  /** Maker-side USDC pulled for this fill (`recordFill` transfer #1). */
  makerRiskWei6: bigint;
  /** Taker-side USDC pulled for this fill (`recordFill` transfer #2). */
  takerRiskWei6: bigint;
  /** True iff maker === taker — the combined debit is checked on one wallet. */
  selfMatch: boolean;
}

export interface CheckCommitmentFillabilityResult {
  commitmentHash: string;
  /** Convenience flag — `outcome === 'fillable'`. */
  fillableNow: boolean;
  outcome: FillabilityOutcome;
  /** Always true — this is a point-in-time advisory, never a guarantee. */
  advisory: true;
  /**
   * Block at which balances/allowances were read. Present only when funding was
   * evaluated on-chain — absent on a liveness-only short-circuit (that verdict
   * comes from the fetched commitment row, not a chain read).
   */
  checkedAtBlock?: bigint;
  /**
   * The fill the verdict was priced for. Present once amounts were computed —
   * absent on a liveness-only short-circuit.
   */
  fill?: FillabilityFill;
  reasons: FillabilityReason[];
}

export async function checkCommitmentFillability(
  ctx: CommitmentsContext,
  args: CheckCommitmentFillabilityArgs,
): Promise<CheckCommitmentFillabilityResult> {
  // ── 0. Redaction short-circuit (no chain or address access) ────────
  // A book-hidden body has no signature / nonce / odds / risk in the public
  // surface (own-state SSE plan §2.3 allow-list, locked). An anonymous caller
  // has no fill path against it regardless of funding, so the verdict is
  // definitively `not-fillable` for this audience without ANY chain read or
  // RPC dependency — so the resolve-and-check pair runs BEFORE
  // `requireChainClient` / `getAddresses` are touched. That keeps the
  // public no-chain-read contract honest for callers without an RPC config
  // (the result is still produced and an `OspexConfigError` is never raised
  // ahead of the redaction verdict).
  const resolved = await resolveCommitment(ctx, args);
  const commitmentHash = resolved.commitmentHash;
  if (resolved.redacted === true) {
    return result({
      commitmentHash,
      outcome: 'not-fillable',
      reasons: [{ code: 'COMMITMENT_REDACTED' }],
    });
  }
  const commitment: PublicVisibleCommitment = resolved;

  // ── 0b. Line-magnitude short-circuit (no chain or address access) ──
  // An out-of-range `|lineTicks|` overflows the spread scorer and permanently
  // locks both sides' escrow at settlement — so the row is definitively
  // not-fillable for ANY taker, independent of funding. Like the redaction
  // short-circuit this is a property of the SIGNED commitment (no chain read),
  // so resolve it BEFORE `requireChainClient` / `getAddresses` — the verdict is
  // produced even for callers without an RPC config, and an `OspexConfigError`
  // is never raised ahead of it. `lineTicks` may be null on the public row
  // (e.g. a malformed body); a null is left to the pricing step's
  // missing-field handling below (surfaces as NOT_LIVE).
  if (commitment.lineTicks !== null && commitmentLineTicksOutOfRange(commitment.lineTicks)) {
    return result({
      commitmentHash,
      outcome: 'not-fillable',
      reasons: [{ code: 'LINE_TICKS_OUT_OF_RANGE' }],
    });
  }

  // Fillability is fundamentally a chain-read feature from here on. Surface a
  // missing-rpcUrl config error immediately (consistent with the `ensure*`
  // primitives), rather than partway through after a liveness short-circuit
  // that might have answered without an RPC.
  const publicClient = ctx.requireChainClient();
  const addresses = ctx.getAddresses();
  const usdc = (addresses.usdc as string).toLowerCase() as Hex;
  const positionModule = (addresses.positionModule as string).toLowerCase() as Hex;
  const treasuryModule = (addresses.treasuryModule as string).toLowerCase() as Hex;

  // ── 1. Liveness (no chain read) ───────────────────────────────────
  // Re-derive matchability FRESH from the commitment's fields rather than
  // trusting the API's snapshot `isLive` flag — that flag is computed at decode
  // time, so a row fetched just before its expiry would carry a stale
  // `isLive: true`. We check the same preconditions `matchCommitment` enforces,
  // keyed off `storedStatus` — for a visible row that's the trustworthy
  // on-chain matchability signal. (The hidden case was already short-circuited
  // above; we'd never reach here on a redacted body.) A dead order
  // short-circuits before any chain read.
  const liveness = livenessReasons(commitment);
  if (liveness.length > 0) {
    return result({ commitmentHash, outcome: 'not-fillable', reasons: liveness });
  }

  // ── 2. Price the fill (reuses lot-size math + self-match/lazy-fee) ─
  let preview: MatchPreview;
  try {
    const prepareArgs: PrepareMatchArgs = { commitment };
    if (args.taker !== undefined) prepareArgs.taker = args.taker;
    if (args.takerDesiredRiskWei6 !== undefined) {
      prepareArgs.takerDesiredRiskWei6 = args.takerDesiredRiskWei6;
    }
    preview = await prepareMatch(ctx, prepareArgs);
  } catch (err) {
    if (err instanceof OspexValidationError) {
      if (err.field === 'takerDesiredRiskWei6') {
        // An explicit caller-supplied size that can't form a valid lot is a
        // caller error — surface it. A DEFAULT (full-fill) size that rounds to
        // an unfillable lot is a property of the order → no remaining capacity.
        if (args.takerDesiredRiskWei6 !== undefined) throw err;
        return result({
          commitmentHash,
          outcome: 'not-fillable',
          reasons: [{ code: 'NO_REMAINING_CAPACITY' }],
        });
      }
      // NB: a `field: 'lineTicks'` error is NOT mapped to LINE_TICKS_OUT_OF_RANGE
      // here. Every genuine out-of-range line is already caught by the 0b
      // short-circuit above (before prepareMatch runs), so the only way
      // prepareMatch throws `field: 'lineTicks'` is the missing-field case
      // (`lineTicks: null`) — which is a NOT_LIVE condition, not a fund-lock.
      const code: FillabilityReasonCode =
        err.field === 'speculationId'
          ? 'SPECULATION_CLOSED'
          : err.field === 'remainingRiskAmount'
            ? 'NO_REMAINING_CAPACITY'
            : 'NOT_LIVE';
      return result({ commitmentHash, outcome: 'not-fillable', reasons: [{ code }] });
    }
    // A non-existent commitment/contest (404) or a misconfigured client are
    // genuine errors, not "not fillable" — propagate. A chain-read failure (or
    // anything unexpected) during pricing degrades to `unknown`.
    if (err instanceof OspexAPIError || err instanceof OspexConfigError) throw err;
    return result({
      commitmentHash,
      outcome: 'unknown',
      reasons: [{ code: 'FILLABILITY_UNKNOWN' }],
    });
  }

  // ── 3. Aggregate debit model → on-chain reads → verdict ───────────
  const maker = preview.maker;
  const taker = preview.taker;
  const makerRiskWei6 = BigInt(preview.economics.fillMakerRiskWei6);
  const takerRiskWei6 = BigInt(preview.economics.takerRiskWei6);
  const fill: FillabilityFill = {
    makerRiskWei6,
    takerRiskWei6,
    selfMatch: preview.selfMatch,
  };

  const debits: Debit[] = [
    { account: maker, spender: positionModule, amount: makerRiskWei6 },
    { account: taker, spender: positionModule, amount: takerRiskWei6 },
  ];
  // Lazy speculation creation fee — split per side (full to taker on self-match,
  // makerShare = 0n in that case, so the single wallet is debited the full fee).
  const lazy = preview.speculation.lazyCreation;
  if (lazy !== undefined) {
    const makerFee = BigInt(lazy.makerShareWei6);
    const takerFee = BigInt(lazy.takerShareWei6);
    if (makerFee > 0n) debits.push({ account: maker, spender: treasuryModule, amount: makerFee });
    if (takerFee > 0n) debits.push({ account: taker, spender: treasuryModule, amount: takerFee });
  }

  // Aggregate requirements. balance by account; allowance by (account, spender).
  const balanceReq = new Map<Hex, bigint>();
  const allowanceReq = new Map<string, { account: Hex; spender: Hex; required: bigint }>();
  for (const d of debits) {
    balanceReq.set(d.account, (balanceReq.get(d.account) ?? 0n) + d.amount);
    const key = `${d.account}|${d.spender}`;
    const entry = allowanceReq.get(key);
    if (entry !== undefined) entry.required += d.amount;
    else allowanceReq.set(key, { account: d.account, spender: d.spender, required: d.amount });
  }

  const balanceAccounts = [...balanceReq.keys()];
  const allowanceEntries = [...allowanceReq.values()];

  const [balanceReads, allowanceReads, checkedAtBlock] = await Promise.all([
    Promise.all(balanceAccounts.map((acc) => tryReadUsdcBalance(publicClient, usdc, acc))),
    Promise.all(
      allowanceEntries.map((e) => tryReadAllowance(publicClient, usdc, e.account, e.spender)),
    ),
    tryReadBlockNumber(publicClient),
  ]);

  // `roleOf` maps an address back to maker/taker for the reason code; on a
  // self-match both roles are the same wallet → report as 'maker'.
  const roleOf = (addr: Hex): 'maker' | 'taker' => (addr === maker ? 'maker' : 'taker');

  const reasons: FillabilityReason[] = [];
  let anyReadFailed = false;

  balanceAccounts.forEach((acc, i) => {
    const required = balanceReq.get(acc) as bigint;
    const actual = balanceReads[i];
    if (actual === null || actual === undefined) {
      anyReadFailed = true;
      return;
    }
    if (actual < required) {
      const role = roleOf(acc);
      reasons.push({
        code: role === 'maker' ? 'MAKER_USDC_BALANCE_INSUFFICIENT' : 'TAKER_USDC_BALANCE_INSUFFICIENT',
        account: role,
        token: usdc,
        requiredWei6: required,
        actualWei6: actual,
      });
    }
  });

  allowanceEntries.forEach((e, i) => {
    const actual = allowanceReads[i];
    if (actual === null || actual === undefined) {
      anyReadFailed = true;
      return;
    }
    if (actual < e.required) {
      const role = roleOf(e.account);
      reasons.push({
        code: allowanceCode(role, e.spender, positionModule),
        account: role,
        token: usdc,
        spender: e.spender,
        requiredWei6: e.required,
        actualWei6: actual,
      });
    }
  });

  if (reasons.length > 0) {
    // A definite shortfall from a successful read is proof the fill won't go
    // through — even if some other read also failed.
    return result({ commitmentHash, outcome: 'not-fillable', reasons, checkedAtBlock, fill });
  }
  if (anyReadFailed) {
    return result({
      commitmentHash,
      outcome: 'unknown',
      reasons: [{ code: 'FILLABILITY_UNKNOWN' }],
      checkedAtBlock,
      fill,
    });
  }
  return result({ commitmentHash, outcome: 'fillable', reasons: [], checkedAtBlock, fill });
}

// ── Helpers ────────────────────────────────────────────────────────────

interface Debit {
  account: Hex;
  spender: Hex;
  amount: bigint;
}

/** Matchability preconditions, re-derived FRESH from the commitment's fields
 * (the same set `matchCommitment` enforces and the API's `isLive` summarizes).
 * Returns the specific failing reason(s); an empty array means live. A null
 * expiry isn't flagged here — `buildMatchPreview` requires the field, so the
 * pricing step surfaces that case as NOT_LIVE instead. Operates on a
 * {@link PublicVisibleCommitment} — the redacted case is short-circuited by
 * the caller before this runs. */
function livenessReasons(c: PublicVisibleCommitment): FillabilityReason[] {
  const reasons: FillabilityReason[] = [];
  if (c.storedStatus !== 'open' && c.storedStatus !== 'partially_filled') {
    reasons.push({ code: 'NOT_LIVE' });
  }
  if (c.nonceInvalidated) reasons.push({ code: 'NONCE_INVALIDATED' });
  if (BigInt(c.remainingRiskAmount) <= 0n) reasons.push({ code: 'NO_REMAINING_CAPACITY' });
  if (c.expiry !== null) {
    const expirySec = Math.floor(Date.parse(c.expiry) / 1000);
    if (Number.isFinite(expirySec) && expirySec <= Math.floor(Date.now() / 1000)) {
      reasons.push({ code: 'EXPIRED' });
    }
  }
  return reasons;
}

function allowanceCode(
  role: 'maker' | 'taker',
  spender: Hex,
  positionModule: Hex,
): FillabilityReasonCode {
  const isPosition = spender === positionModule;
  if (role === 'maker') {
    return isPosition
      ? 'MAKER_POSITION_ALLOWANCE_INSUFFICIENT'
      : 'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT';
  }
  return isPosition
    ? 'TAKER_POSITION_ALLOWANCE_INSUFFICIENT'
    : 'TAKER_TREASURY_ALLOWANCE_INSUFFICIENT';
}

function result(args: {
  commitmentHash: string;
  outcome: FillabilityOutcome;
  reasons: FillabilityReason[];
  checkedAtBlock?: bigint | null;
  fill?: FillabilityFill;
}): CheckCommitmentFillabilityResult {
  const out: CheckCommitmentFillabilityResult = {
    commitmentHash: args.commitmentHash,
    fillableNow: args.outcome === 'fillable',
    outcome: args.outcome,
    advisory: true,
    reasons: args.reasons,
  };
  if (args.checkedAtBlock !== undefined && args.checkedAtBlock !== null) {
    out.checkedAtBlock = args.checkedAtBlock;
  }
  if (args.fill !== undefined) out.fill = args.fill;
  return out;
}

async function resolveCommitment(
  ctx: CommitmentsContext,
  args: CheckCommitmentFillabilityArgs,
): Promise<Commitment> {
  if (args.commitment !== undefined && args.hash !== undefined) {
    throw new OspexValidationError(
      'checkCommitmentFillability: pass either { hash } or { commitment }, not both.',
    );
  }
  if (args.commitment !== undefined) return args.commitment;
  if (args.hash === undefined) {
    throw new OspexValidationError(
      'checkCommitmentFillability: { hash } or { commitment } is required.',
    );
  }
  return new CommitmentsApi(ctx.api).get(args.hash);
}

/** USDC `balanceOf`, returning `null` on any read error so a flaky read
 * degrades the verdict to `unknown` rather than a false `not-fillable`. */
async function tryReadUsdcBalance(
  publicClient: PublicClient,
  usdc: Hex,
  account: Hex,
): Promise<bigint | null> {
  try {
    return (await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    })) as bigint;
  } catch {
    return null;
  }
}

/** USDC `allowance(owner, spender)`, `null` on read error (see above). */
async function tryReadAllowance(
  publicClient: PublicClient,
  usdc: Hex,
  owner: Hex,
  spender: Hex,
): Promise<bigint | null> {
  try {
    return await readAllowance(publicClient, usdc, owner, spender);
  } catch {
    return null;
  }
}

/** Current block number, `null` on read error (just drops `checkedAtBlock`). */
async function tryReadBlockNumber(publicClient: PublicClient): Promise<bigint | null> {
  try {
    return await publicClient.getBlockNumber();
  } catch {
    return null;
  }
}
