/**
 * `commitments.prepareMatch(args)` — fetch + classify + price the
 * inputs to a `MatchingModule.matchCommitment` call without signing.
 * Companion to `matchFromPreview`, which actually sends the tx (and
 * always re-fetches first to catch state drift).
 *
 * Pipeline:
 *   1. Resolve maker commitment — caller may supply { hash } or a
 *      pre-fetched { commitment } (the CLI's prefix resolver runs the
 *      list path then passes the resolved Commitment in to avoid a
 *      double-fetch). 404 → OspexAPIError; missing required field →
 *      OspexValidationError.
 *   2. Fetch the parent contest (`/v1/contests/:contestId`) for team
 *      labels + the embedded speculations array.
 *   3. Derive speculationKey + classify mode by searching the
 *      contest's speculations for an exact `(marketType, lineTicks)`
 *      match — same algorithm as `prepareSubmit`. A match in a closed
 *      speculation throws (the protocol can't recreate the spec at
 *      that tuple, so a match would revert).
 *   4. Read USDC allowances:
 *        - taker → PositionModule (always; covers takerRisk)
 *        - lazy mode only: taker → TreasuryModule (covers taker's
 *          share of the speculation creation fee) AND maker →
 *          TreasuryModule (informs the maker-allowance warning).
 *   5. Call `buildMatchPreview` with everything pre-fetched.
 */

import { encodeAbiParameters, keccak256 } from 'viem';
import { OspexValidationError } from '../errors.js';
import { buildMatchPreview } from './buildMatchPreview.js';
import { readAllowance } from './allowance.js';
import { SPECULATION_CREATION_FEE_WEI6 } from '../contracts/constants.js';
import type { CommitmentsContext } from './context.js';
import type { Commitment } from '../types/commitment.js';
import type {
  BuildMatchPreviewArgs,
  MatchPreview,
} from '../types/matchPreview.js';
import type { Hex } from '../types/signer.js';
import { CommitmentsApi } from '../api/commitments.js';

export interface PrepareMatchArgs {
  /**
   * Either the commitment's full EIP-712 hash (resolver fetches via
   * `/v1/commitments/:hash`) OR a pre-fetched `Commitment` (passed in
   * by the CLI when it's already been resolved through prefix lookup).
   * Mutually exclusive — pass exactly one.
   */
  hash?: Hex;
  commitment?: Commitment;
  /**
   * Optional override of the taker's desired risk in USDC wei6.
   * Defaults to the commitment's full remaining capacity. Clamped to
   * `commitment.remainingRiskAmount`.
   */
  takerDesiredRiskWei6?: bigint;
}

