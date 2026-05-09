/**
 * Render a `MatchPreview` into the confirmation block. Goes to stderr
 * so `--json` keeps stdout machine-clean. Mirrors `renderPreview` for
 * `SubmitPreview` — dumb formatting, single source of truth in the SDK.
 */

import { wei6ToDecimalUSDC, type MatchPreview } from '@ospex/sdk';

const INDENT = '  ';
const stderr = process.stderr;

export function renderMatchPreview(
  preview: MatchPreview,
  out: NodeJS.WritableStream = stderr,
): void {
  out.write('\nResolved match:\n');
  out.write(`${INDENT}commitment:   ${preview.commitment.commitmentHash}\n`);
  out.write(`${INDENT}contest:      ${preview.contest.label}\n`);
  out.write(
    `${INDENT}market:       ${preview.market.type}${formatSpeculationLabel(preview)}\n`,
  );

  // Both perspectives so the user sees who's on which side.
  out.write(
    `${INDENT}maker side:   ${preview.makerSide.resolvedLabel} (${preview.makerSide.role})  ${shortAddr(preview.maker)}\n`,
  );
  out.write(
    `${INDENT}taker side:   ${preview.takerSide.resolvedLabel} (${preview.takerSide.role})  ${shortAddr(preview.taker)}\n`,
  );
  if (preview.selfMatch) {
    out.write(
      `${INDENT}              ⚠ self-match: maker address equals taker address\n`,
    );
  }

  if (preview.market.makerLineDisplay !== null) {
    out.write(
      `${INDENT}line:         maker ${preview.market.makerLineDisplay} / taker ${preview.market.takerLineDisplay ?? '-'}  [protocol line_ticks=${formatSignedInt(preview.market.lineTicks)}]\n`,
    );
  }

  out.write(
    `${INDENT}odds:         maker ${preview.odds.makerDecimal} / ${preview.odds.makerAmerican}  →  taker ${preview.odds.takerDecimal} / ${preview.odds.takerAmerican}  [oddsTick=${preview.odds.oddsTick}]\n`,
  );

  // Always show BOTH takerRisk AND fillMakerRisk so the user can verify
  // both sides of the fill in one glance.
  out.write(
    `${INDENT}taker risks:  ${preview.economics.takerRiskUSDC} USDC  to win ${preview.economics.takerProfitOnWinUSDC} USDC  (return = ${preview.economics.takerReturnOnWinUSDC} USDC)\n`,
  );
  out.write(
    `${INDENT}maker fill:   ${preview.economics.fillMakerRiskUSDC} USDC of ${preview.economics.remainingMakerRiskUSDC} USDC remaining\n`,
  );
  if (preview.warnings.includes('partial-fill')) {
    out.write(
      `${INDENT}              ⚠ partial fill: this match leaves capacity on the maker commitment\n`,
    );
  }
  if (preview.selfMatch) {
    // PositionModule.recordFill pulls fillMakerRisk + takerRisk from
    // the same wallet on a self-match, and the renderer's two preceding
    // lines split that into the two sides. Surface the SUM explicitly
    // so the user reads the actual wallet outlay without doing the
    // arithmetic — the corresponding `commitment-risk` approval row's
    // `required` is computed against this same sum.
    const walletStakeWei6 =
      BigInt(preview.economics.takerRiskWei6) +
      BigInt(preview.economics.fillMakerRiskWei6);
    out.write(
      `${INDENT}              ⚠ self-match wallet stake: ${wei6ToDecimalUSDC(walletStakeWei6)} USDC (maker fill + taker risk paid by the same wallet)\n`,
    );
  }

  out.write(
    `${INDENT}expiry:       ${formatExpiry(preview.expiry.unixSec)}\n`,
  );
  if (preview.expiry.expired) {
    out.write(
      `${INDENT}              ⚠ commitment is past expiry — match will revert on chain\n`,
    );
  } else if (preview.expiry.expiresSoonMinutes !== null) {
    out.write(
      `${INDENT}              ⚠ expires in ~${preview.expiry.expiresSoonMinutes} min\n`,
    );
  }

  if (preview.warnings.includes('nonce-invalidated')) {
    out.write(
      `${INDENT}              ⚠ commitment's nonce is invalidated — match will revert\n`,
    );
  }

  if (preview.speculation.mode === 'lazy') {
    out.write(`${INDENT}speculation:  lazy — created on first match\n`);
    out.write(
      `${INDENT}              speculationKey=${preview.speculation.speculationKey}\n`,
    );
    const lc = preview.speculation.lazyCreation!;
    if (preview.selfMatch) {
      out.write(
        `${INDENT}              creation fee: +${lc.totalFeeUSDC} USDC (self-match: same wallet pays both halves)\n`,
      );
    } else {
      out.write(
        `${INDENT}              creation fee: +${lc.takerShareUSDC} USDC taker share / +${lc.makerShareUSDC} USDC maker share (total ${lc.totalFeeUSDC} USDC)\n`,
      );
    }
    if (preview.warnings.includes('maker-treasury-allowance-insufficient')) {
      out.write(
        `${INDENT}              ⚠ maker's TreasuryModule allowance (${lc.makerTreasuryAllowanceUSDC} USDC) is below the maker's share (${lc.makerShareUSDC} USDC).\n`,
      );
      out.write(
        `${INDENT}                The match will revert; the taker cannot fix this. Wait for the maker to approve, or skip this commitment.\n`,
      );
    }
  }

  const needs = preview.approvals.filter((a) => a.needsApproval);
  if (needs.length > 0) {
    out.write('\nApprovals required (will run before signing):\n');
    for (const a of needs) {
      out.write(
        `${INDENT}${a.token} → ${shortAddr(a.spender)}  current ${a.current}, need ${a.required}  [${a.purpose}]\n`,
      );
    }
  }
  out.write('\n');
}

function shortAddr(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatSignedInt(n: number): string {
  if (n > 0) return `+${n}`;
  return String(n);
}

function formatSpeculationLabel(preview: MatchPreview): string {
  if (preview.speculation.mode === 'existing') {
    return ` (#${preview.speculation.speculationId})`;
  }
  return ' (lazy)';
}

function formatExpiry(unixSecStr: string): string {
  const sec = Number(unixSecStr);
  if (!Number.isFinite(sec)) return `[unix=${unixSecStr}]`;
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return `[unix=${unixSecStr}]`;
  const iso = d
    .toISOString()
    .replace(/\.\d{3}Z$/, ' UTC')
    .replace('T', ' ');
  return `${iso}  [unix=${unixSecStr}]`;
}
