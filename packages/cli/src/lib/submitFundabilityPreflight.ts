/**
 * `commitments submit` fundability-preflight helpers — partition + rendering.
 *
 * Before signing + POSTing, `commitments submit` runs `checkSubmitFundability`
 * and refuses a submit the maker obviously can't back. The maker's own
 * allowance shortfalls are remediable (the submit approve-loop, or a separate
 * `ospex commitments approve`, raises them — so blocking would regress the
 * normal approve-on-submit flow); only the NON-remediable USDC balance
 * shortfall blocks. `EXISTING_LAZY_FEE_UNDETERMINED` and `FUNDABILITY_UNKNOWN`
 * are advisory — warn, never block (mirrors the SDK primitive's "unknown, not a
 * false not-fundable" stance, and `match`'s preflight).
 */
import {
  wei6ToDecimalUSDC,
  type AgentEnvelope,
  type AgentWarning,
  type ChainId,
  type CheckSubmitFundabilityResult,
  type SubmitFundabilityReason,
  type SubmitFundabilityReasonCode,
  type Hex,
} from '@ospex/sdk';
import { buildAgentEnvelope, networkForChainId } from './agentEnvelope.js';

/**
 * Reasons the maker can fix by approving more USDC — the submit approve-loop
 * prompts for exactly this (and a maker can always `ospex commitments approve`),
 * so a shortfall here is expected pre-approval and must NOT block.
 */
export const SUBMIT_REMEDIABLE_REASON_CODES: readonly SubmitFundabilityReasonCode[] = [
  'MAKER_POSITION_ALLOWANCE_INSUFFICIENT',
  'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT',
];

/**
 * The blocking subset of a fundability verdict's reasons for the SUBMIT flow:
 * drops the approve-loop-remediable maker-allowance reasons and the advisory
 * `EXISTING_LAZY_FEE_UNDETERMINED` / `FUNDABILITY_UNKNOWN`. What remains is the
 * non-remediable `MAKER_USDC_BALANCE_INSUFFICIENT` (you can't approve USDC into
 * existence). A non-empty result means refuse-before-sign.
 */
export function selectBlockingSubmitReasons(
  reasons: readonly SubmitFundabilityReason[],
): SubmitFundabilityReason[] {
  return reasons.filter(
    (r) =>
      r.code !== 'FUNDABILITY_UNKNOWN' &&
      r.code !== 'EXISTING_LAZY_FEE_UNDETERMINED' &&
      !SUBMIT_REMEDIABLE_REASON_CODES.includes(r.code),
  );
}

/**
 * Codes present in the pre-approval verdict's reasons but absent in the
 * post-approval verdict's reasons, intersected with `SUBMIT_REMEDIABLE_REASON_CODES`.
 * Empty when:
 *   - the approve loop didn't resolve any remediable reasons, or
 *   - the post-verdict's outcome is `unknown` (the re-check itself failed —
 *     we can't claim a code was "resolved" from a verdict we couldn't compute).
 */
export function computeSubmitRemediatedReasonCodes(
  pre: CheckSubmitFundabilityResult,
  post: CheckSubmitFundabilityResult,
): SubmitFundabilityReasonCode[] {
  if (post.outcome === 'unknown') return [];
  const postCodes = new Set(post.reasons.map((r) => r.code));
  return SUBMIT_REMEDIABLE_REASON_CODES.filter(
    (code) => pre.reasons.some((r) => r.code === code) && !postCodes.has(code),
  );
}

/**
 * Does the verdict still carry a remediable maker-allowance reason? If yes, the
 * execute-envelope shoulder should keep its `allowance-short` blocking warning
 * — the approve loop failed to fully remediate (or the verdict is `unknown`).
 */
export function hasRemediableShortfall(
  verdict: CheckSubmitFundabilityResult,
): boolean {
  return verdict.reasons.some((r) => SUBMIT_REMEDIABLE_REASON_CODES.includes(r.code));
}

/** Human-readable, one-line explanation of a reason. Funding reasons carry the
 * required-vs-actual amounts; the balance reason spells out that approving won't
 * fix it. Exhaustive over `SubmitFundabilityReasonCode` (no default arm → a new
 * code is a compile error here). */
