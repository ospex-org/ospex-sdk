/**
 * Typed wrapper around the odds-snapshot endpoint on core-api:
 *
 *   - `GET /v1/contests/:contestId/odds`
 *
 * One-shot read of the latest reference odds for the contest's upstream
 * game. Distinct from `client.odds.subscribe(...)` (the live SSE stream)
 * — the snapshot is for "what are the odds right now?", the subscribe is
 * for "tell me when they change."
 *
 * The endpoint resolves the contest's upstream game server-side so
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
import { mapMoneyline, mapSpread, mapTotal } from './oddsMappers.js';
import type { ContestOddsSnapshot } from '../types/odds.js';
import type { ContestOddsBody } from './types.js';

export class OddsApi {
  constructor(private readonly client: ApiClient) {}

  async snapshot(contestId: string): Promise<ContestOddsSnapshot> {
    const body = await this.client.request<ContestOddsBody>(
      `/v1/contests/${encodeURIComponent(contestId)}/odds`,
    );
    return {
      contestId: body.contestId,
      odds: {
        moneyline: body.odds.moneyline ? mapMoneyline(body.odds.moneyline) : null,
        spread: body.odds.spread ? mapSpread(body.odds.spread) : null,
        total: body.odds.total ? mapTotal(body.odds.total) : null,
      },
    };
  }
}
