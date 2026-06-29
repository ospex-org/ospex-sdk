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
 * Auto-include rule: when the caller provides ONLY `--risk-usdc`
 * (omitting `--fee-usdc`), we target a small fee budget so the most
 * common mid-bet approval prompt (the maker's / taker's half of the
 * lazy speculation creation fee, 0.25 USDC each) doesn't fire on the
 * next commitment match. Pass `--fee-usdc 0` to opt out.
 *
 * Skip rule: if the wallet already has at least the requested allowance
 * for a given spender, the planner emits a `skip-already-approved`
 * action so the executor doesn't waste gas on a redundant approve.
 *
 * The planner is pure / synchronous and tested in isolation.
 */

import { maxUint256, parseUnits } from 'viem';
import type { ApprovalsSnapshot } from '@ospex/sdk';
import type { Hex } from './walletAddress.js';

const FEE_AUTO_INCLUDE_USDC = '1';

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
  /** True when this item was added because of the `--risk-usdc` co-default rule. */
  autoIncluded: boolean;
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
 * empty, or "0". Accepts at most 6 fractional digits.
 */
export function parseUsdcInput(input: string | undefined): ParsedAmount {
  return parseDecimalAmount(input, 6, USDC_DECIMAL_RE, 'USDC');
}

function parseDecimalAmount(
  input: string | undefined,
  decimals: number,
  re: RegExp,
  label: string,
): ParsedAmount {
  if (input === undefined) return { kind: 'skip' };
  const trimmed = input.trim();
  if (trimmed === '' || trimmed === 'skip') return { kind: 'skip' };
  if (trimmed === 'max') return { kind: 'max' };
  if (!re.test(trimmed)) {
    throw new Error(
      `Invalid ${label} amount "${input}". Use a decimal number (e.g. "5" or "0.25"), "max" for ` +
        `unlimited, or omit / "skip" to leave this dimension unchanged.`,
    );
  }
  const raw = parseUnits(trimmed, decimals);
  if (raw === 0n) return { kind: 'skip' };
  return { kind: 'amount', raw };
}

/**
 * Build the `SetupPlan` from raw inputs + the current allowance
 * snapshot. The caller has already mapped flags to strings; this
 * function does parsing + decision logic so the same builder serves
 * both the flag-driven and interactive paths.
 */
export function buildSetupPlan(input: SetupInput, current: ApprovalsSnapshot): SetupPlan {
  const riskParsed = parseUsdcInput(input.riskUsdc);
  let feeParsed = parseUsdcInput(input.feeUsdc);

  // Auto-include: when the caller passed ONLY --risk-usdc (no
  // --fee-usdc), target a small fee budget. "Did not set" is detected
  // by raw input shape (undefined) — distinct from "0" / "skip", which
  // is an explicit opt-out.
  let autoIncludedFee = false;
  if (
    input.riskUsdc !== undefined &&
    input.feeUsdc === undefined &&
    riskParsed.kind !== 'skip'
  ) {
    feeParsed = parseUsdcInput(FEE_AUTO_INCLUDE_USDC);
    autoIncludedFee = true;
  }

  const items: PlanItem[] = [
    buildItem(current, 'positionModule', 'USDC', 'bet risk', riskParsed, false),
    buildItem(current, 'treasuryModule', 'USDC', 'protocol fees', feeParsed, autoIncludedFee),
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
  autoIncluded: boolean,
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
    autoIncluded,
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
