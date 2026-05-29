/**
 * `commitments.matchFromPreview(preview)` — sign + send the
 * `MatchingModule.matchCommitment(...)` tx for a previously-resolved
 * `MatchPreview`. Companion to `prepareMatch`.
 *
 * Always-revalidate trust model:
 *
 *   Even sub-second freshness can hide critical state changes — the
 *   maker may have cancelled, raised the nonce floor, or had their
 *   commitment partially filled by a competing taker; the speculation
 *   may have transitioned lazy→existing because someone else's match
 *   landed first; the expiry may have crossed the threshold; or the
 *   taker's allowance may have been moved by a separate tx. Sending a
 *   match tx in any of those states would either revert (wasted gas)
 *   or succeed against a different state than what the preview
 *   committed to. So this function ALWAYS re-fetches the commitment
 *   and re-classifies the speculation immediately before signing,
 *   and ALWAYS re-reads the on-chain allowance.
 *
 * Throws `OspexValidationError({ field })` for stale-preview
 * conditions; `OspexAllowanceError` for fresh allowance shortfalls.
 */

import { encodeFunctionData } from 'viem';
import { matchingModuleAbi } from '../contracts/abi/index.js';
import { CommitmentsApi } from '../api/commitments.js';
import { OspexValidationError } from '../errors.js';
import { assertSufficientAllowance } from './allowance.js';
import { requireVisibleCommitment } from './requireVisible.js';
import { buildSignAndSend } from './sendTx.js';
import type { CommitmentsContext } from './context.js';
import type { PublicVisibleCommitment } from '../types/commitment.js';
import type { MatchPreview } from '../types/matchPreview.js';
import type { MatchResult } from './match.js';
import type { Hex } from '../types/signer.js';

