/**
 * `ospex commitments list [filters]` — orderbook view of open
 * commitments.
 *
 * Two display modes:
 *
 *   default → taker-centric. Each row shows the team / side the *user*
 *             would be backing if they matched the commitment, the
 *             user's (inverted) odds, the max USDC they can risk to
 *             fully fill, and the profit on full fill. Designed for
 *             quick visual scan ("what bets are available right now,
 *             what do they pay?"). Requires a contest fetch per
 *             distinct `contestId` in the result — joined client-side.
 *   --raw   → protocol view. The row is exactly the on-chain commitment
 *             tuple (positionType=upper/lower, maker's risk, maker's
 *             odds). Kept for orderbook-level inspection (e.g. who's
 *             posting at what price, regardless of the perspective).
 *             Power-user / debugging path.
 *
 * `--json` output is intentionally unaffected by `--raw` / `--side` /
 * `--sort` and renders the protocol commitment list as-is — agent
 * contract stays stable. The taker-view formatting is a CLI-side
 * concern only; agents that want it call `computeTakerView` from the
 * SDK directly.
 *
 * Sorting & filtering (default-mode only — `--raw` and `--json` keep
 * the server-returned order):
 *
 *   --side <team>        filter to rows where the taker would back
 *                        this side. Case-insensitive substring match
 *                        against `youBack`. Handles team names, last-
 *                        token nicknames, and 'over'/'under'.
 *   --sort size|odds|newest
 *                        default: size (largest available maxBet
 *                        first — i.e. biggest bet you can take).
 *                        odds: best taker decimal first.
 *                        newest: newest commitment first.
 */
import { Command } from '@commander-js/extra-typings';
import { z } from 'zod';
import {
  MIN_PREFIX_HEX_LEN,
  computeTakerView,
  tickToAmericanOdds,
  tickToDecimalOdds,
  wei6ToDecimalUSDC,
  type Commitment,
  type CommitmentFillability,
  type Contest,
  type Hex,
  type TakerView,
  type WalletRole,
} from '@ospex/sdk';
import { getClient } from '../../lib/client.js';
import {
  buildAgentEnvelope,
  networkForChainId,
  writeAgentEnvelope,
} from '../../lib/agentEnvelope.js';
import { formatOutput } from '../../lib/format.js';

const SORT_VALUES = ['size', 'odds', 'newest'] as const;

const optionsSchema = z.object({
  json: z.boolean().optional(),
  maker: z.string().optional(),
  scorer: z.string().optional(),
  contestId: z.string().optional(),
  speculation: z.string().optional(),
  status: z.string().optional(),
  includeInvalidated: z.boolean().optional(),
  includeExpired: z.boolean().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  fullHash: z.boolean().optional(),
  raw: z.boolean().optional(),
  side: z.string().min(1).optional(),
  sort: z.enum(SORT_VALUES).optional(),
  withFillability: z.boolean().optional(),
});

