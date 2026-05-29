/**
 * `commitments match` fillability-preflight helpers — partition + rendering.
 *
 * Before sending, `commitments match` runs `checkCommitmentFillability` and
 * refuses an obviously-unfillable match. The match command's OWN approve-loop
 * already remediates the TAKER's PositionModule / TreasuryModule allowance, so
 * a taker-allowance shortfall must NOT block the match — it's expected
 * pre-approval. Only the NON-remediable reasons block: maker balance/allowance,
 * taker balance, and liveness / closed-speculation. `FILLABILITY_UNKNOWN` (an
 * RPC read failed) is advisory — warn, never block (mirrors the SDK primitive's
 * "unknown, not a false not-fillable" stance).
 */
import {
  wei6ToDecimalUSDC,
  type AgentEnvelope,
  type AgentWarning,
  type ChainId,
  type CheckCommitmentFillabilityResult,
  type FillabilityReason,
  type FillabilityReasonCode,
  type Hex,
} from '@ospex/sdk';
import { buildAgentEnvelope, networkForChainId } from './agentEnvelope.js';

/**
 * Reasons the match command's approve-loop remediates on the operator's
 * behalf — a shortfall here is expected before approval and must NOT block.
 */
export const MATCH_REMEDIABLE_REASON_CODES: readonly FillabilityReasonCode[] = [
  'TAKER_POSITION_ALLOWANCE_INSUFFICIENT',
  'TAKER_TREASURY_ALLOWANCE_INSUFFICIENT',
];

/**
 * The blocking subset of a preflight verdict's reasons for the MATCH flow:
 * drops the approve-loop-remediable taker-allowance reasons and the advisory
 * `FILLABILITY_UNKNOWN`. A non-empty result means refuse-before-send.
 */
export function selectBlockingMatchReasons(
  reasons: readonly FillabilityReason[],
): FillabilityReason[] {
  return reasons.filter(
    (r) =>
      r.code !== 'FILLABILITY_UNKNOWN' && !MATCH_REMEDIABLE_REASON_CODES.includes(r.code),
  );
}

/**
 * Codes present in the pre-approval verdict's reasons but absent in the
 * post-approval verdict's reasons, intersected with `MATCH_REMEDIABLE_REASON_CODES`.
 * Empty when:
 *   - the approve loop didn't resolve any remediable reasons (pre-verdict was
 *     clean to begin with, or the same shortfalls are still present), or
 *   - the post-verdict's outcome is `unknown` (the re-check itself failed —
 *     we can't claim a code was "resolved" just because it's missing from a
 *     verdict we couldn't compute).
 */
export function computeMatchRemediatedReasonCodes(
  pre: CheckCommitmentFillabilityResult,
  post: CheckCommitmentFillabilityResult,
): FillabilityReasonCode[] {
  if (post.outcome === 'unknown') return [];
  const postCodes = new Set(post.reasons.map((r) => r.code));
  return MATCH_REMEDIABLE_REASON_CODES.filter(
    (code) => pre.reasons.some((r) => r.code === code) && !postCodes.has(code),
  );
}

/**
 * Does the verdict still carry a remediable taker-allowance reason? If yes, the
 * execute-envelope shoulder should keep its `allowance-short` blocking warning —
 * the approve loop failed to remediate everything (or the verdict is `unknown`
 * with a `FILLABILITY_UNKNOWN` reason, in which case we don't know either way,
 * so we don't claim "resolved").
 */
export function hasRemediableShortfall(
  verdict: CheckCommitmentFillabilityResult,
): boolean {
  return verdict.reasons.some((r) => MATCH_REMEDIABLE_REASON_CODES.includes(r.code));
}

export interface MatchRefusedPayload {
  preflight: CheckCommitmentFillabilityResult;
  action: 'refused-before-send';
}

/** Human-readable, one-line explanation of a reason — funding reasons carry the
 * required-vs-actual amounts, and maker-side reasons spell out that the taker
 * can't remediate them. Exhaustive over `FillabilityReasonCode` (no default arm
 * → a new code is a compile error here). */
