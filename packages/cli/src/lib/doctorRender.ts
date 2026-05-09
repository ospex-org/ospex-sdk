/**
 * Pure logic + formatters for `ospex doctor`. Splits the work into:
 *
 *   - `computeReadiness(approvals, balances)` — turns the two
 *     snapshots into a "Ready to" matrix with a per-capability
 *     reasons list. Pure / synchronous; testable in isolation.
 *   - `pickNextSuggestion(...)` — picks at most one actionable
 *     follow-up, ranked by which blocker is most fundamental.
 *   - `renderDoctorReport(...)` — human and JSON formatters.
 *
 * The renderer is intentionally separate from the command wiring so
 * the test suite can exercise the truth table on synthetic inputs
 * without spinning up a chain client.
 */

import { formatUnits } from 'viem';
import type { ApprovalsSnapshot, BalancesSnapshot } from '@ospex/sdk';

const INDENT = '  ';

// "Effectively zero" thresholds — the same values the human renderer
// uses to flag balances that LOOK like zero but technically aren't.
// Sharing them with `computeReadiness` keeps the contract consistent
// (Hermes flagged the prior mismatch on PR #39 review): the doctor
// must not say "ready to match" for a wallet whose POL balance the
// same report annotates as "no gas — no tx will land".
//
//   POL_GAS_FLOOR_WEI:  1e14 wei = 0.0001 POL. Below this you can't
//                       fund any realistic Polygon tx (even a simple
//                       approve burns ~1.5e15 wei = 0.0015 POL).
//   LINK_DUST_FLOOR_WEI: 1e12 wei = 1 µLINK. Below this the renderer
//                       displays "0 LINK". A real Chainlink Functions
//                       call costs ~1 LINK so this is a generous
//                       lower bound — anything below it definitely
//                       won't fund a contest creation.
const POL_GAS_FLOOR_WEI = 100_000_000_000_000n;
const LINK_DUST_FLOOR_WEI = 1_000_000_000_000n;

// ── Readiness ──────────────────────────────────────────────────────

export interface Capability {
  ok: boolean;
  /** Short human-readable reasons explaining why `ok=false`. Empty when ok=true. */
  reasons: string[];
}

export interface Readiness {
  matchCommitments: Capability;
  submitCommitments: Capability;
  createContests: Capability;
}

interface ReadinessInputs {
  approvals: ApprovalsSnapshot;
  balances: BalancesSnapshot;
  /**
   * Whether the Core API liveness probe succeeded. Fed in alongside
   * the chain snapshots because every Ospex write depends on the API:
   * `commitments.match` resolves the commitment via core-api before
   * signing; `commitments.submit` POSTs the EIP-712 payload to
   * core-api; `contests.create` fetches script approvals from
   * core-api. apiOk=false flips every capability to false and the
   * agent guard `ospex doctor && ospex commitments match` correctly
   * blocks. Hermes flagged the prior omission on PR #39 review.
   */
  apiOk: boolean;
}

/**
 * Capability matrix from the wallet snapshots. Thresholds match the
 * renderer's "effectively zero" cutoffs (POL_GAS_FLOOR_WEI,
 * LINK_DUST_FLOOR_WEI) so the doctor can never both flag a balance
 * as no-gas/dust AND report a capability as ready. apiOk=false flips
 * every capability to false because every Ospex write goes through
 * core-api.
 *
 * The doctor surfaces the SHAPE of readiness, not exact sufficiency
 * for a specific bet size — that's enforced at submit/match time by
 * the SDK's allowance preflight.
 */
