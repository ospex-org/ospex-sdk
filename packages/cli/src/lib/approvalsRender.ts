/**
 * Pure formatters for `client.approvals.read()` snapshots and
 * `buildSetupPlan()` plans. Used by `ospex approvals show` and
 * `ospex approvals setup`, and (later) by `ospex doctor` for its
 * allowances section.
 *
 * The rendering is intentionally isolated from the command wiring so
 * the test suite can exercise it on synthetic data without spinning
 * up a chain client.
 */

import { formatUnits } from 'viem';
import type { ApprovalsSnapshot } from '@ospex/sdk';
import type { PlanItem, SetupPlan } from './approvalsPlan.js';

const INDENT = '  ';
const MAX_UINT256 = (1n << 256n) - 1n;
// Single-tx unlimited approvals send `uint256.max`; downstream transfers
// reduce the stored value, so an "unlimited" approval can drift to any
// value high enough to make the original a near-certain match. The
// 2^248 threshold below is conservative: only a max-style approval can
// realistically reach it given USDC/LINK supply caps.
const NEAR_MAX_THRESHOLD = 1n << 248n;

export interface JsonAllowanceEntry {
  spender: string;
  raw: string;
  formatted: string;
  isMax: boolean;
}

export interface JsonApprovalsSnapshot {
  owner: string;
  chainId: number;
  usdc: {
    address: string;
    decimals: 6;
    allowances: {
      positionModule: JsonAllowanceEntry;
      treasuryModule: JsonAllowanceEntry;
    };
  };
  link: {
    address: string;
    decimals: 18;
    allowances: {
      oracleModule: JsonAllowanceEntry;
    };
  };
}

export function isMaxAllowance(raw: bigint): boolean {
  return raw === MAX_UINT256 || raw >= NEAR_MAX_THRESHOLD;
}

export function snapshotToJson(snapshot: ApprovalsSnapshot): JsonApprovalsSnapshot {
  const usdc = snapshot.usdc.allowances;
  const link = snapshot.link.allowances;
  return {
    owner: snapshot.owner,
    chainId: snapshot.chainId,
    usdc: {
      address: snapshot.usdc.address,
      decimals: 6,
      allowances: {
        positionModule: serializeEntry(usdc.positionModule.spender, usdc.positionModule.raw, 6),
        treasuryModule: serializeEntry(usdc.treasuryModule.spender, usdc.treasuryModule.raw, 6),
      },
    },
    link: {
      address: snapshot.link.address,
      decimals: 18,
      allowances: {
        oracleModule: serializeEntry(link.oracleModule.spender, link.oracleModule.raw, 18),
      },
    },
  };
}

export function renderApprovalsSnapshot(
  snapshot: ApprovalsSnapshot,
  out: NodeJS.WritableStream,
): void {
  out.write(`\nWallet:   ${snapshot.owner}\n`);
  out.write(`Network:  ${networkLabel(snapshot.chainId)} (${snapshot.chainId})\n`);

  const usdc = snapshot.usdc.allowances;
  out.write('\nUSDC allowances\n');
  out.write(
    `${INDENT}${'PositionModule'.padEnd(16)} (bet risk):       ${formatUsdc(usdc.positionModule.raw)}    ${shortAddr(usdc.positionModule.spender)}\n`,
  );
  out.write(
    `${INDENT}${'TreasuryModule'.padEnd(16)} (protocol fees):  ${formatUsdc(usdc.treasuryModule.raw)}    ${shortAddr(usdc.treasuryModule.spender)}\n`,
  );

  const link = snapshot.link.allowances;
  out.write('\nLINK allowances\n');
  out.write(
    `${INDENT}${'OracleModule'.padEnd(16)} (Chainlink):       ${formatLink(link.oracleModule.raw)}    ${shortAddr(link.oracleModule.spender)}\n`,
  );
  if (link.oracleModule.raw === 0n) {
    out.write(
      `${INDENT}${''.padEnd(16)}                    (only needed if you create or score contests)\n`,
    );
  }
  out.write(
    '\nRun `ospex approvals setup` to add or increase approvals (does not lower).\n' +
      'For balances + readiness, run `ospex doctor`.\n',
  );
}

