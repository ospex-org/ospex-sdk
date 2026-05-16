/**
 * Render a `MatchPreview` into the confirmation block. Goes to stderr
 * so `--json` keeps stdout machine-clean. The SDK is the source of
 * truth for every number and label; this module is dumb formatting.
 *
 * Two layouts:
 *
 *   default → first-person ("you back X, counterparty backs Y, your
 *             risk N, your profit M if X wins") sourced from the
 *             SDK's `preview.you` / `preview.counterparty` /
 *             `preview.outcomes` blocks. Designed so an agent acting
 *             as the taker never has to translate maker/taker labels.
 *   --raw   → the dual-perspective protocol view kept verbatim from
 *             pre-PR-D output for debugging EIP-712 hash mismatches
 *             and protocol-level audits. Mirrors the `commitments
 *             list --raw` pattern.
 *
 * Both layouts share the warning blocks (partial-fill, expired,
 * expires-soon, nonce-invalidated, lazy-creation fee, self-match
 * stake) — the warnings are protocol-truth and stay visible either
 * way.
 */

import {
  computeMatchYouView,
  wei6ToDecimalUSDC,
  type MatchPreview,
  type PreviewApproval,
} from '@ospex/sdk';

export interface RenderMatchPreviewOptions {
  /**
   * When true, render the protocol-native dual maker/taker layout
   * (positionType=Upper/Lower exposed, raw approval wei6, etc.). When
   * false / unset, render the agent-facing first-person layout.
   */
  raw?: boolean;
}

const INDENT = '  ';
const stderr = process.stderr;

export function renderMatchPreview(
  preview: MatchPreview,
  out: NodeJS.WritableStream = stderr,
  opts: RenderMatchPreviewOptions = {},
): void {
  if (opts.raw === true) {
    renderMatchPreviewRaw(preview, out);
    return;
  }
  renderMatchPreviewDefault(preview, out);
}

// ── Default (first-person) layout ─────────────────────────────────────

function renderMatchPreviewDefault(
  preview: MatchPreview,
  out: NodeJS.WritableStream,
): void {
  const view = computeMatchYouView(preview);

  out.write('\nMatch preview:\n');
  out.write(`${INDENT}contest:        ${preview.contest.label}\n`);
  out.write(
    `${INDENT}market:         ${preview.market.type}${formatSpeculationLabel(preview)}\n`,
  );
  out.write('\n');

  if (preview.selfMatch) {
    // Both sides are the same wallet — the "You back / Counterparty"
    // framing collapses ambiguously. Show the dual-stake breakdown
    // and the explicit net wallet outlay instead.
    out.write(
      `${INDENT}⚠ Self-match: you are on both sides of this commitment.\n`,
    );
    out.write(
      `${INDENT}Maker side (you):  ${view.counterparty.backing} at ${view.counterparty.odds.american}  — risks ${view.counterparty.risk.usdc} USDC\n`,
    );
    out.write(
      `${INDENT}Taker side (you):  ${view.you.backing} at ${view.you.odds.american}  — risks ${view.you.risk.usdc} USDC\n`,
    );
    const walletStakeWei6 =
      BigInt(view.you.risk.wei6) + BigInt(view.counterparty.risk.wei6);
    out.write(
      `${INDENT}Position stake from your wallet: ${wei6ToDecimalUSDC(walletStakeWei6)} USDC  (maker fill + taker risk paid by the same wallet)\n`,
    );
  } else {
    const counterpartyAddr = view.counterparty.address ?? '';
    const counterpartyAddrSuffix =
      counterpartyAddr.length > 0 ? `  — maker ${shortAddr(counterpartyAddr)}` : '';
    out.write(
      `${INDENT}You back:       ${view.you.backing} at ${view.you.odds.american}  (decimal ${view.you.odds.decimal})\n`,
    );
    out.write(
      `${INDENT}Counterparty:   ${view.counterparty.backing} at ${view.counterparty.odds.american}  (decimal ${view.counterparty.odds.decimal})${counterpartyAddrSuffix}\n`,
    );
    out.write('\n');
    out.write(
      `${INDENT}Your risk:      ${view.you.risk.usdc} USDC\n`,
    );
    out.write(
      `${INDENT}Your profit:    +${view.you.profit.usdc} USDC  if ${view.you.backing} wins\n`,
    );
    out.write(
      `${INDENT}Maker fill:     ${preview.economics.fillMakerRiskUSDC} USDC of ${preview.economics.remainingMakerRiskUSDC} USDC remaining`,
    );
    if (preview.warnings.includes('partial-fill')) {
      out.write('  (partial fill)\n');
    } else {
      out.write('  (full fill)\n');
    }
    // The ⚠ partial-fill warning is rendered below in the cross-layout
    // warnings section so it also fires for self-match (the file header
    // promises warnings are shared across layouts).
  }

  // Lazy speculation: surface the creation-fee exposure as a separate
  // line so the user doesn't conflate it with the position stake.
  if (preview.speculation.mode === 'lazy') {
    out.write('\n');
    out.write(
      `${INDENT}Speculation:    lazy — created on first match\n`,
    );
    const lc = preview.speculation.lazyCreation!;
    if (preview.selfMatch) {
      out.write(
        `${INDENT}Creation fee exposure: +${lc.totalFeeUSDC} USDC via TreasuryModule  (self-match: same wallet pays both halves)\n`,
      );
    } else {
      out.write(
        `${INDENT}Creation fee exposure: +${lc.takerShareUSDC} USDC via TreasuryModule  (your share if this match triggers creation)\n`,
      );
    }
    if (preview.warnings.includes('maker-treasury-allowance-insufficient')) {
      out.write(
        `${INDENT}                ⚠ maker's TreasuryModule allowance (${lc.makerTreasuryAllowanceUSDC} USDC) is below the maker's share (${lc.makerShareUSDC} USDC).\n`,
      );
      out.write(
        `${INDENT}                  The match will revert; the taker cannot fix this. Wait for the maker to approve, or skip this commitment.\n`,
      );
    }
  }

  out.write('\n');
  out.write(`${INDENT}Expires:        ${formatExpiry(preview.expiry.unixSec)}\n`);
  if (preview.expiry.expired) {
    out.write(
      `${INDENT}                ⚠ commitment is past expiry — match will revert on chain\n`,
    );
  } else if (preview.expiry.expiresSoonMinutes !== null) {
    out.write(
      `${INDENT}                ⚠ expires in ~${preview.expiry.expiresSoonMinutes} min\n`,
    );
  }
  if (preview.warnings.includes('nonce-invalidated')) {
    out.write(
      `${INDENT}                ⚠ commitment's nonce is invalidated — match will revert\n`,
    );
  }
  if (preview.warnings.includes('partial-fill')) {
    out.write(
      `${INDENT}                ⚠ partial fill: this match leaves capacity on the maker commitment\n`,
    );
  }

  // Outcomes block. On non-self-match this is the taker-perspective
  // win / lose / push table (mirrors the existing SubmitPreview
  // render). On self-match the same wallet owns both positions, so
  // wallet-level `you win` / `you lose` rows would be misleading —
  // settlement nets to zero aside from gas/fees. We replace the table
  // with a single explanatory line so the block is still
  // discoverable but never claims wallet-level wins or losses.
  if (preview.selfMatch) {
    out.write('\nOutcomes:\n');
    out.write(
      `${INDENT}Self-match — settlement is wallet-neutral aside from gas/fees.\n`,
    );
  } else if (view.outcomes.length > 0) {
    out.write('\nOutcomes:\n');
    for (const o of view.outcomes) {
      out.write(`${INDENT}${formatOutcomeLine(o)}\n`);
    }
  }

  const needs = preview.approvals.filter((a) => a.needsApproval);
  if (needs.length > 0) {
    out.write('\nApprovals required (will run before signing):\n');
    for (const a of needs) {
      out.write(`${INDENT}${formatApprovalLine(a)}\n`);
    }
  }

  out.write(`\n${INDENT}commitment:     ${preview.commitment.commitmentHash}\n\n`);
}

