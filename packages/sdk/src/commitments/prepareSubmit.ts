/**
 * `commitments.prepareSubmit(args)` — domain-language → canonical
 * preview model orchestrator. Pure (modulo API reads for contest /
 * speculation / aliases and chain reads for allowance / nonce).
 *
 * Pipeline:
 *   1. Validate decimal inputs (odds, risk-usdc) early, fail fast.
 *   2. Resolve parent: fetch the speculation (`--speculation`) or the
 *      contest (`--contest --market ...`). Determine market type +
 *      scorer + preliminary lineTicks (away-perspective for spread).
 *   3. Fetch the cached alias set scoped to the contest's sport.
 *   4. Resolve `--side` via §4 algorithm against the contest context.
 *   5. For spread under `--contest --line`: invert the user-supplied
 *      line from selected-side perspective to the protocol's away-side
 *      lineTicks (home selection negates).
 *   6. Compute the canonical speculationKey. Match `(market,
 *      lineTicksProtocol)` against the contest's existing speculations
 *      to determine `mode: 'existing'` vs `mode: 'lazy'`.
 *   7. Read USDC allowance + on-chain nonce floor in parallel.
 *   8. Compute the actual nonce (caller override or strategy).
 *   9. Build the SubmitPreview model via `buildSubmitPreview`.
 *
 * `submitPrepared(preview)` is the companion: it signs `preview.raw`
 * exactly and POSTs to `/v1/commitments`. The split exists so the
 * CLI can render a confirmation prompt between prepare and submit
 * without the SDK doing UI.
 */

import {
  decimalOddsToTick,
  lineDecimalToTicks,
  usdcDecimalToWei6,
} from './decimals.js';
import { buildSubmitPreview } from './buildSubmitPreview.js';
import { resolveSide, type ContestContextForResolve } from './resolveSide.js';
import { readAllowance } from './allowance.js';
import { readNonceFloor } from './nonce.js';
import { nowUnixSec } from './validation.js';
import { deriveSpeculationKey } from '../chain/eip712.js';
import { OspexValidationError } from '../errors.js';
import type { CommitmentsContext } from './context.js';
import type {
  HighLevelSubmitArgs,
  SpeculationMode,
  SubmitPreview,
} from '../types/preview.js';
import type { MarketType } from '../types/odds.js';
import type { Hex } from '../types/signer.js';
import type { Contest, SpeculationDetail } from '../types/contest.js';

const DEFAULT_EXPIRY_OFFSET_SEC = 24n * 60n * 60n;
const ONE_YEAR_SEC = 365n * 24n * 60n * 60n;

interface ResolvedParent {
  /** When `--speculation` was used, the fully-resolved speculation. */
  pinnedSpeculation: SpeculationDetail | null;
  /** When `--contest` was used, the full contest detail. */
  contest: Contest | null;
  market: MarketType;
  scorer: Hex;
  /**
   * Protocol-side lineTicks before potential spread inversion. For
   * spread under `--contest --line`, this is the user's input scaled
   * to ticks; the home/away inversion happens after side resolution.
   */
  preliminaryLineTicks: number;
  userLineProvided: boolean;
}