// ── Setup plan render ──────────────────────────────────────────────

export interface JsonSetupPlanItem {
  spenderModule: PlanItem['spenderModule'];
  spender: string;
  token: PlanItem['token'];
  tokenAddress: string;
  decimals: number;
  purpose: string;
  currentRaw: string;
  currentFormatted: string;
  autoIncluded: boolean;
  action:
    | { kind: 'send'; targetRaw: string; targetFormatted: string; targetIsMax: boolean }
    | { kind: 'skip-already-approved'; targetRaw: string; targetFormatted: string }
    | { kind: 'skip-not-requested' };
}

export interface JsonSetupPlan {
  owner: string;
  chainId: number;
  willSendCount: number;
  items: JsonSetupPlanItem[];
}

/**
 * Per-tx execution result emitted by the setup orchestrator. Mirrors
 * the shape `client.commitments.approve` already returns, narrowed to
 * the fields agents need to verify on chain.
 */
export interface JsonSetupResult {
  spenderModule: PlanItem['spenderModule'];
  txHash: string;
  blockNumber: string;
  status: 'success' | 'reverted';
}

/**
 * Preview-only envelope (`--json` without `--yes`). No txs were sent.
 */
export interface SetupPreviewEnvelope {
  schemaVersion: 1;
  plan: JsonSetupPlan;
}

/**
 * Result envelope (`--yes --json`). Includes the plan that was acted
 * on plus per-tx results. `results` is empty when willSendCount === 0
 * (idempotent re-run; everything was already approved).
 */
export interface SetupResultEnvelope {
  schemaVersion: 1;
  plan: JsonSetupPlan;
  results: JsonSetupResult[];
}

export function setupPlanToJson(plan: SetupPlan): JsonSetupPlan {
  return {
    owner: plan.owner,
    chainId: plan.chainId,
    willSendCount: plan.willSendCount,
    items: plan.items.map(planItemToJson),
  };
}

export function buildSetupPreviewEnvelope(plan: SetupPlan): SetupPreviewEnvelope {
  return { schemaVersion: 1, plan: setupPlanToJson(plan) };
}

export function buildSetupResultEnvelope(
  plan: SetupPlan,
  results: JsonSetupResult[],
): SetupResultEnvelope {
  return { schemaVersion: 1, plan: setupPlanToJson(plan), results };
}

function planItemToJson(item: PlanItem): JsonSetupPlanItem {
  const base = {
    spenderModule: item.spenderModule,
    spender: item.spender,
    token: item.token,
    tokenAddress: item.tokenAddress,
    decimals: item.decimals,
    purpose: item.purpose,
    currentRaw: item.currentRaw.toString(),
    currentFormatted: formatUnits(item.currentRaw, item.decimals),
    autoIncluded: item.autoIncluded,
  };

  if (item.action.kind === 'send') {
    return {
      ...base,
      action: {
        kind: 'send',
        targetRaw: item.action.targetRaw.toString(),
        targetFormatted: formatUnits(item.action.targetRaw, item.decimals),
        targetIsMax: item.action.targetIsMax,
      },
    };
  }
  if (item.action.kind === 'skip-already-approved') {
    return {
      ...base,
      action: {
        kind: 'skip-already-approved',
        targetRaw: item.action.targetRaw.toString(),
        targetFormatted: formatUnits(item.action.targetRaw, item.decimals),
      },
    };
  }
  return { ...base, action: { kind: 'skip-not-requested' } };
}