export function reasonMessage(r: FillabilityReason): string {
  const amounts =
    r.requiredWei6 !== undefined && r.actualWei6 !== undefined
      ? ` (needs ${wei6ToDecimalUSDC(r.requiredWei6)} USDC, has ${wei6ToDecimalUSDC(r.actualWei6)})`
      : '';
  switch (r.code) {
    case 'MAKER_USDC_BALANCE_INSUFFICIENT':
      return `Maker's USDC balance is short${amounts} — the taker cannot fix this.`;
    case 'MAKER_POSITION_ALLOWANCE_INSUFFICIENT':
      return `Maker's PositionModule USDC allowance is short${amounts} — the taker cannot fix this.`;
    case 'MAKER_TREASURY_ALLOWANCE_INSUFFICIENT':
      return `Maker's TreasuryModule USDC allowance is short for the lazy creation fee${amounts} — the taker cannot fix this.`;
    case 'TAKER_USDC_BALANCE_INSUFFICIENT':
      return `Your USDC balance is short${amounts}.`;
    case 'TAKER_POSITION_ALLOWANCE_INSUFFICIENT':
      return `Your PositionModule USDC allowance is short${amounts} — match approves it before sending.`;
    case 'TAKER_TREASURY_ALLOWANCE_INSUFFICIENT':
      return `Your TreasuryModule USDC allowance is short${amounts} — match approves it before sending.`;
    case 'NOT_LIVE':
      return 'Commitment is not live (cancelled / filled, or missing a required signed field).';
    case 'EXPIRED':
      return 'Commitment is past its expiry; a match would revert.';
    case 'NONCE_INVALIDATED':
      return 'Commitment was invalidated by a raised nonce floor; a match would revert.';
    case 'NO_REMAINING_CAPACITY':
      return 'Commitment has no remaining capacity to fill.';
    case 'SPECULATION_CLOSED':
      return 'The speculation is closed (settled or scored); a match would revert.';
    case 'COMMITMENT_REDACTED':
      return 'Commitment is hidden (book_visible=false); the matchable payload is redacted from anonymous reads and a match cannot be constructed.';
    case 'FILLABILITY_UNKNOWN':
      return 'Fillability could not be determined (an on-chain read failed).';
  }
}

function blockingReasonToWarning(r: FillabilityReason): AgentWarning {
  return {
    code: r.code,
    message: reasonMessage(r),
    severity: 'blocking',
    blockingFor: ['match'],
  };
}

/**
 * Build the v2 envelope for a refused-before-send match: `ok: false`, the
 * blocking reasons surfaced as `blocking` warnings (agent-routable), the full
 * advisory verdict under `payload.preflight`, and `payload.action:
 * 'refused-before-send'`. No `effects` — nothing was signed or sent.
 */
export function buildMatchRefusedEnvelope(
  preflight: CheckCommitmentFillabilityResult,
  blocking: readonly FillabilityReason[],
  args: { chainId: ChainId; wallet: Hex },
): AgentEnvelope<MatchRefusedPayload> {
  return buildAgentEnvelope<MatchRefusedPayload>({
    ok: false,
    action: 'commitments.match',
    stage: 'execute',
    network: networkForChainId(args.chainId),
    chainId: args.chainId,
    wallet: args.wallet,
    walletRole: 'signer',
    signer: args.wallet,
    requiresSignature: true,
    requiresTransaction: true,
    warnings: blocking.map(blockingReasonToWarning),
    payload: { preflight, action: 'refused-before-send' },
  });
}

/** Human (non-JSON) refusal block for stderr. */
export function renderMatchPreflightRefusal(blocking: readonly FillabilityReason[]): string {
  const lines = blocking.map((r) => `  ✗ ${reasonMessage(r)}`).join('\n');
  return (
    '\nMatch preflight: not fillable right now — no transaction sent.\n' +
    `${lines}\n` +
    '\nRe-run with --skip-fillability-preflight (or --force) to send anyway (it will likely revert).\n'
  );
}
