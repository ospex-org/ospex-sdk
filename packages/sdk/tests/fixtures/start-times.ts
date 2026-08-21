/**
 * Wire-valid start-time fixture matrices, plus the guards that keep them that
 * way. Shared by `api.test.ts` and `stream-decoders.test.ts` so there is one
 * copy of the rule rather than two that drift.
 *
 * ── WHY A MATRIX RATHER THAN ONE FIXTURE PER SURFACE ────────────────────────
 *
 * Two requirements pull against each other here.
 *
 * (1) A shared timestamp literal hides a positional swap. Two same-typed
 *     fields carrying one value make a mapper that assigns each to the other's
 *     key indistinguishable from a correct one. Measured at this branch's
 *     starting point: `chainStartTime` and `gameMatchTime` shared a literal,
 *     and swapping those two assignments in `toContest`, the speculation
 *     parent-context mapper, `decodeContestUpdate` and `contestToUpdate` left
 *     the suite green in all four places.
 *
 * (2) `matchTime` is NOT independent. core-api serves it from the
 *     `contests_effective` view as `LEAST(c.start_time, g.match_time,
 *     g.earliest_match_time, <guarded rundown>, <guarded sportspage>)`, and a
 *     LEAST over a set equals one of that set's members. So `matchTime` sits
 *     strictly below every served input in no body core-api can produce, and a
 *     fixture asserting otherwise is testing a shape that does not exist.
 *
 * Giving every field a distinct value satisfies (1) and violates (2). Making
 * `matchTime` equal its minimum satisfies (2) and re-creates exactly one
 * invisible pair per fixture — `matchTime` against whichever input is the
 * driver.
 *
 * The matrix resolves it: a DIFFERENT input drives the minimum in each row, so
 * no single pair is shared across the whole matrix. A swap between `matchTime`
 * and `gameEarliestMatchTime` is invisible only in the row where the floor IS
 * the minimum, and dies in the four rows where something else is.
 *
 * ── THE MAINTENANCE RULE, WHICH IS ASSERTED RATHER THAN DOCUMENTED ──────────
 *
 * For every orderable pair of start-time fields there is at least one row in
 * which the two carry different values. `expectMatrixSeparatesEveryPair` walks
 * the pairs and fails naming any that no row separates, so adding a field —
 * or editing a row until it stops separating the last pair it was carrying —
 * reddens instead of quietly un-discriminating the suite. Adding a start-time
 * field to a surface means adding it to that surface's field list here.
 *
 * Two narrower rules run beside it:
 *
 *   - `expectStartTimeInputsDistinct` — within one row, no two non-sentinel
 *     INPUTS share a value. `matchTime` is excluded because it must tie its
 *     driver. The wire permits two inputs to coincide; these fixtures
 *     deliberately do not, so a per-row swap between any two inputs reddens
 *     without waiting for another row to catch it.
 *   - `expectWireValidStartTimes` — `matchTime` equals the minimum of the
 *     row's ADMITTED inputs, which is the property the reviewer found
 *     violated. It checks the fixture against core-api's contract, not the SDK
 *     against anything; both sides of its comparison come from the fixture.
 *
 * ── THE FRESHNESS GUARD IS THE SECOND LEVER ─────────────────────────────────
 *
 * A provider snapshot enters the LEAST only through
 * `CASE WHEN snapshot >= g.match_time - interval '1 hour' THEN snapshot END`
 * (ospex-indexer migration 072; `/v1/games` re-implements the same rule in JS
 * as `SNAPSHOT_FRESHNESS_MICROS`). A snapshot further than an hour below the
 * feed value is STALE and excluded, so it can legitimately sit below
 * `matchTime` without moving it — the shape the SDK's own field docs describe
 * when they say a snapshot well below `gameMatchTime` may simply be stale.
 * That widens what a wire-valid row can look like, and it is exercised in both
 * directions: `expectStaleSnapshotExcluded` and `expectFreshSnapshotDrivesMin`
 * assert inline which case a row is, so a later edit to one of those
 * timestamps cannot silently turn a stale row into a fresh one.
 *
 * Sources, read on ospex-core-api `main` (989b661) and ospex-indexer:
 *   - `src/v1/contests.ts` — the six contest-shaped time fields, the `?? ''`
 *     projections, and the note that `matchTime` always equals at least one
 *     served input.
 *   - `src/v1/games.ts` — `effectiveMatchTime`, the chain-less input set, and
 *     the `null` (not `""`) convention on that endpoint.
 *   - `migrations/072_bounded_provider_time_min.sql` — the view's LEAST and
 *     the one-hour CASE.
 */