export function renderSetupPlan(plan: SetupPlan, out: NodeJS.WritableStream): void {
  out.write(`\nApproval setup plan for ${plan.owner}  (${networkLabel(plan.chainId)})\n\n`);

  let usdcExposureRaw = 0n;
  for (const item of plan.items) {
    out.write(renderPlanItemLine(item));
    if (item.action.kind === 'send' && item.token === 'USDC') {
      usdcExposureRaw += item.action.targetRaw;
    }
  }

  if (plan.willSendCount === 0) {
    out.write('\nNothing to do — all requested approvals already in place.\n');
    return;
  }

  if (usdcExposureRaw > 0n) {
    const exposure = isMaxAllowance(usdcExposureRaw)
      ? 'unlimited (max) USDC'
      : `${padDecimal(formatUnits(usdcExposureRaw, 6), 6)} USDC`;
    out.write(`\nMax USDC exposure across new approvals: ${exposure}\n`);
  }
  out.write(`Sends ${plan.willSendCount} ${plan.willSendCount === 1 ? 'tx' : 'txs'} from ${plan.owner}.\n`);
}

function renderPlanItemLine(item: PlanItem): string {
  const moduleLabel = moduleDisplayName(item.spenderModule).padEnd(16);
  const tokenLabel = item.token;
  if (item.action.kind === 'send') {
    const amount = item.action.targetIsMax
      ? `unlimited (max) ${tokenLabel}`
      : `${formatTokenAmount(item.action.targetRaw, item.decimals, tokenLabel)}`;
    const head = `${INDENT}Send  ${moduleLabel}  →  ${amount.padEnd(24)}${item.purpose}`;
    const sub: string[] = [];
    if (item.autoIncluded) {
      sub.push(
        `${INDENT}                              (auto-included alongside --risk-usdc; pass --fee-usdc 0 to skip)`,
      );
    }
    if (item.currentRaw > 0n) {
      sub.push(
        `${INDENT}                              currently ${formatTokenAmount(item.currentRaw, item.decimals, tokenLabel)} approved`,
      );
    }
    return [head, ...sub].join('\n') + '\n';
  }
  if (item.action.kind === 'skip-already-approved') {
    const cur = formatTokenAmount(item.currentRaw, item.decimals, tokenLabel);
    const tgt = formatTokenAmount(item.action.targetRaw, item.decimals, tokenLabel);
    return `${INDENT}Skip  ${moduleLabel}     ${item.purpose}  —  already at ${cur} (≥ requested ${tgt})\n`;
  }
  return `${INDENT}Skip  ${moduleLabel}     ${item.purpose}  —  not requested\n`;
}

function formatTokenAmount(raw: bigint, decimals: number, tokenLabel: string): string {
  if (isMaxAllowance(raw)) return `unlimited (max) ${tokenLabel}`;
  if (decimals === 6) return `${padDecimal(formatUnits(raw, 6), 6)} ${tokenLabel}`;
  return `${trimDecimal(formatUnits(raw, decimals), 6)} ${tokenLabel}`;
}

function moduleDisplayName(spender: PlanItem['spenderModule']): string {
  if (spender === 'positionModule') return 'PositionModule';
  if (spender === 'treasuryModule') return 'TreasuryModule';
  return 'OracleModule';
}

function serializeEntry(spender: string, raw: bigint, decimals: number): JsonAllowanceEntry {
  return {
    spender,
    raw: raw.toString(),
    formatted: formatUnits(raw, decimals),
    isMax: isMaxAllowance(raw),
  };
}

function formatUsdc(raw: bigint): string {
  if (isMaxAllowance(raw)) return 'unlimited (max) USDC';
  return `${padDecimal(formatUnits(raw, 6), 6)} USDC`;
}

function formatLink(raw: bigint): string {
  if (isMaxAllowance(raw)) return 'unlimited (max) LINK';
  // 6 fractional digits is plenty for LINK display — the token is 18
  // decimals but per-call payments are sub-LINK. Trimmed for readability.
  return `${trimDecimal(formatUnits(raw, 18), 6)} LINK`;
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

function shortAddr(addr: string): string {
  if (addr.length < 12) return addr;
  return `(${addr.slice(0, 6)}…${addr.slice(-4)})`;
}

function networkLabel(chainId: number): string {
  if (chainId === 137) return 'Polygon mainnet';
  if (chainId === 80002) return 'Polygon Amoy';
  return 'unknown';
}
