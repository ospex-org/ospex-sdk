/**
 * Centralized `nextCommands` template registry — PR-7 of the
 * agent-envelope-v2 migration. PR-1 shipped the empty-registry
 * infrastructure; PR-7 fills it.
 *
 * Each template lives here so the registry is one-shot reviewable
 * instead of scattered across 30 command files. Commands import the
 * named templates and call `.build(params)` in their envelope
 * construction.
 *
 * Hard rules (enforced in `nextCommands.ts`):
 *   - Unique `id` per template.
 *   - `safeToAutoRun: true` only for read-only verifies.
 *   - Max 3 suggestions per envelope (enforced by `buildAgentEnvelope`).
 *
 * Naming convention:
 *   - `verify-*` — read-only follow-up that confirms the prior action.
 *     `safeToAutoRun: true`. `argv` ends with `--json`.
 *   - `complete-*` — execute form of a dry-run. `safeToAutoRun: false`.
 *   - `remediate-*` — fix a known local blocker (typically failures).
 *     `safeToAutoRun: false`.
 */

import { formatUnits } from 'viem';
import {
  OspexAllowanceError,
  getAddresses,
  wei6ToDecimalUSDC,
  type AgentNextCommand,
  type ChainId,
  type Hex,
} from '@ospex/sdk';
import { registerNextCommand } from './nextCommands.js';

/* ------------------------------------------------------------------------- */
/* verify-* — read-only follow-ups (safeToAutoRun: true)                    */
/* ------------------------------------------------------------------------- */

/**
 * After a successful `commitments submit --yes` or `commitments match
 * --yes`, suggest looking up the commitment by hash to confirm
 * status / fill / nonce-floor.
 */
export const VERIFY_COMMITMENT = registerNextCommand({
  id: 'verify-commitment',
  suggestedFor: 'verify',
  safeToAutoRun: true,
  render: (params: { hash: string }) => ({
    description: 'Verify the commitment on-chain by looking up the hash.',
    command: `ospex commitments show ${params.hash} --json`,
    argv: ['commitments', 'show', params.hash, '--json'],
  }),
});

/**
 * After `commitments approve` / `approve-raw` / `approvals setup`,
 * suggest reading the new allowance state.
 */
export const VERIFY_ALLOWANCES = registerNextCommand({
  id: 'verify-allowances',
  suggestedFor: 'verify',
  safeToAutoRun: true,
  render: (params: { address: Hex }) => ({
    description: 'Verify the new USDC + LINK allowances.',
    command: `ospex approvals show --address ${params.address} --json`,
    argv: ['approvals', 'show', '--address', params.address, '--json'],
  }),
});

/**
 * After `claim` / `claim-all` / `settle`, suggest reading position
 * status (active / pendingSettle / claimable buckets) to confirm
 * the change.
 */
export const VERIFY_POSITION_STATUS = registerNextCommand({
  id: 'verify-position-status',
  suggestedFor: 'verify',
  safeToAutoRun: true,
  render: (params: { address: Hex }) => ({
    description: 'Verify position status after the claim / settle.',
    command: `ospex positions status ${params.address} --json`,
    argv: ['positions', 'status', params.address, '--json'],
  }),
});

/**
 * After `contests create` / `score`, suggest reading the contest
 * detail.
 */
export const VERIFY_CONTEST = registerNextCommand({
  id: 'verify-contest',
  suggestedFor: 'verify',
  safeToAutoRun: true,
  render: (params: { contestId: string }) => ({
    description: 'Verify the contest detail (status, speculations, orderbook).',
    command: `ospex contests show ${params.contestId} --json`,
    argv: ['contests', 'show', params.contestId, '--json'],
  }),
});

/**
 * After `cancel-all`, suggest listing live commitments on the
 * speculation to confirm the bulk-invalidate worked.
 */
export const VERIFY_COMMITMENTS_EMPTY = registerNextCommand({
  id: 'verify-commitments-empty',
  suggestedFor: 'verify',
  safeToAutoRun: true,
  render: (params: { maker: Hex; contestId: string }) => ({
    description: 'Verify no live commitments remain for the maker on this contest.',
    command: `ospex commitments list --maker ${params.maker} --contest-id ${params.contestId} --json`,
    argv: [
      'commitments',
      'list',
      '--maker',
      params.maker,
      '--contest-id',
      params.contestId,
      '--json',
    ],
  }),
});

/* ------------------------------------------------------------------------- */
/* complete-* — execute form of a dry-run (safeToAutoRun: false)            */
/* ------------------------------------------------------------------------- */

/**
 * After `cancel-all --dry-run`, suggest the execute form (drop the
 * `--dry-run` flag and add `--yes`).
 */
export const COMPLETE_CANCEL_ALL = registerNextCommand({
  id: 'complete-cancel-all',
  suggestedFor: 'complete',
  safeToAutoRun: false,
  render: (params: {
    contestId: string;
    scorer: Hex;
    lineTicks: number;
    /**
     * Required — the explicit floor passed to the original `--dry-run`
     * call. The CLI's `cancel-all` requires `--new-min-nonce` (anonymous
     * reads cannot enumerate the maker's hidden book, so the SDK doesn't
     * auto-compute a floor). Round-trip the value verbatim.
     */
    newMinNonce: string;
  }) => ({
    description: 'Execute the planned cancel-all.',
    command:
      `ospex commitments cancel-all --contest-id ${params.contestId} ` +
      `--scorer ${params.scorer} --line ${params.lineTicks} ` +
      `--new-min-nonce ${params.newMinNonce} --json`,
    argv: [
      'commitments',
      'cancel-all',
      '--contest-id',
      params.contestId,
      '--scorer',
      params.scorer,
      '--line',
      String(params.lineTicks),
      '--new-min-nonce',
      params.newMinNonce,
      '--json',
    ],
  }),
});