/** The freshness window, in ms. Mirrors core-api's `interval '1 hour'`. */
export const SNAPSHOT_FRESHNESS_MS = 3_600_000;

/**
 * The only timestamp rendering these fixtures use. The guards refuse anything
 * else rather than ordering it: `Date.parse` truncates below milliseconds and
 * reads a zone-less value in local time, so an offset form or a sub-second
 * value would compare wrong here while core-api's real bound is computed in
 * Postgres at microsecond resolution. Refusing is the honest bound — these
 * helpers order fixture literals, they do not model `timestamptz`.
 */
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function instantMs(iso: string, where: string): number {
  if (!CANONICAL_UTC.test(iso)) {
    throw new Error(
      `${where}: ${JSON.stringify(iso)} is not canonical UTC-to-the-second; ` +
        'these guards order fixture literals only and refuse any other rendering.',
    );
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`${where}: ${JSON.stringify(iso)} is not a real instant`);
  }
  // `Date.parse` ROLLS OVER an impossible day rather than refusing it —
  // measured on Node 22, `2026-02-30T00:00:00Z` parses as March 2 — so a
  // typo'd fixture date would silently become a different instant and the
  // ordering above would be about a day nobody wrote. The round trip is what
  // catches it; core-api's own parser guards the same rollover.
  if (new Date(ms).toISOString().replace(/\.000Z$/, 'Z') !== iso) {
    throw new Error(
      `${where}: ${JSON.stringify(iso)} is not a real calendar day — it round-trips as ` +
        JSON.stringify(new Date(ms).toISOString()),
    );
  }
  return ms;
}

// ── contest-shaped surfaces (list, detail, parent context, stream) ──────────

/**
 * The six start-time fields every contest-shaped body carries. `""` is the
 * sentinel on these surfaces — core-api coalesces each nullable column with
 * `?? ''`.
 */
// A type alias rather than an interface, deliberately: only an alias of an
// object literal type carries the implicit index signature that
// `expectMatrixSeparatesEveryPair`'s `Record<string, string | null>`
// constraint needs.
export type ContestStartTimes = {
  matchTime: string;
  chainStartTime: string;
  gameMatchTime: string;
  gameEarliestMatchTime: string;
  gameRundownMatchTime: string;
  gameSportspageMatchTime: string;
};

export interface ContestStartTimeCase {
  /** Stable handle a test names, so deleting a row fails loudly. */
  readonly id: string;
  /** Which input drives the served minimum, and what shape the row models. */
  readonly why: string;
  readonly served: ContestStartTimes;
}

export const CONTEST_START_TIME_FIELDS = [
  'matchTime',
  'chainStartTime',
  'gameMatchTime',
  'gameEarliestMatchTime',
  'gameRundownMatchTime',
  'gameSportspageMatchTime',
] as const;

/** The inputs the view minimises over. `matchTime` is the output, not an input. */
const CONTEST_INPUT_FIELDS = [
  'chainStartTime',
  'gameMatchTime',
  'gameEarliestMatchTime',
  'gameRundownMatchTime',
  'gameSportspageMatchTime',
] as const;

const CONTEST_SNAPSHOT_FIELDS = ['gameRundownMatchTime', 'gameSportspageMatchTime'] as const;