export const commitmentsListCommand = new Command('list')
  .description(
    'List open commitments (default: taker-centric — who would you back, your odds, max bet, to win).',
  )
  .option('--json', 'output as JSON (unchanged by --raw / --side / --sort — agent contract is stable)')
  .option('--maker <address>', 'filter by maker address')
  .option('--scorer <address>', 'filter by scorer contract address')
  .option('--contest-id <id>', 'filter by contest id')
  .option('--speculation <id>', 'filter to commitments on a single speculation')
  .option('--status <list>', 'comma-separated statuses (default: open,partially_filled)')
  .option('--include-invalidated', 'include nonce-invalidated commitments')
  .option('--include-expired', 'include expired commitments')
  .option('--limit <n>', 'page size (1-1000)')
  .option('--offset <n>', 'pagination offset')
  .option(
    '--full-hash',
    'human output: show the full 32-byte hash instead of the 0x+8hex truncated form. JSON output always includes the full hash.',
  )
  .option(
    '--raw',
    'render protocol-native columns (positionType=upper/lower, maker risk, maker odds) instead of the default taker-centric view',
  )
  .option(
    '--side <team>',
    'taker-view only: filter to rows where you would be backing this side (substring match against team name, nickname, or "over"/"under")',
  )
  .option(
    '--sort <key>',
    'taker-view only: sort by size (default — largest maxBet first), odds (best taker odds first), or newest (most recent first)',
  )
  .option(
    '--with-fillability',
    'include an advisory maker-funding column/field per row (is the visible liquidity actually backed?). Opt-in, point-in-time — never a guarantee.',
  )
  .action(async (opts) => {
    const parsed = optionsSchema.parse(opts);
    const client = await getClient({ requiresSigner: false });
    const listOpts: Parameters<typeof client.commitments.list>[0] = {};
    if (parsed.maker !== undefined) listOpts.maker = parsed.maker;
    if (parsed.scorer !== undefined) listOpts.scorer = parsed.scorer;
    if (parsed.contestId !== undefined) listOpts.contestId = parsed.contestId;
    if (parsed.speculation !== undefined) listOpts.speculationId = parsed.speculation;
    if (parsed.status !== undefined) listOpts.status = parsed.status;
    if (parsed.includeInvalidated !== undefined) {
      listOpts.includeInvalidated = parsed.includeInvalidated;
    }
    if (parsed.includeExpired !== undefined) {
      listOpts.includeExpired = parsed.includeExpired;
    }
    if (parsed.withFillability !== undefined) {
      listOpts.includeFillability = parsed.withFillability;
    }
    if (parsed.limit !== undefined) listOpts.limit = parsed.limit;
    if (parsed.offset !== undefined) listOpts.offset = parsed.offset;
    const commitments = await client.commitments.list(listOpts);

    // --json: keep the on-chain commitment shape stable for agents.
    // Filters / sort are taker-view concerns and don't apply here.
    if (parsed.json === true) {
      const chainId = client.chainId();
      const wallet: Hex | null =
        parsed.maker !== undefined ? (parsed.maker.toLowerCase() as Hex) : null;
      const walletRole: WalletRole = wallet !== null ? 'filter' : 'none';
      writeAgentEnvelope(
        buildAgentEnvelope({
          ok: true,
          action: 'commitments.list',
          stage: 'read',
          network: networkForChainId(chainId),
          chainId,
          wallet,
          walletRole,
          payload: commitments,
        }),
      );
      return;
    }

    // --raw: protocol view, no contest join. Same as the pre-redesign
    // human output.
    if (parsed.raw === true) {
      renderRaw(commitments, parsed.fullHash === true, parsed.withFillability === true);
      return;
    }

    // Default: taker-centric. Join each commitment to its contest so
    // we have team names for the side resolver.
    const contestsById = await fetchContestsForCommitments(client, commitments);
    const rows = enrich(commitments, contestsById);

    const filtered =
      parsed.side !== undefined ? filterBySide(rows, parsed.side) : rows;
    const sorted = sortRows(filtered, parsed.sort ?? 'size');

    if (sorted.length === 0) {
      process.stdout.write('(no commitments match)\n');
      return;
    }
    formatOutput(
      sorted.map((r) => {
        // Hidden rows redact `marketType` + `fillability` — keep the row in
        // the table for grep-ability but flag the redaction in the market
        // column so the operator sees there's nothing to fill from this row.
        const market = r.commitment.redacted === true
          ? '[hidden]'
          : (r.commitment.marketType ?? '-');
        const funding = r.commitment.redacted === true
          ? '-'
          : fundingLabel(r.commitment.fillability);
        return {
          hash: parsed.fullHash === true
            ? r.commitment.commitmentHash
            : r.commitment.commitmentHash.slice(0, 2 + MIN_PREFIX_HEX_LEN) + '…',
          matchup: r.contest !== null
            ? `${r.contest.awayTeam} @ ${r.contest.homeTeam}`
            : '-',
          market,
          'you back': r.taker?.youBack ?? '-',
          'your odds': r.taker !== null
            ? `${r.taker.takerDecimal} / ${r.taker.takerAmerican}`
            : '-',
          'max bet': r.taker !== null ? `$${r.taker.maxBetUSDC}` : '-',
          'to win': r.taker !== null ? `$${r.taker.toWinUSDC}` : '-',
          ...(parsed.withFillability === true ? { funding } : {}),
        };
      }),
      { json: false },
    );
  });

interface EnrichedRow {
  commitment: Commitment;
  contest: Contest | null;
  taker: TakerView | null;
}

async function fetchContestsForCommitments(
  client: Awaited<ReturnType<typeof getClient>>,
  commitments: Commitment[],
): Promise<Map<string, Contest>> {
  const ids = new Set<string>();
  for (const c of commitments) {
    if (c.contestId !== null) ids.add(c.contestId);
  }
  if (ids.size === 0) return new Map();

  // Fan out the per-contest fetches in parallel. Bounded by the
  // commitments-list page limit (1000), but in practice the distinct
  // contestId count is tiny (handful of active games at a time).
  // `allSettled` so a single missing contest doesn't blow up the
  // whole render — the missing row falls back to '-' columns.
  const results = await Promise.allSettled(
    Array.from(ids).map((id) => client.contests.get(id)),
  );
  const map = new Map<string, Contest>();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      map.set(r.value.contestId, r.value);
    }
  }
  return map;
}

function enrich(
  commitments: Commitment[],
  contestsById: Map<string, Contest>,
): EnrichedRow[] {
  return commitments.map((c) => {
    const contest =
      c.contestId !== null ? contestsById.get(c.contestId) ?? null : null;
    if (contest === null) {
      return { commitment: c, contest: null, taker: null };
    }
    // takerView needs the matchable payload (oddsTick / lineTicks / marketType
    // / remainingRiskAmount) — redacted hidden bodies have none of those. Skip
    // the computation rather than throwing; the table renderer falls back to
    // '-' placeholders for the missing taker columns.
    if (c.redacted === true) {
      return { commitment: c, contest, taker: null };
    }
    try {
      const taker = computeTakerView(c, {
        awayTeam: contest.awayTeam,
        homeTeam: contest.homeTeam,
      });
      return { commitment: c, contest, taker };
    } catch {
      // Corrupt row (missing oddsTick / lineTicks / etc). Render with
      // placeholders rather than crash the whole table.
      return { commitment: c, contest, taker: null };
    }
  });
}

