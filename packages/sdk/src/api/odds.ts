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
 * round-trip. Per-market entries use market-specific shapes (see
 * `MoneylineOdds`, `SpreadOdds`, `TotalOdds`) — the wire format does
 * not share a generic envelope across markets, so callers can't
 * misread spread side direction or total over/under naming.
 *
 * Source labelling: these are upstream market reference odds, not
 * Ospex liquidity. SDK consumers surfacing this to users should label
 * it that way.
 */

import type { ApiClient } from './client.js';
import type {
  ContestOddsSnapshot,
  MoneylineOdds,
  SpreadOdds,
  TotalOdds,
} from '../types/odds.js';
import type {
  ContestOddsBody,
  MoneylineOddsBody,
  SpreadOddsBody,
  TotalOddsBody,
} from './types.js';

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
        moneyline: body.odds.moneyline ? toMoneyline(body.odds.moneyline) : null,
        spread: body.odds.spread ? toSpread(body.odds.spread) : null,
        total: body.odds.total ? toTotal(body.odds.total) : null,
      },
    };
  }
}

function toMoneyline(body: MoneylineOddsBody): MoneylineOdds {
  return {
    market: 'moneyline',
    awayOddsAmerican: body.awayOddsAmerican,
    homeOddsAmerican: body.homeOddsAmerican,
    upstreamLastUpdated: body.upstreamLastUpdated,
    pollCapturedAt: body.pollCapturedAt,
    changedAt: body.changedAt,
  };
}

function toSpread(body: SpreadOddsBody): SpreadOdds {
  return {
    market: 'spread',
    awayLine: body.awayLine,
    homeLine: body.homeLine,
    awayOddsAmerican: body.awayOddsAmerican,
    homeOddsAmerican: body.homeOddsAmerican,
    upstreamLastUpdated: body.upstreamLastUpdated,
    pollCapturedAt: body.pollCapturedAt,
    changedAt: body.changedAt,
  };
}

function toTotal(body: TotalOddsBody): TotalOdds {
  return {
    market: 'total',
    line: body.line,
    overOddsAmerican: body.overOddsAmerican,
    underOddsAmerican: body.underOddsAmerican,
    upstreamLastUpdated: body.upstreamLastUpdated,
    pollCapturedAt: body.pollCapturedAt,
    changedAt: body.changedAt,
  };
}