export async function prepareSubmit(
  ctx: CommitmentsContext,
  args: HighLevelSubmitArgs,
): Promise<SubmitPreview> {
  // ── 1. Decimal inputs ───────────────────────────────────────────────
  const oddsTick = decimalOddsToTick(args.odds);
  const riskWei6 = usdcDecimalToWei6(args.riskUsdc);

  // ── 2. Parent resolution ────────────────────────────────────────────
  const chainId = ctx.getChainId();
  const addresses = ctx.getAddresses();
  const parent = await resolveParent(ctx, args, addresses.scorers as Record<MarketType, Hex>);

  // ── 3. Aliases ──────────────────────────────────────────────────────
  const sport = parent.pinnedSpeculation
    ? parent.pinnedSpeculation.contest.sport
    : parent.contest!.sport;
  const aliases = await ctx.getTeams().aliases({ sport });

  // ── 4. Side resolution ──────────────────────────────────────────────
  const resolverContext: ContestContextForResolve = parent.pinnedSpeculation
    ? {
        awayTeam: parent.pinnedSpeculation.contest.awayTeam,
        homeTeam: parent.pinnedSpeculation.contest.homeTeam,
        awayTeamId: parent.pinnedSpeculation.contest.awayTeamId,
        homeTeamId: parent.pinnedSpeculation.contest.homeTeamId,
      }
    : {
        awayTeam: parent.contest!.awayTeam,
        homeTeam: parent.contest!.homeTeam,
        awayTeamId: parent.contest!.awayTeamId ?? null,
        homeTeamId: parent.contest!.homeTeamId ?? null,
      };
  const resolvedSide = resolveSide(args.side, parent.market, resolverContext, aliases);

  // ── 5. Spread line inversion when home is selected ──────────────────
  // Per proposal §3.1, --line means the *selected side's* displayed
  // line. The protocol stores away-side perspective, so home selection
  // negates the magnitude.
  let lineTicksProtocol = parent.preliminaryLineTicks;
  if (parent.market === 'spread' && parent.userLineProvided && resolvedSide.role === 'home') {
    lineTicksProtocol = -lineTicksProtocol;
  }

  // ── 6. Speculation key + existing/lazy classification ──────────────
  const contestIdBig = parent.pinnedSpeculation
    ? BigInt(parent.pinnedSpeculation.contestId)
    : BigInt(parent.contest!.contestId);
  const scorer = parent.scorer;
  const speculationKey = deriveSpeculationKey(contestIdBig, scorer, lineTicksProtocol);

  let speculation: SpeculationMode;
  if (parent.pinnedSpeculation) {
    speculation = {
      mode: 'existing',
      speculationId: parent.pinnedSpeculation.speculationId,
    };
  } else {
    const exact = (parent.contest!.speculations ?? []).find(
      (s) => s.type === parent.market && (s.lineTicks ?? 0) === lineTicksProtocol,
    );
    if (exact) {
      speculation = { mode: 'existing', speculationId: exact.speculationId };
    } else {
      speculation = { mode: 'lazy', speculationId: null, speculationKey };
    }
  }

  // ── 7. Maker + chain reads ─────────────────────────────────────────
  // Unlocking the signer to read maker is allowed before preview
  // confirmation (signing is what's gated on confirmation). Foundry
  // keystores omit the top-level address field so we may need to
  // decrypt to derive maker.
  const signer = ctx.requireSigner();
  const maker = (await signer.getAddress()).toLowerCase() as Hex;

  const publicClient = ctx.requireChainClient();
  const [usdcAllowance, nonceFloor] = await Promise.all([
    readAllowance(publicClient, addresses.usdc as Hex, maker, addresses.positionModule as Hex),
    readNonceFloor(publicClient, addresses.matchingModule as Hex, maker, speculationKey),
  ]);

  // ── 8. Nonce ─────────────────────────────────────────────────────
  const nowSec = nowUnixSec();
  let nonce: bigint;
  if (args.nonce !== undefined) {
    if (args.nonce < 0n) {
      throw new OspexValidationError('nonce must be non-negative.');
    }
    nonce = args.nonce;
  } else {
    nonce = ctx.nonceCounter.next(maker, speculationKey, nonceFloor, nowSec);
  }

  // ── 9. Expiry ───────────────────────────────────────────────────
  const expirySec = parseExpiry(args.expiry, nowSec);

  // ── 10. Build preview ──────────────────────────────────────────
  const sportFinal = parent.pinnedSpeculation
    ? parent.pinnedSpeculation.contest.sport
    : parent.contest!.sport;
  const matchTime = parent.pinnedSpeculation
    ? parent.pinnedSpeculation.contest.matchTime
    : parent.contest!.matchTime;
  const awayTeam = resolverContext.awayTeam;
  const homeTeam = resolverContext.homeTeam;
  return buildSubmitPreview({
    contestId: contestIdBig,
    awayTeam,
    homeTeam,
    awayTeamId: resolverContext.awayTeamId,
    homeTeamId: resolverContext.homeTeamId,
    sport: sportFinal,
    matchTime,
    market: parent.market,
    scorer,
    lineTicks: lineTicksProtocol,
    speculation,
    resolvedSide,
    sideInput: args.side,
    oddsTick,
    riskWei6,
    maker,
    chainId,
    matchingModuleAddress: addresses.matchingModule as Hex,
    expirySec,
    nonce,
    positionModuleAddress: addresses.positionModule as Hex,
    usdcCurrentAllowanceWei6: usdcAllowance,
  });
}

