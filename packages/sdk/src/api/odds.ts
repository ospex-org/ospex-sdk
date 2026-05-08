/**
 * Typed wrapper around the odds-snapshot endpoint on core-api:
 *
 *   - `GET /v1/contests/:contestId/odds`
 *
 * One-shot read of the latest `current_odds` rows for the contest's
 * upstream game. Distinct from `client.odds.subscribe(...)` (Realtime
 * stream) — the snapshot is for "what are the odds right now?", the
 * subscribe is for "tell me when they change."
 *
 * The endpoint resolves the contest's `jsonoddsId` server-side so
 * consumers can stay in contest-id vocabulary without an extra
 * round-trip. Markets the writer hasn't populated come back as `null`
 * so consumers always see the same `{ moneyline, spread, total }` shape.
 *
 * Source labelling: these are upstream reference odds (JSONOdds /
 * Sportspage via `ospex-writer`), not Ospex liquidity. SDK consumers
 * surfacing this to users should label it that way — see
 * `packages/cli/src/commands/odds/show.ts` for the CLI's footnote.
 */

import type { ApiClient } from './client.js';
import type {
  ContestOddsSnapshot,
  OddsSnapshot,
  MarketType,
} from '../types/odds.js';
import type { Network } from '../types/protocol.js';
import type { ContestOddsBody, OddsSnapshotBody } from './types.js';

export class OddsApi {
  constructor(private readonly client: ApiClient) {}

  async snapshot(contestId: string): Promise<ContestOddsSnapshot> {
    const body = await this.client.request<ContestOddsBody>(
      `/v1/contests/${encodeURIComponent(contestId)}/odds`,
    );
    return {
      contestId: body.contestId,
      jsonoddsId: body.jsonoddsId,
      odds: {
        moneyline: body.odds.moneyline ? toSnapshot(body.odds.moneyline) : null,
        spread: body.odds.spread ? toSnapshot(body.odds.spread) : null,
        total: body.odds.total ? toSnapshot(body.odds.total) : null,
      },
    };
  }
}

function toSnapshot(body: OddsSnapshotBody): OddsSnapshot {
  return {
    jsonoddsId: body.jsonoddsId,
    market: body.market as MarketType,
    network: body.network as Network,
    line: body.line,
    awayOddsAmerican: body.awayOddsAmerican,
    homeOddsAmerican: body.homeOddsAmerican,
    upstreamLastUpdated: body.upstreamLastUpdated,
    pollCapturedAt: body.pollCapturedAt,
    changedAt: body.changedAt,
  };
}