export const CONTEST_START_TIME_MATRIX: readonly ContestStartTimeCase[] = [
  {
    id: 'chain-start-drives',
    why: 'the on-chain start is the minimum; the feed has since moved the game later',
    served: {
      matchTime: '2026-05-02T22:40:00Z',
      chainStartTime: '2026-05-02T22:40:00Z',
      gameMatchTime: '2026-05-02T23:20:00Z',
      gameEarliestMatchTime: '2026-05-02T23:05:00Z',
      gameRundownMatchTime: '2026-05-02T23:10:00Z',
      gameSportspageMatchTime: '2026-05-02T23:35:00Z',
    },
  },
  {
    id: 'feed-value-drives',
    why:
      'the raw odds-feed schedule is the minimum. The floor sits ABOVE it here, ' +
      'which core-api documents as reachable (a floor-only operator remedy) and ' +
      'explicitly does not treat as an invariant violation',
    served: {
      matchTime: '2026-05-03T00:45:00Z',
      chainStartTime: '2026-05-03T01:15:00Z',
      gameMatchTime: '2026-05-03T00:45:00Z',
      gameEarliestMatchTime: '2026-05-03T01:30:00Z',
      gameRundownMatchTime: '2026-05-03T00:55:00Z',
      gameSportspageMatchTime: '2026-05-03T01:05:00Z',
    },
  },
  {
    id: 'retained-floor-drives',
    why: 'the retained safety floor is the minimum — a move-up the feed has rolled back',
    served: {
      matchTime: '2026-05-03T23:50:00Z',
      chainStartTime: '2026-05-04T00:30:00Z',
      gameMatchTime: '2026-05-04T00:20:00Z',
      gameEarliestMatchTime: '2026-05-03T23:50:00Z',
      gameRundownMatchTime: '2026-05-04T00:05:00Z',
      gameSportspageMatchTime: '2026-05-04T00:25:00Z',
    },
  },
  {
    id: 'fresh-rundown-drives',
    why:
      'a FRESH rundown snapshot is the minimum — 25 minutes below the feed value, ' +
      'inside the one-hour window, so the view admits it',
    served: {
      matchTime: '2026-05-05T22:45:00Z',
      chainStartTime: '2026-05-05T23:30:00Z',
      gameMatchTime: '2026-05-05T23:10:00Z',
      gameEarliestMatchTime: '2026-05-05T23:05:00Z',
      gameRundownMatchTime: '2026-05-05T22:45:00Z',
      gameSportspageMatchTime: '2026-05-05T23:20:00Z',
    },
  },
  {
    id: 'stale-rundown-excluded',
    why:
      'the rundown snapshot is 1h45m below the feed value — STALE, excluded from the ' +
      'LEAST — so it sits below matchTime without moving it, while the fresh ' +
      'sportspage snapshot 25 minutes below the feed value is the minimum',
    served: {
      matchTime: '2026-05-06T02:15:00Z',
      chainStartTime: '2026-05-06T02:50:00Z',
      gameMatchTime: '2026-05-06T02:40:00Z',
      gameEarliestMatchTime: '2026-05-06T02:35:00Z',
      gameRundownMatchTime: '2026-05-06T00:55:00Z',
      gameSportspageMatchTime: '2026-05-06T02:15:00Z',
    },
  },
  {
    id: 'unverified-linked',
    why:
      'the pre-verification window: contests.start_time is still NULL, so ' +
      'chainStartTime is the "" sentinel beside real game-derived values and the ' +
      'minimum runs over the games columns alone. The list endpoint filters these ' +
      'rows out (`start_time IS NOT NULL`); detail, parent-context and stream do not',
    served: {
      matchTime: '2026-05-07T00:50:00Z',
      chainStartTime: '',
      gameMatchTime: '2026-05-07T01:20:00Z',
      gameEarliestMatchTime: '2026-05-07T00:50:00Z',
      gameRundownMatchTime: '2026-05-07T01:10:00Z',
      gameSportspageMatchTime: '2026-05-07T01:25:00Z',
    },
  },
  {
    id: 'unlinked',
    why:
      'no games row: the LEFT JOIN side is NULL, every game-derived companion is ' +
      'the "" sentinel, and the LEAST collapses to the chain start alone — so ' +
      'matchTime and chainStartTime AGREE rather than differing',
    served: {
      matchTime: '2026-05-08T01:05:00Z',
      chainStartTime: '2026-05-08T01:05:00Z',
      gameMatchTime: '',
      gameEarliestMatchTime: '',
      gameRundownMatchTime: '',
      gameSportspageMatchTime: '',
    },
  },
];

