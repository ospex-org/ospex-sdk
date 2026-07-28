/**
 * Pure plan-builder for `ospex approvals setup`. Takes the user's flag
 * inputs (or interactive answers) and the current on-chain allowance
 * snapshot, decides what (if anything) to do for each spender, and
 * returns a serialisable `SetupPlan` for the renderer + executor.
 *
 * Two dimensions, in render order (both USDC):
 *
 *   1. USDC → PositionModule  (`--risk-usdc`)  — bet risk
 *   2. USDC → TreasuryModule  (`--fee-usdc`)   — protocol fees
 *
 * (R5/CRE removed the LINK → OracleModule dimension — contest
 * verify/score are permissionless and funded off-chain by the workflow
 * owner; only the USDC creation fee remains, covered by `--fee-usdc`.)
 *
 * The two dimensions are ORTHOGONAL: each flag acts on its own spender
 * and nothing else. Omitting a flag leaves that allowance untouched.
 * There is no cross-dimension defaulting — approving bet risk never
 * implies a fee approval. An operator who may be first to a market has
 * to approve a fee budget explicitly, because that is how the protocol
 * is designed: the speculation creation fee (0.25 USDC per side) is
 * pulled from TreasuryModule on the first commitment match of a new
 * market, and an unapproved wallet reverts there.
 *
 * Skip rule: if the wallet already has at least the requested allowance
 * for a given spender, the planner emits a `skip-already-approved`
 * action so the executor doesn't waste gas on a redundant approve.
 *
 * Monotonic contract: this planner only ever RAISES an allowance. An
 * explicit `0` is therefore refused rather than silently treated as
 * "leave unchanged" — see {@link parseUsdcInput}.
 *
 * The planner is pure / synchronous and tested in isolation.
 */

import { maxUint256, parseUnits } from 'viem';
import { OspexValidationError, type ApprovalsSnapshot } from '@ospex/sdk';
import type { Hex } from './walletAddress.js';

const USDC_DECIMAL_RE = /^\d+(?:\.\d{1,6})?$/;

export interface SetupInput {
  /** USDC amount string for PositionModule (decimal USDC, "max", or undefined to skip). */
  riskUsdc?: string | undefined;
  /** USDC amount string for TreasuryModule. */
  feeUsdc?: string | undefined;
}

export type ApprovalAction =
  | { kind: 'send'; targetRaw: bigint; targetIsMax: boolean }
  | { kind: 'skip-already-approved'; currentRaw: bigint; targetRaw: bigint }
  | { kind: 'skip-not-requested' };

export type ApprovalSpenderKey = 'positionModule' | 'treasuryModule';

export interface PlanItem {
  spenderModule: ApprovalSpenderKey;
  spender: Hex;
  token: 'USDC';
  tokenAddress: Hex;
  decimals: number;
  /** Short label for the renderer ("bet risk", "protocol fees", "Chainlink"). */
  purpose: string;
  currentRaw: bigint;
  action: ApprovalAction;
}

export interface SetupPlan {
  owner: Hex;
  chainId: number;
  items: PlanItem[];
  /** Number of items with action.kind === 'send'. */
  willSendCount: number;
}

export type ParsedAmount =
  | { kind: 'skip' }
  | { kind: 'amount'; raw: bigint }
  | { kind: 'max' };

/**
 * Parse a decimal USDC string. Returns `kind: 'skip'` for `undefined`,
 * empty, and the literal "skip" — the three ways to say "leave this
 * allowance unchanged". Accepts at most 6 fractional digits.
 *
 * An explicit numeric zero is REFUSED, not treated as skip. `approvals
 * setup` is monotonic (it only raises allowances), so a zero target has
 * no meaning inside it — while in ERC-20 terms `approve(spender, 0)` is
 * the canonical revoke. Collapsing the two let an explicit `0` return a
 * green, zero-send envelope while the allowance stayed live, which
 * reads as a successful revocation and is not one.
 *
 * `flag` is the originating CLI flag (e.g. `--fee-usdc`) and is used
 * only to make the refusal message name the dimension the caller
 * actually typed. Interactive input has no flag, so it is optional.
 */
export function parseUsdcInput(input: string | undefined, flag?: string): ParsedAmount {
  return parseDecimalAmount(input, 6, USDC_DECIMAL_RE, 'USDC', flag);
}