async function resolveParent(
  ctx: CommitmentsContext,
  args: HighLevelSubmitArgs,
  scorers: Record<MarketType, Hex>,
): Promise<ResolvedParent> {
  if (args.parent.kind === 'speculation') {
    if ((args.parent as { line?: string }).line !== undefined) {
      throw new OspexValidationError(
        '--line cannot be combined with --speculation; the speculation already pins the line.',
      );
    }
    const spec = await ctx.getSpeculationsApi().get(args.parent.speculationId);
    return {
      pinnedSpeculation: spec,
      contest: null,
      market: spec.type,
      scorer: scorers[spec.type],
      preliminaryLineTicks: spec.lineTicks ?? 0,
      userLineProvided: false,
    };
  }

  // --contest path
  const contest = await ctx.getContestsApi().get(args.parent.contestId);
  const market = args.parent.market;

  if (market === 'moneyline') {
    if (args.parent.line !== undefined) {
      throw new OspexValidationError('--line is not valid for moneyline markets.');
    }
    return {
      pinnedSpeculation: null,
      contest,
      market,
      scorer: scorers[market],
      preliminaryLineTicks: 0,
      userLineProvided: false,
    };
  }

  if (args.parent.line !== undefined) {
    return {
      pinnedSpeculation: null,
      contest,
      market,
      scorer: scorers[market],
      preliminaryLineTicks: lineDecimalToTicks(args.parent.line),
      userLineProvided: true,
    };
  }

  // spread/total without --line: try to find an unambiguous unique
  // open speculation at this market type. Per proposal §3.1, multiple
  // matches fail closed, zero requires --line for lazy creation.
  const matches = (contest.speculations ?? []).filter((s) => s.type === market);
  if (matches.length === 0) {
    throw new OspexValidationError(
      `No open ${market} speculation exists on contest ${contest.contestId}. ` +
        'Pass --line to create a new speculation lazily on first match.',
    );
  }
  if (matches.length > 1) {
    const lineList = matches.map((s) => `lineTicks=${s.lineTicks ?? 0}`).join(', ');
    throw new OspexValidationError(
      `Multiple open ${market} speculations exist on contest ${contest.contestId} (${lineList}). ` +
        'Pass --line or --speculation to disambiguate.',
    );
  }
  return {
    pinnedSpeculation: null,
    contest,
    market,
    scorer: scorers[market],
    preliminaryLineTicks: matches[0]!.lineTicks ?? 0,
    userLineProvided: false,
  };
}

/**
 * Resolve the user-supplied expiry (ISO-8601 string OR unix-seconds
 * number/string) to a unix-seconds bigint. Validates the protocol's
 * 1-year-out cap and rejects past timestamps.
 */
function parseExpiry(input: string | number | undefined, nowSec: bigint): bigint {
  let expirySec: bigint;
  if (input === undefined) {
    expirySec = nowSec + DEFAULT_EXPIRY_OFFSET_SEC;
  } else if (typeof input === 'number') {
    expirySec = BigInt(Math.floor(input));
  } else if (/^[0-9]+$/.test(input)) {
    expirySec = BigInt(input);
  } else {
    const ms = Date.parse(input);
    if (Number.isNaN(ms)) {
      throw new OspexValidationError(
        `Invalid --expiry "${input}". Use ISO-8601 (2026-05-09T20:00:00Z) or unix-seconds.`,
      );
    }
    expirySec = BigInt(Math.floor(ms / 1000));
  }
  if (expirySec <= nowSec) {
    throw new OspexValidationError(
      `--expiry must be in the future (got ${expirySec}, now ${nowSec}).`,
    );
  }
  if (expirySec > nowSec + ONE_YEAR_SEC) {
    throw new OspexValidationError(
      `--expiry must be within 1 year of now (got ${expirySec}, max ${nowSec + ONE_YEAR_SEC}).`,
    );
  }
  return expirySec;
}