/**
 * After `claim-all --dry-run`, suggest the execute form (drop the
 * `--dry-run` flag).
 */
export const COMPLETE_CLAIM_ALL = registerNextCommand({
  id: 'complete-claim-all',
  suggestedFor: 'complete',
  safeToAutoRun: false,
  render: (params: { address: Hex }) => ({
    description: 'Execute the planned claim sweep.',
    command: `ospex claim-all --address ${params.address} --json`,
    argv: ['claim-all', '--address', params.address, '--json'],
  }),
});

/**
 * After `contests create` returned with `--no-wait` or with a
 * verification that didn't land, suggest the standalone polling
 * helper.
 */
export const COMPLETE_CONTESTS_WAIT_VERIFIED = registerNextCommand({
  id: 'complete-contests-wait-verified',
  suggestedFor: 'complete',
  safeToAutoRun: false,
  render: (params: { contestId: string }) => ({
    description:
      'Poll on-chain ContestModule.getContest until the contest reaches Verified.',
    command: `ospex contests wait-verified ${params.contestId} --json`,
    argv: ['contests', 'wait-verified', params.contestId, '--json'],
  }),
});

/* ------------------------------------------------------------------------- */
/* remediate-* — fix a known local blocker (safeToAutoRun: false)           */
/* ------------------------------------------------------------------------- */

/**
 * For ALLOWANCE_INSUFFICIENT against PositionModule (commitment-risk
 * shortfall). The amount is rounded up from `required` to the
 * nearest USDC unit for a slightly looser allowance so re-runs
 * don't immediately hit the same shortfall on a fresh commitment.
 */
export const REMEDIATE_APPROVE_POSITION = registerNextCommand({
  id: 'remediate-approve-position',
  suggestedFor: 'remediate',
  safeToAutoRun: false,
  render: (params: { requiredUsdc: string }) => ({
    description:
      'Approve USDC for PositionModule (commitment risk). Re-run the original command after the approve tx lands.',
    command: `ospex commitments approve ${params.requiredUsdc} --yes --json`,
    argv: ['commitments', 'approve', params.requiredUsdc, '--yes', '--json'],
  }),
});

/**
 * For ALLOWANCE_INSUFFICIENT against TreasuryModule (lazy-creation
 * fee or contest-creation USDC). Routes through `approvals setup`
 * because `commitments approve` targets PositionModule specifically.
 */
export const REMEDIATE_APPROVE_TREASURY = registerNextCommand({
  id: 'remediate-approve-treasury',
  suggestedFor: 'remediate',
  safeToAutoRun: false,
  render: (params: { requiredUsdc: string }) => ({
    description:
      'Approve USDC for TreasuryModule (protocol fees). Re-run the original command after the approve tx lands.',
    command: `ospex approvals setup --fee-usdc ${params.requiredUsdc} --yes --json`,
    argv: ['approvals', 'setup', '--fee-usdc', params.requiredUsdc, '--yes', '--json'],
  }),
});

/**
 * For ALLOWANCE_INSUFFICIENT against OracleModule (LINK payment for
 * Chainlink Functions). Routes through `approvals setup` for the
 * LINK dimension.
 */
export const REMEDIATE_APPROVE_LINK = registerNextCommand({
  id: 'remediate-approve-link',
  suggestedFor: 'remediate',
  safeToAutoRun: false,
  render: (params: { requiredLink: string }) => ({
    description:
      'Approve LINK for OracleModule (Chainlink Functions). Re-run the original command after the approve tx lands.',
    command: `ospex approvals setup --link ${params.requiredLink} --yes --json`,
    argv: ['approvals', 'setup', '--link', params.requiredLink, '--yes', '--json'],
  }),
});

/* ------------------------------------------------------------------------- */
/* Error → nextCommands helper (failure-envelope wiring)                    */
/* ------------------------------------------------------------------------- */

/**
 * Given a thrown error from a CLI write command, return the
 * appropriate remediation suggestions for the failure envelope.
 *
 * Returns an empty array when the error has no known remediation —
 * the failure envelope still emits cleanly with `errors[]` populated
 * and agents can fall back to their own playbook.
 *
 * Used by per-command catch blocks in commands/*.ts before calling
 * `emitJsonFailure`.
 */
export function deriveRemediationNextCommands(
  err: unknown,
  chainId: ChainId,
): AgentNextCommand[] {
  if (err instanceof OspexAllowanceError) {
    const addresses = getAddresses(chainId);
    const spender = err.spender.toLowerCase();
    if (spender === addresses.positionModule.toLowerCase()) {
      return [
        REMEDIATE_APPROVE_POSITION.build({
          requiredUsdc: wei6ToDecimalUSDC(err.required),
        }),
      ];
    }
    if (spender === addresses.treasuryModule.toLowerCase()) {
      return [
        REMEDIATE_APPROVE_TREASURY.build({
          requiredUsdc: wei6ToDecimalUSDC(err.required),
        }),
      ];
    }
    if (spender === addresses.oracleModule.toLowerCase()) {
      return [
        REMEDIATE_APPROVE_LINK.build({
          requiredLink: formatUnits(err.required, 18),
        }),
      ];
    }
  }
  return [];
}