export function submitFundabilityReasonMessage(r: SubmitFundabilityReason): string {
  const amounts =
    r.requiredWei6 !== undefined && r.actualWei6 !== undefined
      ? ` (needs ${wei6ToDecimalUSDC(r.requiredWei6)} USDC, has ${wei6ToDecimalUSDC(r.actualWei6)})`
      : '';
  switch (r.code) {
    case 'MAKER_USDC_BALANCE_INSUFFICIENT':
      return `Your USDC balance can't back your open commitments plus this one${amounts} — fund the wallet (approving won't help).`;
    case 'MAKER_POSITION_ALLOWANCE_INSUFFICIENT':
      return `Your PositionModule USDC allowance is short for your whole open book${amounts} — approve at least that much (or "max") so every commitment stays fillable.`;
    case 'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT':
      return `Your TreasuryModule USDC allowance is short for this submit's lazy creation fee${amounts} — approve it before the speculation is created.`;
    case 'EXISTING_LAZY_FEE_UNDETERMINED': {
      const max = r.requiredWei6 !== undefined ? ` (up to ${wei6ToDecimalUSDC(r.requiredWei6)} USDC)` : '';
      return `You have existing open commitments that might each owe a speculation-creation fee${max}; fundability can't be confirmed without per-speculation checks.`;
    }
    case 'HIDDEN_EXPOSURE_UNKNOWN':
      return 'Whole-book fundability could not be determined: your book-hidden exposure could not be read from own-state (no matching signer, or the owner-auth read was unavailable). The visible book is covered; hidden exposure is not.';
    case 'FUNDABILITY_UNKNOWN':
      return 'Fundability could not be determined (an on-chain read or the open-book list failed).';
  }
}

/**
 * A blocking reason → a `blocking` agent warning that blocks `submit`. The
 * fundability verdict otherwise rides `payload.fundability` (the full verdict +
 * `reasons[]`), NOT the proceed envelope's `warnings[]` — mirroring `match`'s
 * `payload.fillability`; only a refusal's blocking reasons become warnings here.
 */
function blockingReasonToWarning(r: SubmitFundabilityReason): AgentWarning {
  return {
    code: r.code,
    message: submitFundabilityReasonMessage(r),
    severity: 'blocking',
    blockingFor: ['submit'],
  };
}

export interface SubmitRefusedPayload {
  fundability: CheckSubmitFundabilityResult;
  action: 'refused-before-sign';
}

/**
 * Build the v2 envelope for a refused-before-sign submit: `ok: false`, the
 * blocking reason(s) surfaced as `blocking` warnings (agent-routable), the full
 * advisory verdict under `payload.fundability`, and `payload.action:
 * 'refused-before-sign'`. No `effects` — nothing was signed or posted.
 */
export function buildSubmitRefusedEnvelope(
  fundability: CheckSubmitFundabilityResult,
  blocking: readonly SubmitFundabilityReason[],
  args: { chainId: ChainId; wallet: Hex },
): AgentEnvelope<SubmitRefusedPayload> {
  return buildAgentEnvelope<SubmitRefusedPayload>({
    ok: false,
    action: 'commitments.submit',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.wallet,
    walletRole: 'signer',
    signer: args.wallet,
    requiresSignature: true,
    // submit POSTs the signed EIP-712 commitment off-chain — no tx (matches the
    // preview/execute submit envelopes). The on-chain pull happens later, at match.
    requiresTransaction: false,
    warnings: blocking.map(blockingReasonToWarning),
    payload: { fundability, action: 'refused-before-sign' },
  });
}

/** Human (non-JSON) refusal block for stderr. */
export function renderSubmitPreflightRefusal(blocking: readonly SubmitFundabilityReason[]): string {
  const lines = blocking.map((r) => `  ✗ ${submitFundabilityReasonMessage(r)}`).join('\n');
  return (
    '\nSubmit preflight: you can\'t back this commitment right now — nothing signed.\n' +
    `${lines}\n` +
    '\nFund the wallet and retry, or re-run with --skip-fundability-preflight (or --force) to sign anyway (the commitment would be unfillable).\n'
  );
}

/**
 * Human (non-JSON) advisory block for the PROCEED path — the verdict had
 * non-blocking reasons (remediable allowance shortfalls, lazy-fee uncertainty,
 * or a degraded read). Returns `''` when the verdict is clean (`fundable` with
 * no reasons), so the caller can skip writing anything.
 */
export function renderSubmitFundabilityNotice(verdict: CheckSubmitFundabilityResult): string {
  if (verdict.reasons.length === 0) return '';
  const lines = verdict.reasons.map((r) => `  ⚠ ${submitFundabilityReasonMessage(r)}`).join('\n');
  return `\nSubmit preflight (advisory):\n${lines}\n`;
}
