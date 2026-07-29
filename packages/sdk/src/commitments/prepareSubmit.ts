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
  parseOddsInput,
  lineDecimalToTicks,
  usdcDecimalToWei6,
} from './decimals.js';
import { buildSubmitPreview } from './buildSubmitPreview.js';
import { SPECULATION_CREATION_FEE_MAKER_SHARE_WEI6 } from '../contracts/constants.js';
import { resolveSide, type ContestContextForResolve } from './resolveSide.js';
import { readAllowance } from './allowance.js';
import { readNonceFloor } from './nonce.js';
import { nowUnixSec, validateCommitmentLineTicks } from './validation.js';
import { deriveSpeculationKey } from '../chain/eip712.js';
import { OspexValidationError } from '../errors.js';
import type { CommitmentsContext } from './context.js';
import type {
  ExpirySource,
  HighLevelSubmitArgs,
  SpeculationMode,
  SubmitPreview,
} from '../types/preview.js';
import type { MarketType } from '../types/odds.js';
import type { Hex } from '../types/signer.js';
import type { Contest, SpeculationDetail } from '../types/contest.js';

/**
 * Fallback used only when contest.matchTime is missing or invalid AND
 * the user did not pass --expiry. Marked with `source =
 * missing-match-time-fallback` in the preview so the user can tell.
 *
 * NOTE: There is intentionally NO general "1h floor" applied to the
 * default. If the contest's match time is, say, 20 minutes from now,
 * the default expiry is 20 minutes from now — exactly at tip-off —
 * not 1 hour from now (which would push expiry past start and create
 * exactly the live-after-pregame-fill risk the default is designed
 * to avoid). Users wanting post-start exposure must opt in via an
 * explicit --expiry.
 */
const MISSING_MATCH_TIME_FALLBACK_SEC = 60n * 60n;
/**
 * Upper bound this path enforces on `--expiry`: 365 days.
 *
 * KNOWN DISCREPANCY (behaviour unchanged, follow-up tracked): the
 * `submitRaw` path's `validateExpiry` caps at 366 days. An expiry between
 * the two is refused here and accepted there. Both messages used to read
 * "1 year", which hid the gap; each now states the bound it actually
 * enforces. Reconciling the two VALUES is a separate change.
 */
const ONE_YEAR_SEC = 365n * 24n * 60n * 60n;

/**
 * Suffix-letter durations accepted by `--expiry` (e.g. "30m", "4h",
 * "1d", "1w"). Values must be a positive integer; "0m", "30x", "4hh"
 * all reject.
 */
