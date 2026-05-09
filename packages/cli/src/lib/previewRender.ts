/**
 * Render a `SubmitPreview` into the §2.5 confirmation block. Goes to
 * stderr so `--json` keeps stdout machine-clean.
 *
 * The renderer reads from the structured model — never re-derives
 * win/lose/push semantics, never re-formats numbers. The SDK's
 * `buildSubmitPreview` is the source of truth; this is dumb formatting.
 */

import type { SubmitPreview } from '@ospex/sdk';

const INDENT = '  ';
const stderr = process.stderr;

export function renderPreview(preview: SubmitPreview, out: NodeJS.WritableStream = stderr): void {
  out.write('\nResolved commitment:\n');
  out.write(`${INDENT}contest:      ${preview.contest.label}\n`);

  const speculationLabel = formatSpeculationLabel(preview);
  out.write(`${INDENT}market:       ${preview.market.type}${speculationLabel}\n`);

  const sideTags = [
    `positionType=${preview.side.positionType === 0 ? 'Upper' : 'Lower'}`,
    `scorer=${shortAddr(preview.raw.scorer)}`,
    `source=${preview.side.resolutionSource}`,
  ];
  out.write(
    `${INDENT}side:         ${preview.side.resolvedLabel} (${preview.side.role})  [${sideTags.join(', ')}]\n`,
  );

  if (preview.market.displayLine !== null) {
    const lineDetail = `[protocol away line_ticks=${formatSignedInt(preview.market.lineTicks)}]`;
    out.write(`${INDENT}line:         ${preview.market.displayLine}  ${lineDetail}\n`);
  }

  out.write(
    `${INDENT}odds:         ${preview.economics.oddsDecimal} decimal / ${preview.economics.oddsAmerican} american  [oddsTick=${preview.economics.oddsTick}]\n`,
  );
  out.write(`${INDENT}risk:         ${preview.economics.riskUSDC} USDC\n`);
  out.write(
    `${INDENT}to win:       ${preview.economics.profitUSDC} USDC  (return = ${preview.economics.returnUSDC} USDC)\n`,
  );
  out.write(
    `${INDENT}expiry:       ${formatExpiry(preview.expiry.unixSec)}  [source=${preview.expiry.source}]\n`,
  );
  if (preview.expiry.afterMatchTime) {
    out.write(
      `${INDENT}              ⚠ expiry is after contest match time — this commitment can remain matchable after start\n`,
    );
  }

  if (preview.market.speculation.mode === 'lazy') {
    out.write(
      `${INDENT}speculation:  not yet created — will be lazily created on first match\n`,
    );
    out.write(
      `${INDENT}              speculationKey=${preview.market.speculation.speculationKey}\n`,
    );
  }

  out.write('\nOutcomes:\n');
  for (const o of preview.outcomes) {
    out.write(`${INDENT}${formatOutcomeLine(o)}\n`);
  }

  const needs = preview.approvals.filter((a) => a.needsApproval);
  if (needs.length > 0) {
    out.write('\nApprovals required (will run before signing):\n');
    for (const a of needs) {
      out.write(
        `${INDENT}${a.token} → ${shortAddr(a.spender)}  current ${a.current}, need ${a.required}\n`,
      );
    }
  }
  out.write('\n');
}

function shortAddr(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}…`;
}

function formatSignedInt(n: number): string {
  if (n > 0) return `+${n}`;
  return String(n);
}

function formatSpeculationLabel(preview: SubmitPreview): string {
  if (preview.market.speculation.mode === 'existing') {
    return ` (#${preview.market.speculation.speculationId})`;
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

function formatOutcomeLine(o: { condition: string; result: string; payoutUSDC: string }): string {
  const arrow = '→';
  if (o.result === 'win') return `${o.condition} ${arrow} you win ${o.payoutUSDC} USDC`;
  if (o.result === 'lose') {
    // payoutUSDC is signed negative for lose rows; render the
    // user-friendly "lose" form regardless of sign.
    const abs = o.payoutUSDC.startsWith('-') ? o.payoutUSDC.slice(1) : o.payoutUSDC;
    return `${o.condition} ${arrow} you lose ${abs} USDC`;
  }
  // push
  return `${o.condition} ${arrow} push (your ${o.payoutUSDC} USDC stake is returned)`;
}