function formatOutcomeLine(o: {
  condition: string;
  result: 'win' | 'lose' | 'push';
  payoutUSDC: string;
}): string {
  const arrow = '→';
  if (o.result === 'win') return `${o.condition} ${arrow} you win ${o.payoutUSDC} USDC`;
  if (o.result === 'lose') {
    const abs = o.payoutUSDC.startsWith('-') ? o.payoutUSDC.slice(1) : o.payoutUSDC;
    return `${o.condition} ${arrow} you lose ${abs} USDC`;
  }
  return `${o.condition} ${arrow} push (your ${o.payoutUSDC} USDC stake is returned)`;
}

function formatApprovalLine(a: PreviewApproval): string {
  // Convert raw wei6 to USDC for human display. The structured JSON
  // envelope keeps the wei6 strings unchanged; this is presentation-only.
  let currentUSDC: string;
  let requiredUSDC: string;
  try {
    currentUSDC = wei6ToDecimalUSDC(BigInt(a.current));
    requiredUSDC = wei6ToDecimalUSDC(BigInt(a.required));
  } catch {
    // Defensive: fall back to raw if the strings won't parse.
    currentUSDC = a.current;
    requiredUSDC = a.required;
  }
  const moduleLabel = approvalModuleLabel(a);
  return `${a.token} → ${shortAddr(a.spender)}${moduleLabel}  current ${currentUSDC} USDC, need ${requiredUSDC} USDC  [${a.purpose}]`;
}

function approvalModuleLabel(a: PreviewApproval): string {
  if (a.purpose === 'lazy-creation-fee') return ' (TreasuryModule)';
  if (a.purpose === 'commitment-risk') return ' (PositionModule)';
  return '';
}

// ── Raw (protocol-native, dual-perspective) layout ────────────────────
// Preserves the pre-PR-D output verbatim so `--raw` callers debugging
// EIP-712 hashes or protocol audits see exactly what they used to see.

function renderMatchPreviewRaw(
  preview: MatchPreview,
  out: NodeJS.WritableStream,
): void {
  out.write('\nResolved match:\n');
  out.write(`${INDENT}commitment:   ${preview.commitment.commitmentHash}\n`);
  out.write(`${INDENT}contest:      ${preview.contest.label}\n`);
  out.write(
    `${INDENT}market:       ${preview.market.type}${formatSpeculationLabel(preview)}\n`,
  );

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
