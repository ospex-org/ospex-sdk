/**
 * Build the always-present `SpeculationCreationFeeSummary` block that
 * appears on both `MatchPreview.speculation.creationFee` and
 * `SubmitPreview.market.speculation.creationFee`.
 *
 * The summary's contract is "agent reads one field and acts" — see
 * `types/preview.ts:SpeculationCreationFeeSummary`. This helper is the
 * single source of truth for that wire shape; both `buildMatchPreview`
 * and `buildSubmitPreview` call it so a future contract change touches
 * one file.
 *
 * Note on the role/viewer asymmetry: `takerShare` and `makerShare`
 * encode the on-chain role split (50/50, both halves equal); only
 * `viewerShare` collapses self-match doubling. This differs from the
 * legacy `LazyCreationFee` block (which folds the full fee into
 * `takerShareWei6` on self-match to drive the approval row); the legacy
 * block stays as-is for back-compat and the new summary is the cleaner
 * agent surface.
 */

import { wei6ToDecimalUSDC } from './decimals.js';
import type { SpeculationCreationFeeSummary } from '../types/preview.js';

export interface BuildCreationFeeSummaryArgs {
  /** Did `prepare*` classify the speculation as existing or lazy at preview time? */
  mode: 'existing' | 'lazy';
  /**
   * Per-chain `SPECULATION_CREATION_FEE_WEI6`. Ignored on existing-mode
   * (the summary emits zeros regardless). Setting this to 0n on lazy mode
   * is also acceptable — that's the "fee disabled" path for tests / future
   * chains.
   */
  totalFeeWei6: bigint;
  /**
   * Match-time only flag — `viewer.address === maker.address`. Always
   * `false` from a submit preview (no taker has signed). When true on
   * a lazy match, the same wallet pays both role shares and the
   * viewer-share collapses to the full fee.
   */
  selfMatch: boolean;
  /**
   * Which role is signing? `'taker'` for `buildMatchPreview` (the taker
   * is the actor); `'maker'` for `buildSubmitPreview` (the maker is the
   * actor, hypothetical taker hasn't signed yet).
   */
  viewerRole: 'maker' | 'taker';
  /**
   * Current `USDC.allowance(viewer, treasuryModule)`. Drives the
   * `approvalNeeded` derivation against `viewerShareWei6`.
   */
  viewerTreasuryAllowanceWei6: bigint;
  /** TreasuryModule address — emitted as `spender` only when `applies===true`. */
  treasuryModuleAddress: `0x${string}`;
  /**
   * Existing-mode only — feeds the human `note` so the renderer can
   * print `"#123 — already created, no creation fee"`.
   */
  speculationId: string | null;
}

export function buildCreationFeeSummary(
  args: BuildCreationFeeSummaryArgs,
): SpeculationCreationFeeSummary {
  if (args.mode === 'existing' || args.totalFeeWei6 <= 0n) {
    const note =
      args.mode === 'existing'
        ? `Speculation #${args.speculationId ?? '?'} already exists — no creation fee on this match.`
        : 'Speculation creation fee is disabled on this chain — no fee on this match.';
    return {
      applies: false,
      condition: 'never',
      totalFeeWei6: '0',
      totalFeeUSDC: wei6ToDecimalUSDC(0n),
      takerShareWei6: '0',
      takerShareUSDC: wei6ToDecimalUSDC(0n),
      makerShareWei6: '0',
      makerShareUSDC: wei6ToDecimalUSDC(0n),
      viewerShareWei6: '0',
      viewerShareUSDC: wei6ToDecimalUSDC(0n),
      spender: null,
      spenderLabel: null,
      approvalPurpose: null,
      approvalNeeded: false,
      note,
    };
  }

  // Lazy mode with a non-zero fee. Both role shares are exactly half of
  // the total; `viewerShare` collapses self-match doubling.
  const halfWei6 = args.totalFeeWei6 / 2n;
  const takerShareWei6 = halfWei6;
  const makerShareWei6 = halfWei6;
  const viewerRoleShareWei6 =
    args.viewerRole === 'taker' ? takerShareWei6 : makerShareWei6;
  const viewerShareWei6 = args.selfMatch ? args.totalFeeWei6 : viewerRoleShareWei6;
  const approvalNeeded = args.viewerTreasuryAllowanceWei6 < viewerShareWei6;

  const totalFeeUSDC = wei6ToDecimalUSDC(args.totalFeeWei6);
  const halfUSDC = wei6ToDecimalUSDC(halfWei6);
  const viewerUSDC = wei6ToDecimalUSDC(viewerShareWei6);
  const note = args.selfMatch
    ? `Self-match: your wallet pays both halves of the ${totalFeeUSDC} USDC creation fee (${viewerUSDC} USDC total) to TreasuryModule, IF this tx is still the first match at execution time.`
    : `Lazy creation: ${totalFeeUSDC} USDC fee split 50/50 — you pay ${viewerUSDC} USDC, counterparty pays ${halfUSDC} USDC to TreasuryModule, IF this tx is still the first match at execution time.`;

  return {
    applies: true,
    condition: 'if-first-match-at-execution',
    totalFeeWei6: args.totalFeeWei6.toString(),
    totalFeeUSDC,
    takerShareWei6: takerShareWei6.toString(),
    takerShareUSDC: halfUSDC,
    makerShareWei6: makerShareWei6.toString(),
    makerShareUSDC: halfUSDC,
    viewerShareWei6: viewerShareWei6.toString(),
    viewerShareUSDC: viewerUSDC,
    spender: args.treasuryModuleAddress,
    spenderLabel: 'TreasuryModule',
    approvalPurpose: 'lazy-creation-fee',
    approvalNeeded,
    note,
  };
}