export function computeReadiness({ approvals, balances, apiOk }: ReadinessInputs): Readiness {
  const hasGas = balances.native >= POL_GAS_FLOOR_WEI;
  const hasUsdc = balances.usdc > 0n;
  const hasLink = balances.link >= LINK_DUST_FLOOR_WEI;
  const positionApproved = approvals.usdc.allowances.positionModule.raw > 0n;
  const treasuryApproved = approvals.usdc.allowances.treasuryModule.raw > 0n;
  const oracleApproved = approvals.link.allowances.oracleModule.raw > 0n;

  // Matching as a taker pulls USDC from PositionModule, so the gating
  // primitives are: API up, POL (gas), USDC (balance), PositionModule
  // (allowance). TreasuryModule is conditionally needed for lazy spec
  // creation fees, but the maker side pays the bigger half and a
  // missing allowance only blocks the user when they happen to be the
  // first match on a fresh speculation key.
  const matchReasons: string[] = [];
  if (!apiOk) matchReasons.push('Core API unreachable');
  if (!hasGas) matchReasons.push('no POL balance for gas');
  if (!hasUsdc) matchReasons.push('no USDC balance');
  if (!positionApproved) matchReasons.push('PositionModule USDC not approved');

  // Submitting and matching share the same baseline. Submitting a
  // commitment that lazily creates a speculation pulls the maker's
  // half of the speculation creation fee from TreasuryModule, but
  // that's only an issue when the commitment ends up being the first
  // match on its key — and the SDK preflights it on submit.
  const submitReasons: string[] = [...matchReasons];

  // Creating contests requires API up (script approvals are served
  // from core-api), LINK + Oracle for the Chainlink Functions call,
  // plus USDC + Treasury for the creation fee.
  const createReasons: string[] = [];
  if (!apiOk) createReasons.push('Core API unreachable');
  if (!hasGas) createReasons.push('no POL balance for gas');
  if (!hasLink) createReasons.push('no LINK balance');
  if (!oracleApproved) createReasons.push('OracleModule LINK not approved');
  if (!hasUsdc) createReasons.push('no USDC balance');
  if (!treasuryApproved) createReasons.push('TreasuryModule USDC not approved');

  return {
    matchCommitments: { ok: matchReasons.length === 0, reasons: matchReasons },
    submitCommitments: { ok: submitReasons.length === 0, reasons: submitReasons },
    createContests: { ok: createReasons.length === 0, reasons: createReasons },
  };
}

// ── Suggestion ranking ─────────────────────────────────────────────

export interface Suggestion {
  text: string;
  /** Optional shell command (when there's a single concrete action). */
  command?: string;
  audience: 'bettor' | 'operator';
}

/**
 * Pick at most one actionable follow-up. Ranked by what unlocks the
 * most basic capability first: API up (nothing else matters if it's
 * down), then POL → USDC → PositionModule approval → operator hints.
 * Returns `null` when the bettor path is fully ready and the operator
 * path is also satisfied.
 */
export function pickNextSuggestion(
  inputs: ReadinessInputs,
  readiness: Readiness,
): Suggestion | null {
  const { apiOk, balances, approvals } = inputs;
  const positionApproved = approvals.usdc.allowances.positionModule.raw > 0n;

  if (!apiOk) {
    // No actionable command — the user can't fix a remote outage.
    // Surface the situation so they don't try to fix something
    // local that isn't actually broken.
    return {
      text:
        'Core API is unreachable. Wallet state on-chain is fine; retry shortly. ' +
        'If this persists, the API may be temporarily down.',
      audience: 'bettor',
    };
  }
  if (balances.native < POL_GAS_FLOOR_WEI) {
    return {
      text: 'Fund this wallet with POL for gas before any tx can land.',
      audience: 'bettor',
    };
  }
  if (balances.usdc === 0n) {
    return {
      text: 'Fund this wallet with USDC before placing or matching bets.',
      audience: 'bettor',
    };
  }
  if (!positionApproved) {
    return {
      text: 'Approve USDC for matching / submitting bets.',
      command: 'ospex approvals setup --risk-usdc 50',
      audience: 'bettor',
    };
  }
  if (readiness.matchCommitments.ok && !readiness.createContests.ok) {
    // Bettor path is fully ready; only the operator path is missing.
    // Mark this softly — most users never need it.
    return {
      text:
        'You\'re ready to match and submit commitments. Contest creation needs LINK + Oracle ' +
        'approval; only set up if you plan to create contests yourself.',
      command: 'ospex approvals setup --link 2',
      audience: 'operator',
    };
  }
  return null;
}

// ── JSON envelope ──────────────────────────────────────────────────

export interface JsonDoctorReport {
  schemaVersion: 1;
  network: { chainId: number; label: string };
  api: { ok: boolean };
  wallet: { address: string };
  balances: {
    native: { raw: string; formatted: string; decimals: 18; symbol: string };
    usdc: { raw: string; formatted: string; decimals: 6; address: string };
    link: { raw: string; formatted: string; decimals: 18; address: string };
  };
  allowances: {
    usdcPositionModule: { raw: string; formatted: string; spender: string };
    usdcTreasuryModule: { raw: string; formatted: string; spender: string };
    linkOracleModule: { raw: string; formatted: string; spender: string };
  };
  ready: {
    matchCommitments: Capability;
    submitCommitments: Capability;
    createContests: Capability;
  };
  suggestion: Suggestion | null;
}