const DURATION_RE = /^(\d+)([smhdw])$/;
const DURATION_UNIT_SEC: Record<string, bigint> = {
  s: 1n,
  m: 60n,
  h: 3600n,
  d: 86400n,
  w: 604800n,
};

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
  const oddsTick = parseOddsInput(args.odds);
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

  // ── 6. Total-line invariant ────────────────────────────────────────
  // Block resolves the same trust-model failure that motivated the
  // CLI-input negative-total reject in resolveParent, but here for
  // values that arrived from an existing/pinned speculation row.
  // Total display/outcomes use Math.abs(lineTicks); raw.lineTicks
  // would sign the negative value. Even though negative total specs
  // "shouldn't exist", the raw escape hatch + permissionless lazy
  // creation mean we must fail closed if we ever observe one.
  if (parent.market === 'total' && lineTicksProtocol < 0) {
    throw new OspexValidationError(
      `Total speculation lineTicks must be non-negative (got ${lineTicksProtocol}). ` +
        'Refusing to preview/sign because total display semantics ("Over X" / "Under X" using ' +
        'Math.abs(lineTicks)) would not match the EIP-712 raw tuple.',
    );
  }

  // ── 6b. Line magnitude bound (fund-lock guard) ─────────────────────
  // Final chokepoint on the protocol-side lineTicks the commitment will be
  // signed against — catches BOTH a user `--line` (already screened by
  // lineDecimalToTicks) AND a poisoned value sourced from a pinned/existing
  // speculation row, which `lineDecimalToTicks` never sees. An out-of-range
  // line overflows the spread scorer and permanently locks both sides' escrow
  // at settlement, so refuse to sign it. See validation.ts MAX_LINE_TICKS.
  validateCommitmentLineTicks(lineTicksProtocol);

  // ── 7. Speculation key + existing/lazy classification ──────────────
  const contestIdBig = parent.pinnedSpeculation
    ? BigInt(parent.pinnedSpeculation.contestId)
    : BigInt(parent.contest!.contestId);
  const scorer = parent.scorer;
  const speculationKey = deriveSpeculationKey(contestIdBig, scorer, lineTicksProtocol);

  // Input shape for the speculation discriminator — narrower than the
  // public `SpeculationMode` because `buildSubmitPreview` enriches the
  // lazy variant with `makerCreationFeeUSDC` from the per-chain wei6
  // fee constant. We hand it the bare structural data here.
  let speculation:
    | { mode: 'existing'; speculationId: string }
    | { mode: 'lazy'; speculationId: null; speculationKey: string };
  if (parent.pinnedSpeculation) {
    speculation = {
      mode: 'existing',
      speculationId: parent.pinnedSpeculation.speculationId,
    };
  } else {
    // Search across ALL specs (open + closed) for the exact canonical
    // tuple. The contract's reverse lookup
    //   SpeculationModule:s_speculationLookup[(contestId, scorer, lineTicks)]
    // is permanent — once a closed spec exists at that tuple,
    // PositionModule.recordFill returns the closed id (rather than
    // creating a fresh one) and reverts with
    // `PositionModule__SpeculationNotOpen` at match time. So:
    //
    //   - exact match + open    → existing mode (correct).
    //   - exact match + closed  → reject. We refuse to sign a
    //                             commitment that's guaranteed to
    //                             fail on match.
    //   - no match              → lazy (the protocol will create the
    //                             speculation on first match).
    //
    // The home-side spread inversion compounds this risk: the user's
    // displayed line is selected-side; the canonical tuple is
    // away-side. The check here is on the canonical tuple, so home
    // selection at e.g. `--line -3.5` correctly catches a closed
    // spec stored as `lineTicks=+35`.
    const exact = (parent.contest!.speculations ?? []).find(
      (s) => s.type === parent.market && (s.lineTicks ?? 0) === lineTicksProtocol,
    );
    if (exact) {
      if (exact.speculationStatus !== 0) {
        throw new OspexValidationError(
          `Speculation ${exact.speculationId} on contest ${parent.contest!.contestId} ` +
            `at ${parent.market} lineTicks=${lineTicksProtocol} is closed (settled or scored). ` +
            'The protocol cannot create a fresh speculation at the same (contestId, scorer, lineTicks) ' +
            'tuple, and any commitment posted against it would revert at match time. ' +
            'Pick a different line, a different market, or wait for the next contest.',
        );
      }
      speculation = { mode: 'existing', speculationId: exact.speculationId };
    } else {
      speculation = { mode: 'lazy', speculationId: null, speculationKey };
    }
  }

  // ── 7. Maker + chain reads ─────────────────────────────────────────
  // Two paths for resolving the maker address:
  //   - args.maker set → caller already knows it (CLI `--expected-address`
  //     for preview-only `--json` flows). Skip the signer call so we
  //     don't decrypt or prompt for a passphrase just to render a
  //     preview the agent will inspect before deciding to sign.
  //   - args.maker unset → fall back to the configured signer.
  //
  // The signing step (`submitPrepared`) always uses the real signer,
  // so `args.maker` here is purely for preview-time identity. If the
  // override mismatches the eventual signer at submit time, the
  // server-side EIP-712 hash will simply differ and the API will
  // reject — there's no scenario where this can let someone sign as
  // a different address.
  let maker: Hex;
  if (args.maker !== undefined) {
    maker = args.maker.toLowerCase() as Hex;
  } else {
    const signer = ctx.requireSigner();
    maker = (await signer.getAddress()).toLowerCase() as Hex;
  }

  const publicClient = ctx.requireChainClient();
  // Two USDC allowance reads when this is a lazy commit:
  //   - PositionModule: covers the maker's risk at match time (always
  //     pulled from the maker on every fill).
  //   - TreasuryModule: covers the maker's HALF of the protocol's
  //     speculation creation fee (`processSplitFee`), which fires
  //     ONLY on the first match of a `(contestId, scorer, lineTicks)`
  //     key — i.e. exactly when speculation.mode === 'lazy'. If the
  //     speculation already exists at submit time we skip the second
  //     read; no fee is charged by the contract on subsequent matches.
  // The reads run in parallel with the nonce-floor lookup; gating on
  // lazy-mode is correctness, not perf.
  const isLazy = speculation.mode === 'lazy';
  const [usdcAllowance, treasuryUsdcAllowance, nonceFloor] = await Promise.all([
    readAllowance(publicClient, addresses.usdc as Hex, maker, addresses.positionModule as Hex),
    isLazy
      ? readAllowance(publicClient, addresses.usdc as Hex, maker, addresses.treasuryModule as Hex)
      : Promise.resolve(0n),
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
  const sportFinal = parent.pinnedSpeculation
    ? parent.pinnedSpeculation.contest.sport
    : parent.contest!.sport;
  const matchTime = parent.pinnedSpeculation
    ? parent.pinnedSpeculation.contest.matchTime
    : parent.contest!.matchTime;
  const matchTimeSec = parseMatchTimeToUnixSec(matchTime);
  const { expirySec, source } = parseExpiry(args.expiry, nowSec, matchTimeSec);

  // ── 10. Build preview ──────────────────────────────────────────
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
    // Per-side speculation creation fee for this chain. The preview's
    // lazy variant exposes this as `makerCreationFeeUSDC`; existing
    // mode ignores it. Looked up by chainId so a future chain with a
    // different fee schedule wires through without touching call sites.
    makerCreationFeeWei6: SPECULATION_CREATION_FEE_MAKER_SHARE_WEI6[chainId] ?? 0n,
    expirySec,
    expirySource: source,
    matchTimeSec,
    nonce,
    positionModuleAddress: addresses.positionModule as Hex,
    usdcCurrentAllowanceWei6: usdcAllowance,
    treasuryModuleAddress: addresses.treasuryModule as Hex,
    treasuryUsdcCurrentAllowanceWei6: treasuryUsdcAllowance,
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
    // Refuse to sign a commitment against a closed (settled/scored)
    // speculation — the protocol would reject it and the user has
    // probably mis-typed the id.
    if (spec.speculationStatus !== 0) {
      throw new OspexValidationError(
        `Speculation ${spec.speculationId} is closed (settled or scored) and cannot accept new commitments.`,
      );
    }
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
    let parsed = lineDecimalToTicks(args.parent.line);
    // Total markets are absolute — over and under share the same
    // magnitude. A negative input is almost certainly a copy-paste
    // mistake; if we silently signed against `lineTicks=-85` the
    // preview would render "Over 8.5" via Math.abs() while the EIP-712
    // tuple bound a different speculation key. Reject loudly.
    if (market === 'total' && parsed < 0) {
      throw new OspexValidationError(
        `--line for total markets must be non-negative (got "${args.parent.line}"). ` +
          'Total lines are absolute; the over/under direction is encoded in --side.',
      );
    }
    return {
      pinnedSpeculation: null,
      contest,
      market,
      scorer: scorers[market],
      preliminaryLineTicks: parsed,
      userLineProvided: true,
    };
  }

  // spread/total without --line: try to find an unambiguous unique
  // OPEN speculation at this market type. Per proposal §3.1, multiple
  // matches fail closed, zero requires --line for lazy creation.
  const matches = (contest.speculations ?? []).filter(
    (s) => s.type === market && s.speculationStatus === 0,
  );
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
 * Convert a contest matchTime (ISO-8601 string from the API) to a
 * unix-seconds bigint, or null when missing/invalid. The bigint is
 * what `parseExpiry` compares against; null forces the
 * missing-matchTime branch.
 */
function parseMatchTimeToUnixSec(matchTime: string | undefined | null): bigint | null {
  if (matchTime === undefined || matchTime === null || matchTime === '') return null;
  const ms = Date.parse(matchTime);
  if (Number.isNaN(ms)) return null;
  return BigInt(Math.floor(ms / 1000));
}

interface ParsedExpiry {
  expirySec: bigint;
  source: ExpirySource;
}

/**
 * Resolve the canonical signed expiry plus its provenance.
 *
 * Default rule when `input === undefined`:
 *
 *   1. matchTime is in the future  → expiry = matchTime exactly
 *      (source = 'default-match-time'). No floor, no offset.
 *   2. matchTime is missing/invalid → expiry = now + 1h
 *      (source = 'missing-match-time-fallback').
 *   3. matchTime is in the past    → throws — user must pass --expiry
 *      explicitly to opt into a live/post-start commitment.
 *
 * User-provided values:
 *
 *   - duration string ('30m', '4h', '1d', '1w') → now + duration
 *     (source = 'user-relative')
 *   - decimal-digits-only string                → unix seconds
 *     (source = 'user-unix')
 *   - anything else                             → ISO-8601 / RFC3339
 *     (source = 'user-iso')
 *
 * All paths run through the same future + 365-day-cap validation.
 */
function parseExpiry(
  input: string | number | undefined,
  nowSec: bigint,
  matchTimeSec: bigint | null,
): ParsedExpiry {
  let expirySec: bigint;
  let source: ExpirySource;

  if (input === undefined) {
    if (matchTimeSec === null) {
      // Match time is missing or invalid — fall back to a short window
      // and label the source loudly so the user notices.
      expirySec = nowSec + MISSING_MATCH_TIME_FALLBACK_SEC;
      source = 'missing-match-time-fallback';
    } else if (matchTimeSec <= nowSec) {
      // Match time is in the past — the safe-by-default rule (expiry
      // = matchTime) would already be invalid. Refuse to silently
      // create live exposure; require explicit opt-in.
      throw new OspexValidationError(
        `Cannot default --expiry: contest's scheduled match time has already passed ` +
          `(matchTime=${matchTimeSec}, now=${nowSec}). Pass --expiry explicitly if you ` +
          `intentionally want a live/post-start commitment (e.g. --expiry 30m).`,
      );
    } else {
      // Default case — expire exactly at scheduled match time. No
      // floor, no offset; if the game starts in 5 minutes, the
      // commitment expires in 5 minutes.
      expirySec = matchTimeSec;
      source = 'default-match-time';
    }
  } else if (typeof input === 'number') {
    expirySec = BigInt(Math.floor(input));
    source = 'user-unix';
  } else {
    const durationOffset = parseDurationToSec(input);
    if (durationOffset !== null) {
      expirySec = nowSec + durationOffset;
      source = 'user-relative';
    } else if (/^[0-9]+$/.test(input)) {
      expirySec = BigInt(input);
      source = 'user-unix';
    } else {
      const ms = Date.parse(input);
      if (Number.isNaN(ms)) {
        throw new OspexValidationError(
          `Invalid --expiry "${input}". Accepted forms: ` +
            `ISO-8601 / RFC3339 ("2026-05-09T20:00:00Z" or "...-05:00"), ` +
            `unix-seconds ("1715299200"), ` +
            `or a duration ("30m", "4h", "1d", "1w").`,
        );
      }
      expirySec = BigInt(Math.floor(ms / 1000));
      source = 'user-iso';
    }
  }

  if (expirySec <= nowSec) {
    throw new OspexValidationError(
      `--expiry must be in the future (got ${expirySec}, now ${nowSec}).`,
    );
  }
  if (expirySec > nowSec + ONE_YEAR_SEC) {
    throw new OspexValidationError(
      `--expiry must be within 365 days of now (got ${expirySec}, max ${nowSec + ONE_YEAR_SEC}).`,
    );
  }
  return { expirySec, source };
}

/**
 * Parse a relative-duration string ("30m", "4h", "1d", "1w") to a
 * non-negative bigint of seconds. Returns null when the string isn't
 * a duration (so the caller can fall through to other format
 * detectors); throws when the shape matches a duration but the value
 * is invalid (e.g. "0m").
 */
function parseDurationToSec(input: string): bigint | null {
  const match = DURATION_RE.exec(input);
  if (!match) return null;
  const magnitude = BigInt(match[1]!);
  if (magnitude === 0n) {
    throw new OspexValidationError(
      `Invalid --expiry duration "${input}": magnitude must be > 0 (e.g. "30m", "4h", "1d", "1w").`,
    );
  }
  const unit = match[2]!;
  const seconds = DURATION_UNIT_SEC[unit];
  if (seconds === undefined) {
    // Defensive: the regex only allows [smhdw]; this branch is
    // unreachable but keeps the type-check honest.
    throw new OspexValidationError(`Invalid --expiry duration unit "${unit}".`);
  }
  return magnitude * seconds;
}