export async function matchFromPreview(
  ctx: CommitmentsContext,
  preview: MatchPreview,
): Promise<MatchResult> {
  // ── 1. Sanity: preview must match this client's chain context. ────
  const chainId = ctx.getChainId();
  const addresses = ctx.getAddresses();
  if (preview.chainId !== chainId) {
    throw new OspexValidationError(
      `Preview was prepared for chainId ${preview.chainId}, but this client is configured for chainId ${chainId}. ` +
        'Re-run prepareMatch on a client bound to the correct chain.',
      { field: 'chainId' },
    );
  }
  if (preview.verifyingContract.toLowerCase() !== addresses.matchingModule.toLowerCase()) {
    throw new OspexValidationError(
      `Preview verifyingContract (${preview.verifyingContract}) does not match this client's MatchingModule (${addresses.matchingModule}). ` +
        'Re-run prepareMatch; the addresses module may have been refreshed.',
      { field: 'verifyingContract' },
    );
  }

  // ── 2. Re-fetch commitment + contest in parallel. ─────────────────
  // The fresh API reads catch all the known-revert conditions before
  // we burn gas. Cheap (<1s each), worth doing every time.
  const commitmentsApi = new CommitmentsApi(ctx.api);
  const contestsApi = ctx.getContestsApi();
  const hash = preview.commitment.commitmentHash as Hex;
  const contestId = preview.commitment.contestId as string;
  const [freshResolved, freshContest] = await Promise.all([
    commitmentsApi.get(hash),
    contestsApi.get(contestId),
  ]);

  // The fresh fetch can return a redacted body if the maker raced an off-chain
  // DELETE between preview and match — that's a hard stop, the matchable
  // payload (signature/nonce/odds) is gone from the public surface. Narrow
  // before any field access; downstream sees a single concrete shape.
  const fresh: PublicVisibleCommitment = requireVisibleCommitment(freshResolved, {
    purpose: 'submit a match for',
  });

  // ── 3. Compare canonical signed fields byte-for-byte. ─────────────
  // These are what the EIP-712 signature binds. If the API returns a
  // different value for any of them, the signature on the row is no
  // longer the one the preview committed to — bail.
  assertSignedFieldsUnchanged(preview.commitment, fresh);

  // ── 4. Status / liveness re-check. ────────────────────────────────
  // Key off the RAW on-chain lifecycle (`storedStatus`), NOT the effective `status`. The
  // core API folds book-visibility into effective status — but we already rejected the
  // hidden case in the visibility narrow above, so here we're definitively reading a
  // PUBLIC visible row whose stored lifecycle is the trustworthy matchability signal. The
  // nonce / expiry / remaining-capacity checks below independently cover the conditions
  // effective status otherwise folds in. (`?? fresh.status` mirrors `toCommitment`'s
  // fallback for a core-api predating effective status, where the raw value rides on
  // `status`.)
  const freshLifecycle = fresh.storedStatus ?? fresh.status;
  if (freshLifecycle !== 'open' && freshLifecycle !== 'partially_filled') {
    throw new OspexValidationError(
      `Commitment ${hash} is no longer matchable (on-chain status now '${freshLifecycle}'). State changed since preview; re-run prepareMatch.`,
      { field: 'status' },
    );
  }
  if (fresh.nonceInvalidated) {
    throw new OspexValidationError(
      `Commitment ${hash}'s nonce was invalidated (maker raised the floor). State changed since preview; re-run prepareMatch.`,
      { field: 'nonceInvalidated' },
    );
  }

  // Expiry: the contract reverts with MatchingModule__CommitmentExpired
  // when expiry < block.timestamp. Fail fast here if expiry is already
  // past wall-clock now — the tx wouldn't make it.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const freshExpirySec = parseExpirySec(fresh.expiry);
  if (freshExpirySec === null || freshExpirySec <= nowSec) {
    throw new OspexValidationError(
      `Commitment ${hash} expiry passed (expiry=${fresh.expiry}, now=${nowSec}). State changed since preview; re-run prepareMatch.`,
      { field: 'expiry' },
    );
  }

  // Remaining capacity must still cover the previewed fillMakerRisk.
  const previewFillMakerRiskWei6 = BigInt(preview.economics.fillMakerRiskWei6);
  const freshRemainingWei6 = BigInt(fresh.remainingRiskAmount);
  if (freshRemainingWei6 < previewFillMakerRiskWei6) {
    throw new OspexValidationError(
      `Commitment ${hash} remaining capacity shrunk below the previewed fill ` +
        `(remaining=${freshRemainingWei6}, previewed fill=${previewFillMakerRiskWei6}). ` +
        'Concurrent match consumed liquidity; re-run prepareMatch.',
      { field: 'remainingRiskAmount' },
    );
  }

  // ── 5. Speculation existence re-check. ────────────────────────────
  // If the preview was 'lazy' but a competing match has since created
  // the speculation, the lazy-creation-fee approval row in the preview
  // is no longer accurate (no fee will be charged). The tx would still
  // succeed, but the user/agent was shown a different fee profile —
  // safer to bail and let them re-confirm the simpler picture.
  // Symmetric defense for the (impossible-in-practice) reverse
  // transition — if preview was 'existing' but the spec is now
  // unfindable, something is wrong and we don't trust the preview.
  const lineTicks = fresh.lineTicks as number;
  const marketType = fresh.marketType!;
  const exact = (freshContest.speculations ?? []).find(
    (s) => s.type === marketType && (s.lineTicks ?? 0) === lineTicks,
  );
  const freshMode: 'existing' | 'lazy' =
    exact !== undefined && exact.speculationStatus === 0 ? 'existing' : 'lazy';
  if (exact !== undefined && exact.speculationStatus !== 0) {
    throw new OspexValidationError(
      `Speculation ${exact.speculationId} is now closed (status ${exact.speculationStatus}). State changed since preview; re-run prepareMatch.`,
      { field: 'speculationStatus' },
    );
  }
  if (freshMode !== preview.speculation.mode) {
    throw new OspexValidationError(
      `Speculation existence changed between preview and submit (preview='${preview.speculation.mode}', now='${freshMode}'). ` +
        'A competing match likely landed; re-run prepareMatch to refresh approval requirements.',
      { field: 'speculation' },
    );
  }

  // ── 6. Allowance re-check on chain. ───────────────────────────────
  // Iterate every USDC approval row in the preview and assert each
  // one's `required` against the on-chain allowance for that spender.
  // Two reasons to use the preview's `approvals[]` rather than re-
  // deriving from `economics.takerRiskWei6`:
  //   (a) `commitment-risk` `required` already encodes the self-match
  //       doubling (PositionModule pulls fillMakerRisk + takerRisk
  //       from the same wallet on a self-match). Re-deriving from
  //       takerRiskWei6 alone undercounts and lets a guaranteed
  //       revert through.
  //   (b) Lazy-mode adds a `lazy-creation-fee` row for TreasuryModule
  //       that the prior single-row check ignored entirely. A wallet
  //       that drained its TM allowance between preview and send
  //       would slip past preflight and revert in TreasuryModule's
  //       processSplitFee.
  // Single source of truth = `preview.approvals[]`.
  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const taker = (await signer.getAddress()).toLowerCase() as Hex;
  if (taker !== preview.taker.toLowerCase()) {
    throw new OspexValidationError(
      `Signer address changed since preview (preview taker=${preview.taker}, now=${taker}). ` +
        'Re-run prepareMatch under the current signer.',
      { field: 'taker' },
    );
  }
  for (const row of preview.approvals) {
    if (row.token !== 'USDC') continue;
    await assertSufficientAllowance(
      publicClient,
      addresses.usdc as Hex,
      taker,
      row.spender as Hex,
      BigInt(row.required),
    );
  }

  // ── 7. Build calldata + send tx. ──────────────────────────────────
  // The OspexCommitment struct on chain mirrors the maker's signed
  // payload, NOT the off-chain partial-fill state. We use the preview
  // commitment for these (validated unchanged by step 3) — they
  // round-trip the maker's signature byte-for-byte.
  const c = preview.commitment;
  const data = encodeFunctionData({
    abi: matchingModuleAbi,
    functionName: 'matchCommitment',
    args: [
      {
        maker: c.maker as Hex,
        contestId: BigInt(c.contestId as string),
        scorer: c.scorer as Hex,
        lineTicks: c.lineTicks as number,
        positionType: c.positionType as number,
        oddsTick: c.oddsTick as number,
        riskAmount: BigInt(c.riskAmount),
        nonce: BigInt(c.nonce),
        expiry: BigInt(Math.floor(new Date(c.expiry as string).getTime() / 1000)),
      },
      c.signature as Hex,
      BigInt(preview.economics.takerDesiredRiskWei6),
    ],
  });

  const { txHash, receipt } = await buildSignAndSend({
    publicClient,
    signer,
    chainId,
    to: addresses.matchingModule as Hex,
    data,
  });

  return {
    txHash,
    receipt,
    takerRisk: BigInt(preview.economics.takerRiskWei6),
    fillMakerRisk: previewFillMakerRiskWei6,
    commitment: fresh,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function assertSignedFieldsUnchanged(
  prev: PublicVisibleCommitment,
  fresh: PublicVisibleCommitment,
): void {
  const checks: Array<[keyof PublicVisibleCommitment, string]> = [
    ['maker', 'maker'],
    ['contestId', 'contestId'],
    ['scorer', 'scorer'],
    ['lineTicks', 'lineTicks'],
    ['positionType', 'positionType'],
    ['oddsTick', 'oddsTick'],
    ['marketType', 'marketType'],
    ['riskAmount', 'riskAmount'],
    ['nonce', 'nonce'],
    ['expiry', 'expiry'],
    ['signature', 'signature'],
    ['speculationKey', 'speculationKey'],
  ];
  for (const [key, field] of checks) {
    const a = prev[key];
    const b = fresh[key];
    if (a === null && b === null) continue;
    // Compare lower-cased for hex strings; equal-by-value otherwise.
    const norm = (v: unknown): unknown =>
      typeof v === 'string' ? v.toLowerCase() : v;
    if (norm(a) !== norm(b)) {
      throw new OspexValidationError(
        `Canonical signed field '${field}' changed between preview and re-fetch ` +
          `(preview=${String(a)}, now=${String(b)}). The signature is no longer the one the preview committed to; re-run prepareMatch.`,
        { field },
      );
    }
  }
}

function parseExpirySec(iso: string | null): bigint | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return BigInt(Math.floor(ms / 1000));
}
