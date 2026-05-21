/**
 * Fills namespace — `client.fills`. The only append-only, event-like protocol
 * stream: there is no current-state read for a fill log, so `subscribe` has no
 * snapshot. Each fill records both sides of a matched commitment.
 */

import type { ApiClient } from '../api/client.js';
import type { Fill } from '../types/fill.js';
import type { Subscription } from '../types/odds.js';
import type { FillsSubscribeFilters, StreamSubscribeHandlers } from '../types/stream.js';
import { subscribeToStream } from '../realtime/stream.js';
import { decodeFill } from '../realtime/decoders.js';
import { assertAddress, assertHash } from '../realtime/filters.js';

export class Fills {
  constructor(private readonly api: ApiClient) {}

  /**
   * Subscribe to live fill events (SSE). Fills are append-only: apply every
   * `onDelta` and dedupe by `(txHash, logIndex)`. There is no snapshot — the
   * subscription streams from connect, so `onSnapshot` never fires. Filter by
   * `maker` / `taker` / `speculationId` / `contestId` / `commitmentHash`.
   */
  async subscribe(
    filters: FillsSubscribeFilters,
    handlers: StreamSubscribeHandlers<Fill>,
  ): Promise<Subscription> {
    assertAddress(filters.maker, 'maker');
    assertAddress(filters.taker, 'taker');
    assertHash(filters.commitmentHash, 'commitmentHash');
    return subscribeToStream<Fill>({
      api: this.api,
      resource: 'fills',
      filters: {
        maker: filters.maker,
        taker: filters.taker,
        speculationId: filters.speculationId,
        contestId: filters.contestId,
        commitmentHash: filters.commitmentHash,
      },
      decode: decodeFill,
      handlers,
    });
  }
}