export function contestCase(id: string): ContestStartTimeCase {
  const found = CONTEST_START_TIME_MATRIX.find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(`no contest start-time fixture named ${JSON.stringify(id)}`);
  }
  return found;
}

/**
 * The rows `GET /v1/contests` can serve. The list query carries
 * `.not('start_time', 'is', null)`, so a row whose `chainStartTime` is the
 * sentinel reaches the detail, parent-context and stream surfaces but never a
 * listing.
 */
export function listableContestCases(): readonly ContestStartTimeCase[] {
  return CONTEST_START_TIME_MATRIX.filter((c) => c.served.chainStartTime !== '');
}

/**
 * The admitted inputs for one contest-shaped row, in the view's terms: a
 * non-sentinel value for each of the three unguarded inputs, plus each
 * provider snapshot that clears the one-hour freshness window below
 * `gameMatchTime`. With no games row the snapshot CASE compares against NULL
 * and yields NULL, so neither snapshot is admitted.
 */
function admittedContestInputs(
  row: ContestStartTimes,
  where: string,
): Array<{ field: string; iso: string }> {
  const admitted: Array<{ field: string; iso: string }> = [];
  for (const field of ['chainStartTime', 'gameMatchTime', 'gameEarliestMatchTime'] as const) {
    if (row[field] !== '') admitted.push({ field, iso: row[field] });
  }
  for (const field of CONTEST_SNAPSHOT_FIELDS) {
    const iso = row[field];
    if (iso === '' || row.gameMatchTime === '') continue;
    const floor = instantMs(row.gameMatchTime, `${where}.gameMatchTime`) - SNAPSHOT_FRESHNESS_MS;
    if (instantMs(iso, `${where}.${field}`) >= floor) admitted.push({ field, iso });
  }
  return admitted;
}

function minimumOf(
  admitted: Array<{ field: string; iso: string }>,
  where: string,
): { field: string; iso: string } {
  let best = admitted[0]!;
  for (const candidate of admitted) {
    if (instantMs(candidate.iso, where) < instantMs(best.iso, where)) best = candidate;
  }
  return best;
}

/**
 * `matchTime` equals the minimum of the row's admitted inputs — the property
 * a LEAST guarantees and the one the previous fixtures broke. Throws naming
 * the row, the value it found and the value the view would have served.
 */
export function expectWireValidContestStartTimes(row: ContestStartTimes, where: string): void {
  const admitted = admittedContestInputs(row, where);
  if (admitted.length === 0) {
    if (row.matchTime !== '') {
      throw new Error(
        `${where}: every input is the "" sentinel, so effective_start_time is NULL and ` +
          `matchTime is "" — found ${JSON.stringify(row.matchTime)}`,
      );
    }
    return;
  }
  const best = minimumOf(admitted, where);
  if (row.matchTime !== best.iso) {
    throw new Error(
      `${where}: matchTime ${JSON.stringify(row.matchTime)} is not the bounded minimum of its ` +
        `admitted inputs. core-api serves a LEAST, which equals one of its members; the ` +
        `minimum here is ${JSON.stringify(best.iso)} (${best.field}). Admitted: ` +
        admitted.map((a) => `${a.field}=${a.iso}`).join(', '),
    );
  }
}

/**
 * Within one row, no two non-sentinel INPUTS share a value, so a swap between
 * any two of them reddens on this row alone. `matchTime` is excluded — it must
 * tie whichever input drives it.
 */