export async function prepareMatch(
  ctx: CommitmentsContext,
  args: PrepareMatchArgs,
): Promise<MatchPreview> {
  // ── 1. Resolve commitment ─────────────────────────────────────────
  const commitment = await resolveCommitment(ctx, args);

  // Required fields — mirrors `match.ts` so the orchestrator catches
  // the same missing-field cases the convenience wrapper would have.
  // `buildMatchPreview` also re-validates; the early throw here gives
  // a cleaner error surface (no need to plumb half-resolved state into
  // the builder).
  const missing = (
    [
      'signature',
      'contestId',
      'scorer',
      'lineTicks',
      'positionType',
      'oddsTick',
      'marketType',
      'expiry',
    ] as const
  ).filter((k) => commitment[k] === null);
  if (missing.length > 0) {
    const first = missing[0];
    throw new OspexValidationError(
      `Commitment ${commitment.commitmentHash} is missing required fields for match: ${missing.join(', ')}.`,
      first !== undefined ? { field: first } : undefined,
    );
  }

  // ── 2. Fetch parent contest ───────────────────────────────────────
  const contestsApi = ctx.getContestsApi();
  const contest = await contestsApi.get(commitment.contestId as string);

  // ── 3. Speculation key + existing/lazy classification ─────────────
  const contestIdBig = BigInt(commitment.contestId as string);
  const lineTicks = commitment.lineTicks as number;
  const scorer = commitment.scorer as Hex;
  const marketType = commitment.marketType!;
  const speculationKey = deriveSpeculationKey(contestIdBig, scorer, lineTicks);

  // Exact-tuple lookup. Mirrors `prepareSubmit.ts:198-216`. A match in
  // a closed speculation must reject — the protocol can't recreate at
  // the same `(contestId, scorer, lineTicks)` tuple, so the match
  // would revert at PositionModule.recordFill.
  const exact = (contest.speculations ?? []).find(
    (s) => s.type === marketType && (s.lineTicks ?? 0) === lineTicks,
  );
  let speculationMode:
    | { mode: 'existing'; speculationId: string }
    | { mode: 'lazy' };
  if (exact) {
    if (exact.speculationStatus !== 0) {
      throw new OspexValidationError(
        `Speculation ${exact.speculationId} on contest ${contest.contestId} ` +
          `at ${marketType} lineTicks=${lineTicks} is closed (settled or scored). ` +
          'Matching against this commitment would revert at PositionModule.recordFill. ' +
          'Pick a different commitment or wait for the next contest.',
        { field: 'speculationId' },
      );
    }
    speculationMode = { mode: 'existing', speculationId: exact.speculationId };
  } else {
    speculationMode = { mode: 'lazy' };
  }

  // ── 4. Taker address + allowance reads ────────────────────────────
  const signer = ctx.requireSigner();
  const publicClient = ctx.requireChainClient();
  const chainId = ctx.getChainId();
  const addresses = ctx.getAddresses();
  const taker = (await signer.getAddress()).toLowerCase() as Hex;

  // Cross-chain protection: the configured client is bound to one
  // chain. We don't surface `chainId` on the commitment row directly
  // (it's encoded in the maker's signature against the per-chain
  // MatchingModule); rely on the configured `chainId` here and trust
  // the API's network scoping (commitments scoped by `network` column
  // in Supabase). `matchFromPreview` re-checks at execute time.
  void chainId;

  const isLazy = speculationMode.mode === 'lazy';
  const totalFeeWei6 = SPECULATION_CREATION_FEE_WEI6[chainId] ?? 0n;
  const maker = (commitment.maker as Hex).toLowerCase() as Hex;

  const [
    takerPositionAllowanceWei6,
    takerTreasuryAllowanceWei6,
    makerTreasuryAllowanceWei6,
  ] = await Promise.all([
    readAllowance(
      publicClient,
      addresses.usdc as Hex,
      taker,
      addresses.positionModule as Hex,
    ),
    isLazy
      ? readAllowance(
          publicClient,
          addresses.usdc as Hex,
          taker,
          addresses.treasuryModule as Hex,
        )
      : Promise.resolve(0n),
    isLazy
      ? readAllowance(
          publicClient,
          addresses.usdc as Hex,
          maker,
          addresses.treasuryModule as Hex,
        )
      : Promise.resolve(0n),
  ]);

  // ── 5. Build preview ──────────────────────────────────────────────
  const buildArgs: BuildMatchPreviewArgs = {
    commitment,
    chainId,
    matchingModuleAddress: addresses.matchingModule as Hex,
    taker,
    awayTeam: contest.awayTeam,
    homeTeam: contest.homeTeam,
    awayTeamId: contest.awayTeamId ?? null,
    homeTeamId: contest.homeTeamId ?? null,
    sport: contest.sport,
    matchTime: contest.matchTime,
    speculation: speculationMode,
    speculationKey,
    speculationCreationTotalFeeWei6: totalFeeWei6,
    takerTreasuryAllowanceWei6,
    makerTreasuryAllowanceWei6,
    treasuryModuleAddress: addresses.treasuryModule as Hex,
    positionModuleAddress: addresses.positionModule as Hex,
    takerPositionAllowanceWei6,
  };
  if (args.takerDesiredRiskWei6 !== undefined) {
    buildArgs.takerDesiredRiskWei6 = args.takerDesiredRiskWei6;
  }
  return buildMatchPreview(buildArgs);
}

async function resolveCommitment(
  ctx: CommitmentsContext,
  args: PrepareMatchArgs,
): Promise<Commitment> {
  if (args.commitment !== undefined && args.hash !== undefined) {
    throw new OspexValidationError(
      'prepareMatch: pass either { hash } or { commitment }, not both.',
    );
  }
  if (args.commitment !== undefined) return args.commitment;
  if (args.hash === undefined) {
    throw new OspexValidationError(
      'prepareMatch: { hash } or { commitment } is required.',
    );
  }
  const api = new CommitmentsApi(ctx.api);
  return api.get(args.hash);
}

// Local re-implementation of `deriveSpeculationKey` to keep the
// orchestrator self-contained without importing through the chain/
// barrel. The math mirrors `chain/eip712.ts:92-106`.
function deriveSpeculationKey(
  contestId: bigint,
  scorer: Hex,
  lineTicks: number,
): Hex {
  const encoded = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'int32' }],
    [contestId, scorer, lineTicks],
  );
  return keccak256(encoded);
}
