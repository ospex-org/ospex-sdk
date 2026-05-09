/**
 * Pure formatters for `client.approvals.read()` snapshots — used by
 * `ospex approvals show` for both human and JSON output, and (later) by
 * `ospex doctor` for its allowances section.
 *
 * The rendering is intentionally isolated from the command wiring so
 * the test suite can exercise it on synthetic snapshots without
 * spinning up a chain client.
 */

import { formatUnits } from 'viem';
import type { ApprovalsSnapshot } from '@ospex/sdk';

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
    '\nRun `ospex approvals setup` to add or change. For balances + readiness, run `ospex doctor`.\n',
  );
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