export function expectContestStartTimeInputsDistinct(row: ContestStartTimes, where: string): void {
  const seen = new Map<string, string>();
  for (const field of CONTEST_INPUT_FIELDS) {
    const value = row[field];
    if (value === '') continue;
    const prior = seen.get(value);
    if (prior !== undefined) {
      throw new Error(
        `${where}: ${prior} and ${field} share the literal ${JSON.stringify(value)}, so a swap ` +
          'between them is invisible in this row',
      );
    }
    seen.set(value, field);
  }
}

/**
 * Every game-derived companion is the `""` sentinel — the shape that makes an
 * unlinked row's `matchTime === chainStartTime` legitimate rather than a
 * collapsed fixture. `chainStartTime` is contest-derived and stays populated.
 */
export function expectUnlinkedGameStartTimes(row: ContestStartTimes, where: string): void {
  const game = {
    gameMatchTime: row.gameMatchTime,
    gameEarliestMatchTime: row.gameEarliestMatchTime,
    gameRundownMatchTime: row.gameRundownMatchTime,
    gameSportspageMatchTime: row.gameSportspageMatchTime,
  };
  const populated = Object.entries(game).filter(([, v]) => v !== '');
  if (populated.length > 0) {
    throw new Error(
      `${where}: with no games row every game-derived companion is "", but ` +
        populated.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') +
        ' is populated',
    );
  }
}

/**
 * The named snapshot sits more than an hour below `gameMatchTime` (so the
 * view's CASE excludes it) AND `matchTime` is strictly above it (so the
 * exclusion is what this row demonstrates, not a coincidence of ordering).
 * Both halves are needed: an edit that pulled the snapshot back inside the
 * window, or one that made it the minimum anyway, would otherwise leave the
 * row looking like it still exercises staleness.
 */
export function expectStaleSnapshotExcluded(
  row: ContestStartTimes,
  field: (typeof CONTEST_SNAPSHOT_FIELDS)[number],
  where: string,
): void {
  const snapshot = instantMs(row[field], `${where}.${field}`);
  const feed = instantMs(row.gameMatchTime, `${where}.gameMatchTime`);
  if (snapshot >= feed - SNAPSHOT_FRESHNESS_MS) {
    throw new Error(
      `${where}: ${field} is within an hour below gameMatchTime, so it is FRESH and this row ` +
        'does not exercise the stale-snapshot exclusion',
    );
  }
  if (instantMs(row.matchTime, `${where}.matchTime`) <= snapshot) {
    throw new Error(
      `${where}: matchTime is at or below the stale ${field}, so the row cannot show that the ` +
        'stale snapshot was excluded from the minimum',
    );
  }
}

/**
 * The named snapshot is inside the freshness window AND is the served
 * minimum — the accepting half of the pair above, so neither passes on a
 * matrix broken to make every snapshot stale or every snapshot the driver.
 */
export function expectFreshSnapshotDrivesMin(
  row: ContestStartTimes,
  field: (typeof CONTEST_SNAPSHOT_FIELDS)[number],
  where: string,
): void {
  const snapshot = instantMs(row[field], `${where}.${field}`);
  const feed = instantMs(row.gameMatchTime, `${where}.gameMatchTime`);
  if (snapshot < feed - SNAPSHOT_FRESHNESS_MS) {
    throw new Error(`${where}: ${field} is stale, so the view would exclude it from the minimum`);
  }
  if (row.matchTime !== row[field]) {
    throw new Error(
      `${where}: matchTime ${JSON.stringify(row.matchTime)} does not equal the fresh ${field} ` +
        `${JSON.stringify(row[field])}, so this row does not show an admitted snapshot driving ` +
        'the bound',
    );
  }
}

// ── /v1/games ──────────────────────────────────────────────────────────────

/**
 * The games endpoint's own start-time set. Two differences from the contest
 * surfaces, and applying one surface's rule to the other is the mistake to
 * avoid: there is NO chain input (games rows precede any contest), and the
 * sentinel is `null` rather than `""` because this endpoint passes the column
 * through instead of coalescing it.
 */