function parseDecimalAmount(
  input: string | undefined,
  decimals: number,
  re: RegExp,
  label: string,
  flag?: string,
): ParsedAmount {
  if (input === undefined) return { kind: 'skip' };
  const trimmed = input.trim();
  if (trimmed === '' || trimmed === 'skip') return { kind: 'skip' };
  if (trimmed === 'max') return { kind: 'max' };
  if (!re.test(trimmed)) {
    throw new OspexValidationError(
      `Invalid ${label} amount "${input}". Use a decimal number (e.g. "5" or "0.25"), "max" for ` +
        `unlimited, or omit / "skip" to leave this dimension unchanged.`,
      { field: flag ?? 'amount' },
    );
  }
  const raw = parseUnits(trimmed, decimals);
  if (raw === 0n) {
    const subject = flag !== undefined ? `\`${flag} 0\`` : 'An explicit zero';
    const leaveUnchanged =
      flag !== undefined ? `omit ${flag} (or pass "skip")` : 'answer "skip"';
    throw new OspexValidationError(
      `${subject} is not a revocation. \`approvals setup\` only raises allowances, never lowers ` +
        `them — ${leaveUnchanged} to leave an allowance unchanged. To revoke: ` +
        `\`ospex commitments approve 0\` zeroes the PositionModule allowance; the TreasuryModule ` +
        `allowance is revoked with a direct USDC \`approve(TreasuryModule, 0)\`.`,
      { field: flag ?? 'amount' },
    );
  }
  return { kind: 'amount', raw };
}

/**
 * Build the `SetupPlan` from raw inputs + the current allowance
 * snapshot. The caller has already mapped flags to strings; this
 * function does parsing + decision logic so the same builder serves
 * both the flag-driven and interactive paths.
 */
export function buildSetupPlan(input: SetupInput, current: ApprovalsSnapshot): SetupPlan {
  // Each flag acts on its own spender only — an omitted dimension is
  // left untouched, with no cross-dimension defaulting.
  //
  // No `flag` argument here on purpose. In flag mode the command
  // pre-parses each flag WITH its name before any chain work, so a
  // flag-supplied zero is already refused (naming the flag) and never
  // reaches this point. What does reach here is interactive input,
  // where naming a flag the operator never typed would misdirect.
  const riskParsed = parseUsdcInput(input.riskUsdc);
  const feeParsed = parseUsdcInput(input.feeUsdc);

  const items: PlanItem[] = [
    buildItem(current, 'positionModule', 'USDC', 'bet risk', riskParsed),
    buildItem(current, 'treasuryModule', 'USDC', 'protocol fees', feeParsed),
  ];

  const willSendCount = items.filter((i) => i.action.kind === 'send').length;
  return {
    owner: current.owner,
    chainId: current.chainId,
    items,
    willSendCount,
  };
}

function buildItem(
  current: ApprovalsSnapshot,
  spenderKey: ApprovalSpenderKey,
  token: 'USDC',
  purpose: string,
  parsed: ParsedAmount,
): PlanItem {
  const { spenderAddr, tokenAddr, decimals, currentRaw } = lookupSpender(current, spenderKey);
  const base = {
    spenderModule: spenderKey,
    spender: spenderAddr,
    token,
    tokenAddress: tokenAddr,
    decimals,
    purpose,
    currentRaw,
  } as const;

  if (parsed.kind === 'skip') {
    return { ...base, action: { kind: 'skip-not-requested' } };
  }
  const targetRaw = parsed.kind === 'max' ? maxUint256 : parsed.raw;
  if (currentRaw >= targetRaw) {
    return { ...base, action: { kind: 'skip-already-approved', currentRaw, targetRaw } };
  }
  return {
    ...base,
    action: { kind: 'send', targetRaw, targetIsMax: parsed.kind === 'max' },
  };
}

interface SpenderLookup {
  spenderAddr: Hex;
  tokenAddr: Hex;
  decimals: number;
  currentRaw: bigint;
}

function lookupSpender(
  current: ApprovalsSnapshot,
  spenderKey: ApprovalSpenderKey,
): SpenderLookup {
  if (spenderKey === 'positionModule') {
    const e = current.usdc.allowances.positionModule;
    return {
      spenderAddr: e.spender as Hex,
      tokenAddr: current.usdc.address as Hex,
      decimals: current.usdc.decimals,
      currentRaw: e.raw,
    };
  }
  const e = current.usdc.allowances.treasuryModule;
  return {
    spenderAddr: e.spender as Hex,
    tokenAddr: current.usdc.address as Hex,
    decimals: current.usdc.decimals,
    currentRaw: e.raw,
  };
}