export interface DoctorReportInputs extends ReadinessInputs {
  apiOk: boolean;
}

export function buildDoctorReport(inputs: DoctorReportInputs): JsonDoctorReport {
  const { approvals, balances, apiOk } = inputs;
  const readiness = computeReadiness({ approvals, balances, apiOk });
  const suggestion = pickNextSuggestion({ approvals, balances, apiOk }, readiness);
  const symbol = nativeSymbol(balances.chainId);
  return {
    schemaVersion: 1,
    network: { chainId: balances.chainId, label: networkLabel(balances.chainId) },
    api: { ok: apiOk },
    wallet: { address: balances.owner },
    balances: {
      native: {
        raw: balances.native.toString(),
        formatted: trimDecimal(formatUnits(balances.native, 18), 6),
        decimals: 18,
        symbol,
      },
      usdc: {
        raw: balances.usdc.toString(),
        formatted: formatUnits(balances.usdc, 6),
        decimals: 6,
        address: balances.usdcAddress,
      },
      link: {
        raw: balances.link.toString(),
        formatted: trimDecimal(formatUnits(balances.link, 18), 6),
        decimals: 18,
        address: balances.linkAddress,
      },
    },
    allowances: {
      usdcPositionModule: serializeAllowance(
        approvals.usdc.allowances.positionModule.raw,
        approvals.usdc.allowances.positionModule.spender,
        6,
      ),
      usdcTreasuryModule: serializeAllowance(
        approvals.usdc.allowances.treasuryModule.raw,
        approvals.usdc.allowances.treasuryModule.spender,
        6,
      ),
      linkOracleModule: serializeAllowance(
        approvals.link.allowances.oracleModule.raw,
        approvals.link.allowances.oracleModule.spender,
        18,
      ),
    },
    ready: readiness,
    suggestion,
  };
}

function serializeAllowance(
  raw: bigint,
  spender: string,
  decimals: number,
): { raw: string; formatted: string; spender: string } {
  return {
    raw: raw.toString(),
    formatted: decimals === 6 ? formatUnits(raw, 6) : trimDecimal(formatUnits(raw, decimals), 6),
    spender,
  };
}

// ── Human renderer ─────────────────────────────────────────────────

export function renderDoctorReport(
  report: JsonDoctorReport,
  out: NodeJS.WritableStream,
): void {
  out.write(`\nNetwork:    ${report.network.label} (${report.network.chainId})\n`);
  out.write(`Core API:   ${report.api.ok ? 'ok' : 'unreachable'}\n`);
  out.write(`Wallet:     ${report.wallet.address}\n`);

  out.write('\nBalances\n');
  out.write(
    `${INDENT}${(report.balances.native.symbol).padEnd(8)} ${formatNative(report.balances.native)}\n`,
  );
  out.write(
    `${INDENT}${'USDC'.padEnd(8)} ${formatUsdcRow(report.balances.usdc)}\n`,
  );
  // The "only needed for contests" annotation fires when the user's
  // LINK balance is below display precision — not strictly raw === 0.
  // Address 0x..01 on mainnet has 6.45e-7 LINK from misdirected dust;
  // raw is non-zero but visually it's "0 LINK", so the check has to
  // mirror what the user actually sees. The same threshold gates
  // `computeReadiness` so the doctor never says "ready to create
  // contests" with a balance the renderer flagged as dust.
  const linkEffectivelyZero = BigInt(report.balances.link.raw) < LINK_DUST_FLOOR_WEI;
  out.write(
    `${INDENT}${'LINK'.padEnd(8)} ${formatLinkRow(report.balances.link)}` +
      (linkEffectivelyZero ? '    (only needed for contest creation/scoring)' : '') +
      '\n',
  );

  out.write('\nAllowances\n');
  out.write(
    `${INDENT}${'PositionModule'.padEnd(16)} (bet risk):       ${formatUsdcAllowance(report.allowances.usdcPositionModule)}\n`,
  );
  out.write(
    `${INDENT}${'TreasuryModule'.padEnd(16)} (protocol fees):  ${formatUsdcAllowance(report.allowances.usdcTreasuryModule)}\n`,
  );
  out.write(
    `${INDENT}${'OracleModule'.padEnd(16)} (Chainlink):       ${formatLinkAllowance(report.allowances.linkOracleModule)}\n`,
  );

  out.write('\nReady to:\n');
  out.write(`${INDENT}${'match existing commitments'.padEnd(28)} ${formatCapability(report.ready.matchCommitments)}\n`);
  out.write(`${INDENT}${'submit new commitments'.padEnd(28)} ${formatCapability(report.ready.submitCommitments)}\n`);
  out.write(`${INDENT}${'create contests'.padEnd(28)} ${formatCapability(report.ready.createContests)}\n`);

  if (report.suggestion !== null) {
    out.write('\nNext step:\n');
    out.write(`${INDENT}${report.suggestion.text}\n`);
    if (report.suggestion.command !== undefined) {
      out.write(`${INDENT}  $ ${report.suggestion.command}\n`);
    }
  }
  out.write('\n');
}