export type GameStartTimes = {
  matchTime: string;
  gameMatchTime: string;
  earliestMatchTime: string | null;
  rundownMatchTime: string | null;
  sportspageMatchTime: string | null;
};

export interface GameStartTimeCase {
  readonly id: string;
  readonly why: string;
  readonly served: GameStartTimes;
}

export const GAME_START_TIME_FIELDS = [
  'matchTime',
  'gameMatchTime',
  'earliestMatchTime',
  'rundownMatchTime',
  'sportspageMatchTime',
] as const;

const GAME_INPUT_FIELDS = [
  'gameMatchTime',
  'earliestMatchTime',
  'rundownMatchTime',
  'sportspageMatchTime',
] as const;

const GAME_SNAPSHOT_FIELDS = ['rundownMatchTime', 'sportspageMatchTime'] as const;

export const GAME_START_TIME_MATRIX: readonly GameStartTimeCase[] = [
  {
    id: 'feed-value-drives-sportspage-absent',
    why:
      'no floor and no sportspage snapshot held; the raw feed value is the minimum ' +
      'and the one snapshot present sits above it',
    served: {
      matchTime: '2026-05-08T02:00:00Z',
      gameMatchTime: '2026-05-08T02:00:00Z',
      earliestMatchTime: null,
      rundownMatchTime: '2026-05-08T02:20:00Z',
      sportspageMatchTime: null,
    },
  },
  {
    id: 'fresh-sportspage-drives-rundown-absent',
    why:
      'the mirror of the row above — the null sits on the OTHER snapshot, and the ' +
      'fresh sportspage snapshot 20 minutes below the feed value is the minimum',
    served: {
      matchTime: '2026-05-08T02:40:00Z',
      gameMatchTime: '2026-05-08T03:00:00Z',
      earliestMatchTime: null,
      rundownMatchTime: null,
      sportspageMatchTime: '2026-05-08T02:40:00Z',
    },
  },
  {
    id: 'retained-floor-drives',
    why:
      'the retained floor is the minimum at 90 minutes below the feed value — the ' +
      'floor carries NO freshness guard, which is what distinguishes it from a ' +
      'snapshot at the same depth',
    served: {
      matchTime: '2026-05-08T04:30:00Z',
      gameMatchTime: '2026-05-08T06:00:00Z',
      earliestMatchTime: '2026-05-08T04:30:00Z',
      rundownMatchTime: '2026-05-08T05:20:00Z',
      sportspageMatchTime: '2026-05-08T06:40:00Z',
    },
  },
  {
    id: 'stale-rundown-excluded',
    why:
      'the rundown snapshot is 1h50m below the feed value — stale, excluded — so the ' +
      'fresh sportspage snapshot is the minimum despite a lower value being served',
    served: {
      matchTime: '2026-05-08T07:40:00Z',
      gameMatchTime: '2026-05-08T08:00:00Z',
      earliestMatchTime: '2026-05-08T07:55:00Z',
      rundownMatchTime: '2026-05-08T06:10:00Z',
      sportspageMatchTime: '2026-05-08T07:40:00Z',
    },
  },
  {
    id: 'fresh-rundown-drives',
    why: 'a fresh rundown snapshot 30 minutes below the feed value is the minimum',
    served: {
      matchTime: '2026-05-08T09:30:00Z',
      gameMatchTime: '2026-05-08T10:00:00Z',
      earliestMatchTime: '2026-05-08T09:55:00Z',
      rundownMatchTime: '2026-05-08T09:30:00Z',
      sportspageMatchTime: '2026-05-08T10:10:00Z',
    },
  },
];

export function gameCase(id: string): GameStartTimeCase {
  const found = GAME_START_TIME_MATRIX.find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(`no game start-time fixture named ${JSON.stringify(id)}`);
  }
  return found;
}

