/**
 * Public types for the Ospex protocol SSE streams
 * (`client.{commitments,positions,fills,speculations,contests}.subscribe`).
 *
 * The transport itself lives in `src/realtime/stream.ts`; these are the
 * consumer-facing shapes. The streams are an Ospex-shaped push surface owned
 * by `ospex-core-api` — agents subscribe here, never to raw Supabase Realtime.
 */

import type { OspexStreamError } from '../errors.js';

/**
 * Connection lifecycle, reported via `onStatus`.
 *
 *   connected    — caught up and live; the deltas you receive reflect current
 *                  DB state. Emitted on a clean handoff (after the initial
 *                  snapshot, or after a cursor reconnect's catch-up completes).
 *   reconnecting — the connection dropped (or the first connect is still in
 *                  flight) and the transport is retrying with backoff. Live
 *                  delivery is paused until the next `connected`.
 *   resync       — the server forced a re-snapshot (a backlog too large to
 *                  replay, an upstream reorg/backfill, or a cursor handoff that
 *                  raced concurrent writes), or a stored cursor was rejected.
 *                  The transport discards stream state, re-snapshots from REST,
 *                  and reconnects without a cursor; a fresh `onSnapshot`
 *                  (where supported) and `connected` follow on success.
 */
export type StreamStatus = 'connected' | 'reconnecting' | 'resync';

/**
 * Handlers for a protocol stream subscription. `T` is the resource's delta
 * type (`Commitment`, `Position`, `Speculation`, `ContestUpdate`, or `Fill`).
 */
export interface StreamSubscribeHandlers<T> {
  /**
   * The initial REST snapshot of current state, delivered once before the live
   * deltas that follow it — and again after every `resync`. Omit if you only
   * want live deltas.
   *
   * Not every subscription produces a snapshot: `fills` is append-only (no
   * current-state snapshot), and `positions` / `contests` snapshot only when
   * scoped to a current-state endpoint (a `positions` `address` filter, a
   * `contests` `contestId` filter). When no snapshot is available the
   * subscription streams from connect and `onSnapshot` never fires.
   */
  onSnapshot?: (rows: T[]) => void;
  /**
   * A live or catch-up delta — one row at its latest observed state.
   *
   * Apply **last-received-wins per natural key**: the cursor is an opaque
   * resume token, NOT an ordering key (a row committed late can carry an older
   * cursor while being current), so process deltas in arrival order and
   * overwrite per natural key. Natural keys: commitments → `commitmentHash`,
   * speculations → `speculationId`, contests → `contestId`, positions →
   * `(speculationId, userAddress, positionType)`, fills → `(txHash, logIndex)`.
   * `fills` is append-only — apply every event, dedupe by `(txHash, logIndex)`.
   */
  onDelta: (row: T) => void;
  /** Connection lifecycle transitions. */
  onStatus?: (status: StreamStatus) => void;
  /**
   * Transport errors. `OspexStreamError.reason` discriminates retry
   * (`connection_failed` / `capacity_exceeded` — the transport keeps
   * reconnecting; this fires for observability) from stop (`fatal` — the
   * subscription has ended). If omitted, errors are swallowed.
   */
  onError?: (err: OspexStreamError) => void;
}

/** Identity/scope filters for `client.commitments.subscribe`. */
export interface CommitmentsSubscribeFilters {
  maker?: string;
  contestId?: string | number;
  scorer?: string;
}

/** Identity/scope filters for `client.positions.subscribe`. */
export interface PositionsSubscribeFilters {
  address?: string;
  speculationId?: string | number;
}

/** Identity/scope filters for `client.fills.subscribe`. */
export interface FillsSubscribeFilters {
  maker?: string;
  taker?: string;
  speculationId?: string | number;
  contestId?: string | number;
  commitmentHash?: string;
}

/** Identity/scope filters for `client.speculations.subscribe`. */
export interface SpeculationsSubscribeFilters {
  contestId?: string | number;
}

/** Identity/scope filters for `client.contests.subscribe`. */
export interface ContestsSubscribeFilters {
  contestId?: string | number;
}