function formatCapability(c: Capability): string {
  if (c.ok) return 'yes';
  return `no — ${c.reasons.join(', ')}`;
}

function formatNative(b: JsonDoctorReport['balances']['native']): string {
  // Same "below display precision = effectively zero" pattern as the
  // LINK annotation, sharing POL_GAS_FLOOR_WEI with computeReadiness
  // so the doctor never says "ready to match" while annotating the
  // POL balance as "no gas — no tx will land".
  const effectivelyZero = BigInt(b.raw) < POL_GAS_FLOOR_WEI;
  return `${b.formatted} ${b.symbol}` + (effectivelyZero ? '    (no gas — no tx will land)' : '');
}

function formatUsdcRow(b: JsonDoctorReport['balances']['usdc']): string {
  return `${b.formatted} USDC`;
}

function formatLinkRow(b: JsonDoctorReport['balances']['link']): string {
  return `${b.formatted} LINK`;
}

function formatUsdcAllowance(a: { raw: string; formatted: string }): string {
  if (a.raw === '0') return '       0.000000 USDC    not approved';
  if (isMaxString(a.raw)) return 'unlimited (max) USDC    ok';
  return `${padDecimal(a.formatted, 6).padStart(15)} USDC    ok`;
}

function formatLinkAllowance(a: { raw: string; formatted: string }): string {
  if (a.raw === '0') return '             0 LINK    not approved';
  if (isMaxString(a.raw)) return 'unlimited (max) LINK    ok';
  return `${a.formatted.padStart(15)} LINK    ok`;
}

const MAX_UINT256_STR = ((1n << 256n) - 1n).toString();
const NEAR_MAX_THRESHOLD_STR = (1n << 248n).toString();

function isMaxString(raw: string): boolean {
  if (raw === MAX_UINT256_STR) return true;
  // Cheap length-prefix check: any value past 2^248 has at least 75 digits.
  if (raw.length >= NEAR_MAX_THRESHOLD_STR.length) {
    try {
      return BigInt(raw) >= 1n << 248n;
    } catch {
      return false;
    }
  }
  return false;
}

function padDecimal(value: string, fractionDigits: number): string {
  const dot = value.indexOf('.');
  if (dot === -1) return `${value}.${'0'.repeat(fractionDigits)}`;
  const frac = value.slice(dot + 1);
  if (frac.length >= fractionDigits) return `${value.slice(0, dot)}.${frac.slice(0, fractionDigits)}`;
  return `${value}${'0'.repeat(fractionDigits - frac.length)}`;
}

function trimDecimal(value: string, fractionDigits: number): string {
  const dot = value.indexOf('.');
  if (dot === -1) return value;
  const intPart = value.slice(0, dot);
  const fracPart = value.slice(dot + 1).slice(0, fractionDigits).replace(/0+$/, '');
  return fracPart.length === 0 ? intPart : `${intPart}.${fracPart}`;
}

function networkLabel(chainId: number): string {
  if (chainId === 137) return 'Polygon mainnet';
  if (chainId === 80002) return 'Polygon Amoy';
  return 'unknown';
}

function nativeSymbol(chainId: number): string {
  if (chainId === 137 || chainId === 80002) return 'POL';
  return 'NATIVE';
}