function admittedGameInputs(
  row: GameStartTimes,
  where: string,
): Array<{ field: string; iso: string }> {
  const admitted: Array<{ field: string; iso: string }> = [
    { field: 'gameMatchTime', iso: row.gameMatchTime },
  ];
  if (row.earliestMatchTime !== null) {
    admitted.push({ field: 'earliestMatchTime', iso: row.earliestMatchTime });
  }
  const floor = instantMs(row.gameMatchTime, `${where}.gameMatchTime`) - SNAPSHOT_FRESHNESS_MS;
  for (const field of GAME_SNAPSHOT_FIELDS) {
    const iso = row[field];
    if (iso === null) continue;
    if (instantMs(iso, `${where}.${field}`) >= floor) admitted.push({ field, iso });
  }
  return admitted;
}

/**
 * The games surface's own version of the wire-validity rule, over its own
 * (chain-less) input set. `/v1/games.matchTime` is `effectiveMatchTime(...)`,
 * which returns the winning input's string verbatim.
 */
export function expectWireValidGameStartTimes(row: GameStartTimes, where: string): void {
  const best = minimumOf(admittedGameInputs(row, where), where);
  if (row.matchTime !== best.iso) {
    throw new Error(
      `${where}: matchTime ${JSON.stringify(row.matchTime)} is not the minimum of its admitted ` +
        `inputs; expected ${JSON.stringify(best.iso)} (${best.field})`,
    );
  }
}

export function expectGameStartTimeInputsDistinct(row: GameStartTimes, where: string): void {
  const seen = new Map<string, string>();
  for (const field of GAME_INPUT_FIELDS) {
    const value = row[field];
    if (value === null) continue;
    const prior = seen.get(value);
    if (prior !== undefined) {
      throw new Error(
        `${where}: ${prior} and ${field} share the literal ${JSON.stringify(value)}, so a swap ` +
          'between them is invisible in this row',
      );
    }
    seen.set(value, field);
  }
}

export function expectStaleGameSnapshotExcluded(
  row: GameStartTimes,
  field: (typeof GAME_SNAPSHOT_FIELDS)[number],
  where: string,
): void {
  const iso = row[field];
  if (iso === null) throw new Error(`${where}: ${field} is null, so there is no snapshot to age`);
  const snapshot = instantMs(iso, `${where}.${field}`);
  const feed = instantMs(row.gameMatchTime, `${where}.gameMatchTime`);
  if (snapshot >= feed - SNAPSHOT_FRESHNESS_MS) {
    throw new Error(
      `${where}: ${field} is within an hour below gameMatchTime, so it is FRESH and this row ` +
        'does not exercise the stale-snapshot exclusion',
    );
  }
  if (instantMs(row.matchTime, `${where}.matchTime`) <= snapshot) {
    throw new Error(
      `${where}: matchTime is at or below the stale ${field}, so the row cannot show that the ` +
        'stale snapshot was excluded from the minimum',
    );
  }
}

// ── the cross-row maintenance rule ─────────────────────────────────────────

/**
 * For every orderable pair of the named fields, at least one row carries
 * different values. This is what the matrix buys over a single fixture: no
 * pair is shared everywhere, so every same-typed positional swap dies in at
 * least one row.
 *
 * `null` compares as itself, so two absent snapshots in the same row do not
 * count as separated.
 */
export function expectMatrixSeparatesEveryPair<T extends Record<string, string | null>>(
  rows: readonly T[],
  fields: readonly (keyof T & string)[],
  where: string,
): void {
  const unseparated: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    for (let j = i + 1; j < fields.length; j += 1) {
      const a = fields[i]!;
      const b = fields[j]!;
      if (!rows.some((row) => row[a] !== row[b])) unseparated.push(`${a} / ${b}`);
    }
  }
  if (unseparated.length > 0) {
    throw new Error(
      `${where}: no row separates ${unseparated.join(', ')} — a swap between those fields is ` +
        'invisible across the whole matrix',
    );
  }
}