function filterBySide(rows: EnrichedRow[], side: string): EnrichedRow[] {
  const needle = side.toLowerCase().trim();
  return rows.filter((r) => {
    if (r.taker === null) return false;
    return r.taker.youBack.toLowerCase().includes(needle);
  });
}

function sortRows(
  rows: EnrichedRow[],
  key: 'size' | 'odds' | 'newest',
): EnrichedRow[] {
  // Stable sort via Array.prototype.sort on a copy. Rows where the
  // taker view couldn't be computed get pushed to the bottom — they
  // can't be sorted by economics, and a missing-data row at the top
  // of the list is just noise.
  const copy = [...rows];
  copy.sort((a, b) => {
    if (a.taker === null && b.taker === null) return 0;
    if (a.taker === null) return 1;
    if (b.taker === null) return -1;
    if (key === 'size') {
      const av = BigInt(a.taker.maxBetWei6);
      const bv = BigInt(b.taker.maxBetWei6);
      if (av === bv) return 0;
      return av < bv ? 1 : -1; // desc
    }
    if (key === 'odds') {
      // Higher taker decimal = better price for the taker.
      return b.taker.takerOddsTick - a.taker.takerOddsTick;
    }
    // newest. Hidden rows have no `createdAt` in the public allow-list, but
    // by construction `enrich` always sets `taker: null` for them — so the
    // early `taker === null` return above pushed them to the bottom already
    // and we only reach here with visible rows on both sides. The narrow is
    // for the type checker; the runtime guard is the taker-null fast path.
    if (a.commitment.redacted === true || b.commitment.redacted === true) return 0;
    return b.commitment.createdAt.localeCompare(a.commitment.createdAt);
  });
  return copy;
}

function renderRaw(commitments: Commitment[], fullHash: boolean, showFillability: boolean): void {
  if (commitments.length === 0) {
    process.stdout.write('(no commitments)\n');
    return;
  }
  const HIDDEN = '[redacted]';
  formatOutput(
    commitments.map((c) => {
      if (c.redacted === true) {
        // Hidden body — render the allow-list fields plus sentinels for the
        // redacted ones (own-state SSE plan §2.3). `fillability` is never
        // attached to a hidden row at the API boundary.
        return {
          hash: fullHash
            ? c.commitmentHash
            : c.commitmentHash.slice(0, 2 + MIN_PREFIX_HEX_LEN) + '…',
          maker: c.maker,
          contest: c.contestId ?? '-',
          market: HIDDEN,
          line: HIDDEN,
          side: c.positionType === 0 ? 'upper' : c.positionType === 1 ? 'lower' : '-',
          odds: HIDDEN,
          risk: HIDDEN,
          remaining: HIDDEN,
          status: c.status,
          ...(showFillability ? { funding: HIDDEN } : {}),
        };
      }
      return {
        hash: fullHash
          ? c.commitmentHash
          : c.commitmentHash.slice(0, 2 + MIN_PREFIX_HEX_LEN) + '…',
        maker: c.maker,
        contest: c.contestId ?? '-',
        market: c.marketType ?? '-',
        line: c.lineTicks ?? '-',
        side: c.positionType === 0 ? 'upper' : c.positionType === 1 ? 'lower' : '-',
        odds:
          c.oddsTick !== null
            ? `${tickToDecimalOdds(c.oddsTick)} / ${tickToAmericanOdds(c.oddsTick)}`
            : '-',
        risk: formatUSDC(c.riskAmount),
        remaining: formatUSDC(c.remainingRiskAmount),
        status: c.status,
        ...(showFillability ? { funding: fundingLabel(c.fillability) } : {}),
      };
    }),
    { json: false },
  );
}

/**
 * Compact human label for the advisory maker-funding verdict (taker/raw tables).
 * `--with-fillability` only — the field is absent otherwise. JSON output carries
 * the full `fillability` object instead.
 */
function fundingLabel(f: CommitmentFillability | undefined): string {
  if (!f) return '-';
  switch (f.makerFundingStatus) {
    case 'fully_backed':
      return 'backed';
    case 'overcommitted': {
      const pct =
        f.makerCoverageRatioBps !== null ? ` ${(f.makerCoverageRatioBps / 100).toFixed(0)}%` : '';
      return `overcommitted${pct}`;
    }
    case 'stale':
      return 'stale';
    case 'unknown':
      return 'unknown';
  }
}

function formatUSDC(wei6Str: string): string {
  try {
    return wei6ToDecimalUSDC(BigInt(wei6Str));
  } catch {
    // Defensive: if a row arrives with a non-numeric riskAmount string,
    // fall through to the raw value rather than crashing the table.
    return wei6Str;
  }
}
